import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceRecord, UserQuota, UserRecord, UserRole } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";

export const DEFAULT_QUOTAS: Readonly<Record<UserRole, UserQuota>> = {
  administrator: { maxRequestsPerMinute: 120, maxPromptChars: 1_000_000, maxOutputTokens: 100_000, maxQueueDepth: 100 },
  agent: { maxRequestsPerMinute: 60, maxPromptChars: 500_000, maxOutputTokens: 32_768, maxQueueDepth: 20 },
  consumer: { maxRequestsPerMinute: 20, maxPromptChars: 100_000, maxOutputTokens: 8_192, maxQueueDepth: 5 },
};

export interface AuthenticatedPrincipal { user: UserRecord; device: DeviceRecord; routeGrants: readonly string[]; quota: UserQuota }

export class SecurityService {
  readonly #requests = new Map<string, number[]>();
  constructor(private readonly store: SqliteStore, private readonly pepper: string) { if (!pepper) throw new Error("Authentication pepper must not be empty"); }

  createUser(displayName: string, role: UserRole = "consumer"): UserRecord {
    const now = new Date().toISOString();
    const user: UserRecord = { id: randomUUID(), displayName, role, status: "active", createdAt: now, updatedAt: now };
    this.store.createUser(user); return user;
  }
  updateUser(id: string, update: Partial<Pick<UserRecord, "displayName" | "role" | "status">>): UserRecord {
    const current = this.requireUser(id); const user = { ...current, ...update, updatedAt: new Date().toISOString() }; this.store.updateUser(user); return user;
  }
  issueDevice(userId: string, name: string, token?: string): { device: DeviceRecord; token: string } {
    this.requireUser(userId); const raw = token ?? `fitz_${randomBytes(32).toString("base64url")}`; const device: DeviceRecord = { id: randomUUID(), userId, name, createdAt: new Date().toISOString() };
    this.store.createDevice(device, this.hash(raw)); return { device, token: raw };
  }
  authenticate(header: string | string[] | undefined): AuthenticatedPrincipal | undefined {
    const token = bearer(header); if (!token) return undefined;
    const record = this.store.findDeviceByTokenHash(this.hash(token)); if (!record || record.revokedAt || record.user.status !== "active") return undefined;
    this.store.touchDevice(record.id, new Date().toISOString());
    const { tokenHash: _tokenHash, user, ...device } = record;
    return { user, device, routeGrants: this.store.listUserRouteGrants(user.id), quota: this.store.getUserQuota(user.id) ?? DEFAULT_QUOTAS[user.role] };
  }
  authorizeRoute(principal: AuthenticatedPrincipal, routeId: string): boolean { return principal.user.role === "administrator" || principal.routeGrants.includes(routeId); }
  enforceQuota(principal: AuthenticatedPrincipal, promptChars: number, outputTokens: number, queueDepth: number): void {
    const q = principal.quota;
    if (promptChars > q.maxPromptChars) throw new SecurityPolicyError("Prompt quota exceeded");
    if (outputTokens > q.maxOutputTokens) throw new SecurityPolicyError("Output-token quota exceeded");
    if (queueDepth >= q.maxQueueDepth) throw new SecurityPolicyError("Queue-depth quota exceeded");
    const cutoff = Date.now() - 60_000; const recent = (this.#requests.get(principal.user.id) ?? []).filter((time) => time > cutoff);
    if (recent.length >= q.maxRequestsPerMinute) throw new SecurityPolicyError("Request-rate quota exceeded");
    recent.push(Date.now()); this.#requests.set(principal.user.id, recent);
  }
  setRouteGrants(userId: string, routeIds: readonly string[]): void { this.requireUser(userId); this.store.replaceUserRouteGrants(userId, routeIds); }
  setQuota(userId: string, quota: UserQuota): void { this.requireUser(userId); validateQuota(quota); this.store.setUserQuota(userId, quota); }
  audit(action: string, actorUserId?: string, targetType?: string, targetId?: string, detail: Record<string, unknown> = {}): void { this.store.appendAuditEvent({ id: randomUUID(), timestamp: new Date().toISOString(), action, detail, ...(actorUserId ? { actorUserId } : {}), ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) }); }
  hash(value: string): string { return createHmac("sha256", this.pepper).update(value).digest("hex"); }
  matches(value: string, hash: string): boolean { const actual = Buffer.from(this.hash(value), "hex"); const expected = Buffer.from(hash, "hex"); return actual.length === expected.length && timingSafeEqual(actual, expected); }
  private requireUser(id: string): UserRecord { const user = this.store.getUser(id); if (!user) throw new SecurityPolicyError(`User not found: ${id}`); return user; }
}

export class SecurityPolicyError extends Error {}
function bearer(value: string | string[] | undefined): string | undefined { if (typeof value !== "string") return undefined; const match = /^Bearer\s+(.+)$/i.exec(value); return match?.[1]; }
function validateQuota(quota: UserQuota): void { for (const value of Object.values(quota)) if (!Number.isInteger(value) || value < 1) throw new SecurityPolicyError("Quota values must be positive integers"); }
