import type { DatabaseSync } from "node:sqlite";
import type {
  AuditEventRecord,
  DeviceAuthenticationRecord,
  DeviceRecord,
  ToolApprovalRecord,
  ToolPolicyRecord,
  UserQuota,
  UserRecord,
} from "@fitz/protocol";

interface UserRow { id: string; display_name: string; role: UserRecord["role"]; status: UserRecord["status"]; created_at: string; updated_at: string }
interface DeviceRow { id: string; user_id: string; name: string; token_hash: string; created_at: string; last_used_at: string | null }
interface AuditRow { id: string; timestamp: string; actor_user_id: string | null; action: string; target_type: string | null; target_id: string | null; detail_json: string }
interface ToolPolicyRow { subject_type: ToolPolicyRecord["subjectType"]; subject_id: string; tool_name: string; decision: ToolPolicyRecord["decision"]; updated_at: string }
interface ToolApprovalRow { id: string; session_id: string; run_id: string | null; tool_call_id: string; tool_name: string; status: ToolApprovalRecord["status"]; request_json: string; requested_at: string; resolved_at: string | null; decided_by_user_id: string | null; note: string | null }

/** Identity, access-control, audit, and approval persistence. */
export class SqliteIdentityStore {
  constructor(private readonly database: DatabaseSync) {}

  createUser(user: UserRecord): void { this.database.prepare(`INSERT INTO users (id, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, user.displayName, user.role, user.status, user.createdAt, user.updatedAt); }
  updateUser(user: UserRecord): void { this.database.prepare(`UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?`).run(user.displayName, user.role, user.status, user.updatedAt, user.id); }
  getUser(id: string): UserRecord | undefined { const row = this.database.prepare(`SELECT id, display_name, role, status, created_at, updated_at FROM users WHERE id = ?`).get(id) as UserRow | undefined; return row ? mapUser(row) : undefined; }
  listUsers(): UserRecord[] { return (this.database.prepare(`SELECT id, display_name, role, status, created_at, updated_at FROM users ORDER BY created_at`).all() as unknown as UserRow[]).map(mapUser); }

  createDevice(device: DeviceRecord, tokenHash: string): void { this.database.prepare(`INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`).run(device.id, device.userId, device.name, tokenHash, device.createdAt); }
  listDevices(userId: string): DeviceRecord[] { return (this.database.prepare(`SELECT id, user_id, name, token_hash, created_at, last_used_at FROM devices WHERE user_id = ? ORDER BY created_at`).all(userId) as unknown as DeviceRow[]).map(mapDevice); }
  findDeviceByTokenHash(tokenHash: string): DeviceAuthenticationRecord | undefined {
    const row = this.database.prepare(`SELECT d.id, d.user_id, d.name, d.token_hash, d.created_at, d.last_used_at, u.display_name, u.role, u.status, u.created_at AS user_created_at, u.updated_at AS user_updated_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`).get(tokenHash) as (DeviceRow & { display_name: string; role: UserRecord["role"]; status: UserRecord["status"]; user_created_at: string; user_updated_at: string }) | undefined;
    if (!row) return undefined;
    return { ...mapDevice(row), tokenHash: row.token_hash, user: { id: row.user_id, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.user_created_at, updatedAt: row.user_updated_at } };
  }
  touchDevice(id: string, timestamp: string): void { this.database.prepare(`UPDATE devices SET last_used_at = ? WHERE id = ?`).run(timestamp, id); }
  deleteDevice(id: string): boolean {
    if (!this.database.prepare(`SELECT 1 FROM devices WHERE id = ?`).get(id)) return false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`DELETE FROM request_usage WHERE owner_device_id = ?`).run(id);
      const deleted = Number(this.database.prepare(`DELETE FROM devices WHERE id = ?`).run(id).changes) > 0;
      this.database.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  replaceUserRouteGrants(userId: string, routeIds: readonly string[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`DELETE FROM user_route_grants WHERE user_id = ?`).run(userId);
      const insert = this.database.prepare(`INSERT INTO user_route_grants (user_id, route_id, created_at) VALUES (?, ?, ?)`);
      const now = new Date().toISOString();
      for (const routeId of new Set(routeIds)) insert.run(userId, routeId, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  listUserRouteGrants(userId: string): string[] { return (this.database.prepare(`SELECT route_id FROM user_route_grants WHERE user_id = ? ORDER BY route_id`).all(userId) as unknown as { route_id: string }[]).map((row) => row.route_id); }
  setUserQuota(userId: string, quota: UserQuota): void { this.database.prepare(`INSERT INTO user_quotas (user_id, quota_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET quota_json = excluded.quota_json, updated_at = excluded.updated_at`).run(userId, JSON.stringify(quota), new Date().toISOString()); }
  getUserQuota(userId: string): UserQuota | undefined { const row = this.database.prepare(`SELECT quota_json FROM user_quotas WHERE user_id = ?`).get(userId) as { quota_json: string } | undefined; return row ? JSON.parse(row.quota_json) as UserQuota : undefined; }

  appendAuditEvent(event: AuditEventRecord): void { this.database.prepare(`INSERT INTO audit_events (id, timestamp, actor_user_id, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.id, event.timestamp, event.actorUserId ?? null, event.action, event.targetType ?? null, event.targetId ?? null, JSON.stringify(event.detail)); }
  listAuditEvents(limit = 100): AuditEventRecord[] {
    const rows = this.database.prepare(`SELECT id, timestamp, actor_user_id, action, target_type, target_id, detail_json FROM audit_events ORDER BY timestamp DESC LIMIT ?`).all(limit) as unknown as AuditRow[];
    return rows.map((row) => ({ id: row.id, timestamp: row.timestamp, action: row.action, detail: JSON.parse(row.detail_json) as Record<string, unknown>, ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}), ...(row.target_type ? { targetType: row.target_type } : {}), ...(row.target_id ? { targetId: row.target_id } : {}) }));
  }
  upsertToolPolicy(policy: ToolPolicyRecord): void { this.database.prepare(`INSERT INTO tool_policies (subject_type, subject_id, tool_name, decision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject_type, subject_id, tool_name) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`).run(policy.subjectType, policy.subjectId, policy.toolName, policy.decision, policy.updatedAt); }
  listToolPolicies(subjectType?: ToolPolicyRecord["subjectType"], subjectId?: string): ToolPolicyRecord[] { const rows = (subjectType && subjectId ? this.database.prepare(`SELECT subject_type, subject_id, tool_name, decision, updated_at FROM tool_policies WHERE subject_type = ? AND subject_id = ? ORDER BY tool_name`).all(subjectType, subjectId) : this.database.prepare(`SELECT subject_type, subject_id, tool_name, decision, updated_at FROM tool_policies ORDER BY subject_type, subject_id, tool_name`).all()) as unknown as ToolPolicyRow[]; return rows.map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id, toolName: row.tool_name, decision: row.decision, updatedAt: row.updated_at })); }
  resolveToolPolicy(userId: string | undefined, role: UserRecord["role"] | undefined, toolName: string): ToolPolicyRecord["decision"] { if (userId) { const row = this.database.prepare(`SELECT decision FROM tool_policies WHERE subject_type = 'user' AND subject_id = ? AND tool_name = ?`).get(userId, toolName) as { decision: ToolPolicyRecord["decision"] } | undefined; if (row) return row.decision; } if (role) { const row = this.database.prepare(`SELECT decision FROM tool_policies WHERE subject_type = 'role' AND subject_id = ? AND tool_name = ?`).get(role, toolName) as { decision: ToolPolicyRecord["decision"] } | undefined; if (row) return row.decision; } return "ask"; }

  createToolApproval(approval: ToolApprovalRecord): void { this.database.prepare(`INSERT INTO tool_approvals (id, session_id, run_id, tool_call_id, tool_name, status, request_json, requested_at, resolved_at, decided_by_user_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(approval.id, approval.sessionId, approval.runId ?? null, approval.toolCallId, approval.toolName, approval.status, JSON.stringify(approval.request), approval.requestedAt, approval.resolvedAt ?? null, approval.decidedByUserId ?? null, approval.note ?? null); }
  getToolApproval(id: string): ToolApprovalRecord | undefined { const row = this.database.prepare(`SELECT id, session_id, run_id, tool_call_id, tool_name, status, request_json, requested_at, resolved_at, decided_by_user_id, note FROM tool_approvals WHERE id = ?`).get(id) as ToolApprovalRow | undefined; return row ? mapApproval(row) : undefined; }
  listToolApprovals(sessionId?: string, status?: ToolApprovalRecord["status"]): ToolApprovalRecord[] { let rows; if (sessionId && status) rows = this.database.prepare(`SELECT * FROM tool_approvals WHERE session_id = ? AND status = ? ORDER BY requested_at`).all(sessionId, status); else if (sessionId) rows = this.database.prepare(`SELECT * FROM tool_approvals WHERE session_id = ? ORDER BY requested_at`).all(sessionId); else if (status) rows = this.database.prepare(`SELECT * FROM tool_approvals WHERE status = ? ORDER BY requested_at`).all(status); else rows = this.database.prepare(`SELECT * FROM tool_approvals ORDER BY requested_at`).all(); return (rows as unknown as ToolApprovalRow[]).map(mapApproval); }
  resolveToolApproval(id: string, status: "approved" | "denied", decidedByUserId?: string, note?: string, request?: Readonly<Record<string, unknown>>): boolean { return Number(this.database.prepare(`UPDATE tool_approvals SET status = ?, request_json = COALESCE(?, request_json), resolved_at = ?, decided_by_user_id = ?, note = ? WHERE id = ? AND status = 'pending'`).run(status, request ? JSON.stringify(request) : null, new Date().toISOString(), decidedByUserId ?? null, note ?? null, id).changes) > 0; }
  cancelToolApproval(id: string, note?: string): boolean { return Number(this.database.prepare(`UPDATE tool_approvals SET status = 'cancelled', resolved_at = ?, note = ? WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), note ?? null, id).changes) > 0; }
  recoverInterruptedToolApprovals(): number { const now = new Date().toISOString(); return Number(this.database.prepare(`UPDATE tool_approvals SET status = 'cancelled', resolved_at = ?, note = 'host_restarted' WHERE status = 'pending'`).run(now).changes); }
}

function mapUser(row: UserRow): UserRecord { return { id: row.id, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapDevice(row: DeviceRow): DeviceRecord { return { id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}) }; }
function mapApproval(row: ToolApprovalRow): ToolApprovalRecord { return { id: row.id, sessionId: row.session_id, toolCallId: row.tool_call_id, toolName: row.tool_name, status: row.status, request: JSON.parse(row.request_json) as Record<string, unknown>, requestedAt: row.requested_at, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}), ...(row.decided_by_user_id ? { decidedByUserId: row.decided_by_user_id } : {}), ...(row.note ? { note: row.note } : {}) }; }
