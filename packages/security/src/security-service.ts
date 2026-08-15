import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceRecord, MediaModality, MediaQuota, UserQuota, UserRecord, UserRole } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";

export const DEFAULT_QUOTAS: Readonly<Record<UserRole, UserQuota>> = {
  administrator: {
    maxRequestsPerMinute: 120,
    maxPromptChars: 1_000_000,
    maxOutputTokens: 100_000,
    maxQueueDepth: 100,
    media: { maxJobsPerWindow: 20, windowHours: 24, maxConcurrentJobs: 1 },
  },
  agent: { maxRequestsPerMinute: 60, maxPromptChars: 500_000, maxOutputTokens: 32_768, maxQueueDepth: 20 },
  consumer: { maxRequestsPerMinute: 20, maxPromptChars: 100_000, maxOutputTokens: 8_192, maxQueueDepth: 5 },
};

export interface AuthenticatedPrincipal { user: UserRecord; device?: DeviceRecord; routeGrants: readonly string[]; quota: UserQuota }

export class SecurityService {
  readonly #requests = new Map<string, number[]>();
  constructor(private readonly store: SqliteStore, private readonly pepper: string) { if (!pepper) throw new Error("Authentication pepper must not be empty"); }

  createUser(displayName: string, role: UserRole = "consumer"): UserRecord {
    if (!isUserRole(role)) throw new SecurityPolicyError("Invalid user role");
    const now = new Date().toISOString();
    const user: UserRecord = { id: randomUUID(), displayName: normalizeName(displayName, "Display name"), role, status: "active", createdAt: now, updatedAt: now };
    this.store.createUser(user); return user;
  }
  updateUser(id: string, update: Partial<Pick<UserRecord, "displayName" | "role" | "status">>): UserRecord {
    if (update.role !== undefined && !isUserRole(update.role)) throw new SecurityPolicyError("Invalid user role");
    if (update.status !== undefined && update.status !== "active" && update.status !== "disabled") throw new SecurityPolicyError("Invalid user status");
    const normalized = { ...update, ...(update.displayName !== undefined ? { displayName: normalizeName(update.displayName, "Display name") } : {}) };
    const current = this.requireUser(id); const user = { ...current, ...normalized, updatedAt: new Date().toISOString() }; this.store.updateUser(user); return user;
  }
  issueDevice(userId: string, name: string, token?: string): { device: DeviceRecord; token: string } {
    this.requireUser(userId); const raw = token ?? `fitz_${randomBytes(32).toString("base64url")}`; const device: DeviceRecord = { id: randomUUID(), userId, name: normalizeName(name, "Device name"), createdAt: new Date().toISOString() };
    this.store.createDevice(device, this.hash(raw)); return { device, token: raw };
  }
  authenticate(header: string | string[] | undefined): AuthenticatedPrincipal | undefined {
    const token = bearer(header); if (!token) return undefined;
    const record = this.store.findDeviceByTokenHash(this.hash(token)); if (!record || record.revokedAt || record.user.status !== "active") return undefined;
    this.store.touchDevice(record.id, new Date().toISOString());
    const { tokenHash: _tokenHash, user, ...device } = record;
    return { user, device, routeGrants: this.store.listUserRouteGrants(user.id), quota: this.store.getUserQuota(user.id) ?? DEFAULT_QUOTAS[user.role] };
  }
  /** Text roles are product capabilities, not host-model ACLs. Smart and Fast
   * still resolve only to the authenticated user's own cloud connections. */
  authorizeRoute(principal: AuthenticatedPrincipal, routeId: string): boolean {
    return routeId === "default"
      || routeId === "fast"
      || routeId === "smart"
      || principal.user.role === "administrator"
      || principal.routeGrants.includes(routeId);
  }
  enforceQuota(principal: AuthenticatedPrincipal, promptChars: number, outputTokens: number, queueDepth: number): void {
    const q = principal.quota;
    if (promptChars > q.maxPromptChars) throw new SecurityPolicyError("Prompt quota exceeded");
    if (outputTokens > q.maxOutputTokens) throw new SecurityPolicyError("Output-token quota exceeded");
    if (queueDepth >= q.maxQueueDepth) throw new SecurityPolicyError("Queue-depth quota exceeded");
    const cutoff = Date.now() - 60_000; const recent = (this.#requests.get(principal.user.id) ?? []).filter((time) => time > cutoff);
    if (recent.length >= q.maxRequestsPerMinute) throw new SecurityPolicyError("Request-rate quota exceeded");
    recent.push(Date.now()); this.#requests.set(principal.user.id, recent);
  }
  /** Builds a device-less principal for in-process callers (e.g. the agent-tool path),
   *  resolving the user + route grants + quota without a paired device. */
  principalForUser(userId: string): AuthenticatedPrincipal {
    const user = this.requireUser(userId);
    return { user, routeGrants: this.store.listUserRouteGrants(userId), quota: this.store.getUserQuota(userId) ?? DEFAULT_QUOTAS[user.role] };
  }
  /** Media generation is paid work (KD-7): a principal without a configured
   *  `quota.media` is denied at submit time (fail closed). */
  enforceMediaQuota(principal: AuthenticatedPrincipal, request: { modality: MediaModality; creditCostCents?: number }): void {
    const quota = principal.quota.media;
    if (!quota) throw new SecurityPolicyError("Media quota is not configured; contact an administrator");
    const since = new Date(Date.now() - quota.windowHours * 3_600_000).toISOString();
    const windowJobs = this.store.countNonTerminalMediaJobs(principal.user.id, since);
    if (windowJobs >= quota.maxJobsPerWindow) throw new SecurityPolicyError("Media job quota exceeded");
    if (this.store.countNonTerminalMediaJobs(principal.user.id, new Date(0).toISOString()) >= quota.maxConcurrentJobs) {
      throw new SecurityPolicyError("Media concurrent-job quota exceeded");
    }
    if (quota.creditBudgetCents !== undefined) {
      const spent = this.store.sumMediaLedgerForUser(principal.user.id, since);
      if (spent + (request.creditCostCents ?? 0) > quota.creditBudgetCents) throw new SecurityPolicyError("Media credit budget exceeded");
    }
  }
  /** Route grants now protect media/custom routes only. Text routing is fixed:
   * Default is universal while Smart and Fast are owner-scoped cloud roles. */
  setRouteGrants(userId: string, routeIds: readonly string[]): void {
    this.requireUser(userId);
    const textCapabilities = new Set(["default", "smart", "fast", "subagent"]);
    this.store.replaceUserRouteGrants(userId, [...new Set(routeIds.filter((routeId) => !textCapabilities.has(routeId)))]);
  }
  setQuota(userId: string, quota: UserQuota): void { this.requireUser(userId); validateQuota(quota); this.store.setUserQuota(userId, quota); }
  audit(action: string, actorUserId?: string, targetType?: string, targetId?: string, detail: Record<string, unknown> = {}): void { this.store.appendAuditEvent({ id: randomUUID(), timestamp: new Date().toISOString(), action, detail, ...(actorUserId ? { actorUserId } : {}), ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) }); }
  hash(value: string): string { return createHmac("sha256", this.pepper).update(value).digest("hex"); }
  matches(value: string, hash: string): boolean { const actual = Buffer.from(this.hash(value), "hex"); const expected = Buffer.from(hash, "hex"); return actual.length === expected.length && timingSafeEqual(actual, expected); }
  private requireUser(id: string): UserRecord { const user = this.store.getUser(id); if (!user) throw new SecurityPolicyError(`User not found: ${id}`); return user; }
}

export class SecurityPolicyError extends Error {}
function normalizeName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new SecurityPolicyError(`${label} must be between 1 and 100 characters`);
  return normalized;
}
function isUserRole(value: unknown): value is UserRole { return value === "administrator" || value === "agent" || value === "consumer"; }
function bearer(value: string | string[] | undefined): string | undefined { if (typeof value !== "string") return undefined; const match = /^Bearer\s+(.+)$/i.exec(value); return match?.[1]; }
function validateQuota(quota: UserQuota): void {
  for (const value of Object.values(quota)) {
    if (value && typeof value === "object") {
      validateMediaQuota(value as MediaQuota);
      continue;
    }
    if (!Number.isInteger(value) || value < 1) throw new SecurityPolicyError("Quota values must be positive integers");
  }
}
function validateMediaQuota(quota: MediaQuota): void {
  const positiveInteger = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 1;
  if (!positiveInteger(quota.maxJobsPerWindow)) throw new SecurityPolicyError("maxJobsPerWindow must be a positive integer");
  if (!positiveInteger(quota.windowHours)) throw new SecurityPolicyError("windowHours must be a positive integer");
  if (!positiveInteger(quota.maxConcurrentJobs)) throw new SecurityPolicyError("maxConcurrentJobs must be a positive integer");
  if (quota.creditBudgetCents !== undefined && (!Number.isInteger(quota.creditBudgetCents) || quota.creditBudgetCents < 0)) {
    throw new SecurityPolicyError("creditBudgetCents must be a non-negative integer");
  }
}
