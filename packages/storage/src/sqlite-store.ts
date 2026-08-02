import { DatabaseSync } from "node:sqlite";
import type {
  AuditEventRecord,
  AgentEventEnvelope,
  ArtifactRecord,
  AgentRunRecord,
  ProjectRecord,
  PairingCodeRecord,
  SessionRecord,
  ToolApprovalRecord,
  ToolPolicyRecord,
  TranscriptEntryRecord,
  DeviceAuthenticationRecord,
  DeviceRecord,
  InferenceLifecycleEvent,
  InferenceRequestRecord,
  QueueUpdatedEvent,
  EngineRegistration,
  Recipe,
  Route,
  UserQuota,
  UserRecord,
} from "@fitz/protocol";
import { MIGRATIONS } from "./migrations.js";

interface RecipeRow {
  recipe_json: string;
}

interface PlaybookRow {
  id: string;
  name: string;
  adapter: string;
  configuration_json: string;
  created_at: string;
  updated_at: string;
}

interface RouteRow {
  id: string;
  display_name: string;
  description: string | null;
  recipe_id: string;
  enabled: number;
  is_default: number;
}

interface EventRow {
  event_json: string;
}

interface InferenceRequestRow {
  id: string;
  route_id: string;
  status: InferenceRequestRecord["status"];
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
}

interface UserRow { id: string; display_name: string; role: UserRecord["role"]; status: UserRecord["status"]; created_at: string; updated_at: string }
interface DeviceRow { id: string; user_id: string; name: string; token_hash: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface AuditRow { id: string; timestamp: string; actor_user_id: string | null; action: string; target_type: string | null; target_id: string | null; detail_json: string }
interface AgentRunRow { id: string; route_id: string; owner_user_id: string | null; session_id: string | null; status: AgentRunRecord["status"]; created_at: string; updated_at: string; last_sequence: number; error: string | null }
interface ProjectRow { id: string; owner_user_id: string | null; name: string; root_path: string | null; created_at: string; updated_at: string }
interface SessionRow { id: string; project_id: string; owner_user_id: string | null; title: string; status: SessionRecord["status"]; connection_id: string; route_id: "fast" | "default" | "smart"; created_at: string; updated_at: string }
interface TranscriptRow { id: string; session_id: string; sequence: number; kind: TranscriptEntryRecord["kind"]; role: TranscriptEntryRecord["role"] | null; content_json: string; created_at: string }
interface ToolPolicyRow { subject_type: ToolPolicyRecord["subjectType"]; subject_id: string; tool_name: string; decision: ToolPolicyRecord["decision"]; updated_at: string }
interface ToolApprovalRow { id: string; session_id: string; run_id: string | null; tool_call_id: string; tool_name: string; status: ToolApprovalRecord["status"]; request_json: string; requested_at: string; resolved_at: string | null; decided_by_user_id: string | null; note: string | null }
interface ArtifactRow { id: string; session_id: string; name: string; mime_type: string; kind: ArtifactRecord["kind"]; byte_size: number; sha256: string; created_at: string; created_by_user_id: string | null; metadata_json: string }

export class SqliteStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  static memory(): SqliteStore {
    return new SqliteStore(":memory:");
  }

  migrate(): void {
    const current = this.#database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    let version = current?.user_version ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(migration.sql);
        this.#database.exec(`PRAGMA user_version = ${migration.version}`);
        this.#database.exec("COMMIT");
        version = migration.version;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  upsertRecipe(recipe: Recipe): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO recipes (
          id, playbook_id, display_name, adapter, model_id, context_tokens,
          recipe_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          playbook_id = excluded.playbook_id,
          display_name = excluded.display_name,
          adapter = excluded.adapter,
          model_id = excluded.model_id,
          context_tokens = excluded.context_tokens,
          recipe_json = excluded.recipe_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        recipe.id,
        recipe.playbookId,
        recipe.displayName,
        recipe.adapter,
        recipe.modelId,
        recipe.contextTokens,
        JSON.stringify(recipe),
        now,
        now,
      );
  }

  upsertEngine(engine: EngineRegistration): void {
    this.#database.prepare(
      `INSERT INTO playbooks (id, name, adapter, configuration_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         adapter = excluded.adapter,
         configuration_json = excluded.configuration_json,
         updated_at = excluded.updated_at`,
    ).run(
      engine.id,
      engine.displayName,
      "openai-compatible",
      JSON.stringify({
        folderName: engine.folderName,
        connectionMode: engine.connectionMode,
        runtime: engine.runtime,
        baseUrl: engine.baseUrl,
        healthPath: engine.healthPath,
        launchCommand: engine.launchCommand,
        launchArguments: engine.launchArguments,
        workingDirectory: engine.workingDirectory,
        wslDistribution: engine.wslDistribution,
      }),
      engine.createdAt,
      engine.updatedAt,
    );
  }

  getEngine(id: string): EngineRegistration | undefined {
    const row = this.#database.prepare(
      "SELECT id, name, adapter, configuration_json, created_at, updated_at FROM playbooks WHERE id = ?",
    ).get(id) as PlaybookRow | undefined;
    return row ? mapPlaybook(row) : undefined;
  }

  listEngines(): EngineRegistration[] {
    const rows = this.#database.prepare(
      "SELECT id, name, adapter, configuration_json, created_at, updated_at FROM playbooks ORDER BY name",
    ).all() as unknown as PlaybookRow[];
    return rows.map(mapPlaybook);
  }

  deleteEngine(id: string): boolean { return this.#database.prepare("DELETE FROM playbooks WHERE id = ?").run(id).changes > 0; }

  upsertRoute(route: Route): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO routes (
          id, display_name, description, recipe_id, enabled, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          description = excluded.description,
          recipe_id = excluded.recipe_id,
          enabled = excluded.enabled,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at`,
      )
      .run(
        route.id,
        route.displayName,
        route.description ?? null,
        route.recipeId,
        route.enabled ? 1 : 0,
        route.isDefault ? 1 : 0,
        now,
        now,
      );
  }

  deleteRoute(routeId: string): void {
    this.#database.prepare("DELETE FROM routes WHERE id = ?").run(routeId);
  }

  deleteRecipe(recipeId: string): void {
    this.#database.prepare("DELETE FROM recipes WHERE id = ?").run(recipeId);
  }

  listRecipes(): Recipe[] {
    const rows = this.#database
      .prepare("SELECT recipe_json FROM recipes ORDER BY id")
      .all() as unknown as RecipeRow[];
    return rows.map((row) => JSON.parse(row.recipe_json) as Recipe);
  }

  listRoutes(): Route[] {
    const rows = this.#database
      .prepare(
        `SELECT id, display_name, description, recipe_id, enabled, is_default
         FROM routes ORDER BY id`,
      )
      .all() as unknown as RouteRow[];
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      recipeId: row.recipe_id,
      enabled: row.enabled === 1,
      ...(row.description ? { description: row.description } : {}),
      ...(row.is_default === 1 ? { isDefault: true } : {}),
    }));
  }

  appendLifecycleEvent(event: InferenceLifecycleEvent): void {
    this.#database
      .prepare(
        `INSERT OR REPLACE INTO lifecycle_events (sequence, type, timestamp, event_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(event.sequence, event.type, event.timestamp, JSON.stringify(event));
  }

  lifecycleEventsAfter(sequence: number, limit = 500): InferenceLifecycleEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT event_json FROM lifecycle_events
         WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
      )
      .all(sequence, limit) as unknown as EventRow[];
    return rows.map((row) => JSON.parse(row.event_json) as InferenceLifecycleEvent);
  }

  latestLifecycleSequence(): number {
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM lifecycle_events")
      .get() as { sequence: number };
    return row.sequence;
  }

  recordQueueEvent(event: QueueUpdatedEvent): void {
    this.#database
      .prepare(
        `INSERT INTO inference_requests (id, route_id, status, enqueued_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(event.data.requestId, event.data.routeId, event.data.status, event.timestamp);

    if (event.data.status === "queued") return;
    if (event.data.status === "started") {
      this.#database
        .prepare(
          `UPDATE inference_requests
           SET status = 'started', started_at = COALESCE(started_at, ?)
           WHERE id = ?`,
        )
        .run(event.timestamp, event.data.requestId);
      return;
    }

    this.#database
      .prepare(
        `UPDATE inference_requests
         SET status = ?, completed_at = ?, error_code = ?
         WHERE id = ?`,
      )
      .run(
        event.data.status,
        event.timestamp,
        event.data.status === "failed" ? "inference_failed" : null,
        event.data.requestId,
      );
  }

  recoverInterruptedRequests(): number {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE inference_requests
         SET status = 'interrupted', completed_at = ?, error_code = 'host_restarted'
         WHERE status IN ('queued', 'started')`,
      )
      .run(now);
    return Number(result.changes);
  }

  listInferenceRequests(limit = 100): InferenceRequestRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, route_id, status, enqueued_at, started_at, completed_at, error_code
         FROM inference_requests
         ORDER BY enqueued_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as InferenceRequestRow[];
    return rows.map((row) => ({
      id: row.id,
      routeId: row.route_id,
      status: row.status,
      enqueuedAt: row.enqueued_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    }));
  }

  createUser(user: UserRecord): void {
    this.#database.prepare(`INSERT INTO users (id, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, user.displayName, user.role, user.status, user.createdAt, user.updatedAt);
  }

  updateUser(user: UserRecord): void {
    this.#database.prepare(`UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?`).run(user.displayName, user.role, user.status, user.updatedAt, user.id);
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.#database.prepare(`SELECT id, display_name, role, status, created_at, updated_at FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : undefined;
  }

  listUsers(): UserRecord[] {
    return (this.#database.prepare(`SELECT id, display_name, role, status, created_at, updated_at FROM users ORDER BY created_at`).all() as unknown as UserRow[]).map(mapUser);
  }

  createDevice(device: DeviceRecord, tokenHash: string): void {
    this.#database.prepare(`INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`).run(device.id, device.userId, device.name, tokenHash, device.createdAt);
  }

  listDevices(userId: string): DeviceRecord[] {
    return (this.#database.prepare(`SELECT id, user_id, name, token_hash, created_at, last_used_at, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at`).all(userId) as unknown as DeviceRow[]).map(mapDevice);
  }

  findDeviceByTokenHash(tokenHash: string): DeviceAuthenticationRecord | undefined {
    const row = this.#database.prepare(`SELECT d.id, d.user_id, d.name, d.token_hash, d.created_at, d.last_used_at, d.revoked_at, u.display_name, u.role, u.status, u.created_at AS user_created_at, u.updated_at AS user_updated_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`).get(tokenHash) as (DeviceRow & { display_name: string; role: UserRecord["role"]; status: UserRecord["status"]; user_created_at: string; user_updated_at: string }) | undefined;
    if (!row) return undefined;
    return { ...mapDevice(row), tokenHash: row.token_hash, user: { id: row.user_id, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.user_created_at, updatedAt: row.user_updated_at } };
  }

  touchDevice(id: string, timestamp: string): void { this.#database.prepare(`UPDATE devices SET last_used_at = ? WHERE id = ?`).run(timestamp, id); }
  revokeDevice(id: string, timestamp: string): boolean { return Number(this.#database.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(timestamp, id).changes) > 0; }

  replaceUserRouteGrants(userId: string, routeIds: readonly string[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`DELETE FROM user_route_grants WHERE user_id = ?`).run(userId);
      const insert = this.#database.prepare(`INSERT INTO user_route_grants (user_id, route_id, created_at) VALUES (?, ?, ?)`);
      const now = new Date().toISOString();
      for (const routeId of new Set(routeIds)) insert.run(userId, routeId, now);
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  listUserRouteGrants(userId: string): string[] {
    return (this.#database.prepare(`SELECT route_id FROM user_route_grants WHERE user_id = ? ORDER BY route_id`).all(userId) as unknown as { route_id: string }[]).map((row) => row.route_id);
  }

  setUserQuota(userId: string, quota: UserQuota): void {
    this.#database.prepare(`INSERT INTO user_quotas (user_id, quota_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET quota_json = excluded.quota_json, updated_at = excluded.updated_at`).run(userId, JSON.stringify(quota), new Date().toISOString());
  }

  getUserQuota(userId: string): UserQuota | undefined {
    const row = this.#database.prepare(`SELECT quota_json FROM user_quotas WHERE user_id = ?`).get(userId) as { quota_json: string } | undefined;
    return row ? JSON.parse(row.quota_json) as UserQuota : undefined;
  }

  appendAuditEvent(event: AuditEventRecord): void {
    this.#database.prepare(`INSERT INTO audit_events (id, timestamp, actor_user_id, action, target_type, target_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(event.id, event.timestamp, event.actorUserId ?? null, event.action, event.targetType ?? null, event.targetId ?? null, JSON.stringify(event.detail));
  }

  listAuditEvents(limit = 100): AuditEventRecord[] {
    const rows = this.#database.prepare(`SELECT id, timestamp, actor_user_id, action, target_type, target_id, detail_json FROM audit_events ORDER BY timestamp DESC LIMIT ?`).all(limit) as unknown as AuditRow[];
    return rows.map((row) => ({ id: row.id, timestamp: row.timestamp, action: row.action, detail: JSON.parse(row.detail_json) as Record<string, unknown>, ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}), ...(row.target_type ? { targetType: row.target_type } : {}), ...(row.target_id ? { targetId: row.target_id } : {}) }));
  }

  createPairingCode(record: PairingCodeRecord, codeHash: string): void { this.#database.prepare(`INSERT INTO pairing_codes (id, code_hash, intended_role, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(record.id, codeHash, record.intendedRole, record.expiresAt, record.consumedAt ?? null, record.createdAt); }
  consumePairingCode(codeHash: string, timestamp: string): UserRecord["role"] | undefined { const row = this.#database.prepare(`UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING intended_role`).get(timestamp, codeHash, timestamp) as { intended_role: UserRecord["role"] } | undefined; return row?.intended_role; }

  createAgentRun(run: AgentRunRecord): void {
    this.#database.prepare(`INSERT INTO agent_runs (id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.routeId, run.ownerUserId ?? null, run.sessionId ?? null, run.status, run.createdAt, run.updatedAt, run.lastSequence, run.error ?? null);
  }
  getAgentRun(id: string): AgentRunRecord | undefined { const row = this.#database.prepare(`SELECT id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined; return row ? mapAgentRun(row) : undefined; }
  listAgentRuns(ownerUserId?: string, limit = 100): AgentRunRecord[] {
    const rows = (ownerUserId ? this.#database.prepare(`SELECT id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error FROM agent_runs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?`).all(ownerUserId, limit) : this.#database.prepare(`SELECT id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error FROM agent_runs ORDER BY created_at DESC LIMIT ?`).all(limit)) as unknown as AgentRunRow[]; return rows.map(mapAgentRun);
  }
  updateAgentRun(id: string, status: AgentRunRecord["status"], error?: string): void { this.#database.prepare(`UPDATE agent_runs SET status = ?, updated_at = ?, error = ? WHERE id = ?`).run(status, new Date().toISOString(), error ?? null, id); }
  appendAgentEvent(event: AgentEventEnvelope): void {
    this.#database.exec("BEGIN IMMEDIATE"); try { this.#database.prepare(`INSERT INTO agent_events (run_id, sequence, timestamp, type, event_json) VALUES (?, ?, ?, ?, ?)`).run(event.runId, event.sequence, event.timestamp, event.type, JSON.stringify(event)); this.#database.prepare(`UPDATE agent_runs SET last_sequence = ?, updated_at = ? WHERE id = ?`).run(event.sequence, event.timestamp, event.runId); this.#database.exec("COMMIT"); } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  agentEventsAfter(runId: string, sequence: number, limit = 1000): AgentEventEnvelope[] { return (this.#database.prepare(`SELECT event_json FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(runId, sequence, limit) as unknown as { event_json: string }[]).map((row) => JSON.parse(row.event_json) as AgentEventEnvelope); }
  recoverInterruptedAgentRuns(): number { return Number(this.#database.prepare(`UPDATE agent_runs SET status = 'interrupted', updated_at = ?, error = 'host_restarted' WHERE status IN ('queued', 'running')`).run(new Date().toISOString()).changes); }
  recoverInterruptedToolApprovals(): number { const now = new Date().toISOString(); return Number(this.#database.prepare(`UPDATE tool_approvals SET status = 'cancelled', resolved_at = ?, note = 'host_restarted' WHERE status = 'pending'`).run(now).changes); }

  createProject(project: ProjectRecord): void { this.#database.prepare(`INSERT INTO projects (id, owner_user_id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(project.id, project.ownerUserId ?? null, project.name, project.rootPath ?? null, project.createdAt, project.updatedAt); }
  getProject(id: string): ProjectRecord | undefined { const row = this.#database.prepare(`SELECT id, owner_user_id, name, root_path, created_at, updated_at FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined; return row ? mapProject(row) : undefined; }
  listProjects(ownerUserId?: string): ProjectRecord[] { const rows = (ownerUserId ? this.#database.prepare(`SELECT id, owner_user_id, name, root_path, created_at, updated_at FROM projects WHERE owner_user_id = ? ORDER BY updated_at DESC`).all(ownerUserId) : this.#database.prepare(`SELECT id, owner_user_id, name, root_path, created_at, updated_at FROM projects ORDER BY updated_at DESC`).all()) as unknown as ProjectRow[]; return rows.map(mapProject); }
  updateProject(project: ProjectRecord): void { this.#database.prepare(`UPDATE projects SET name = ?, root_path = ?, updated_at = ? WHERE id = ?`).run(project.name, project.rootPath ?? null, project.updatedAt, project.id); }
  deleteProject(id: string): boolean { this.#database.exec("BEGIN IMMEDIATE"); try { this.#database.prepare(`UPDATE agent_runs SET session_id = NULL WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`).run(id); const removed = this.#database.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0; this.#database.exec("COMMIT"); return removed; } catch (error) { this.#database.exec("ROLLBACK"); throw error; } }

  createSession(session: SessionRecord): void { this.#database.prepare(`INSERT INTO sessions (id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(session.id, session.projectId, session.ownerUserId ?? null, session.title, session.status, session.connectionId ?? "hosted--local", session.routeId ?? "default", session.createdAt, session.updatedAt); }
  getSession(id: string): SessionRecord | undefined { const row = this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined; return row ? mapSession(row) : undefined; }
  listSessions(projectId: string, ownerUserId?: string): SessionRecord[] { const rows = (ownerUserId ? this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE project_id = ? AND owner_user_id = ? ORDER BY updated_at DESC`).all(projectId, ownerUserId) : this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId)) as unknown as SessionRow[]; return rows.map(mapSession); }
  updateSession(session: SessionRecord): void { this.#database.prepare(`UPDATE sessions SET title = ?, status = ?, connection_id = ?, route_id = ?, updated_at = ? WHERE id = ?`).run(session.title, session.status, session.connectionId ?? "hosted--local", session.routeId ?? "default", session.updatedAt, session.id); }

  appendTranscriptEntry(entry: Omit<TranscriptEntryRecord, "sequence">): TranscriptEntryRecord { this.#database.exec("BEGIN IMMEDIATE"); try { const row = this.#database.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM transcript_entries WHERE session_id = ?`).get(entry.sessionId) as { sequence: number }; const complete: TranscriptEntryRecord = { ...entry, sequence: row.sequence }; this.#database.prepare(`INSERT INTO transcript_entries (id, session_id, sequence, kind, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(complete.id, complete.sessionId, complete.sequence, complete.kind, complete.role ?? null, JSON.stringify(complete.content), complete.createdAt); this.#database.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(complete.createdAt, complete.sessionId); this.#database.exec("COMMIT"); return complete; } catch (error) { this.#database.exec("ROLLBACK"); throw error; } }
  transcriptAfter(sessionId: string, sequence: number, limit = 1000): TranscriptEntryRecord[] { return (this.#database.prepare(`SELECT id, session_id, sequence, kind, role, content_json, created_at FROM transcript_entries WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(sessionId, sequence, limit) as unknown as TranscriptRow[]).map(mapTranscript); }

  upsertToolPolicy(policy: ToolPolicyRecord): void { this.#database.prepare(`INSERT INTO tool_policies (subject_type, subject_id, tool_name, decision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject_type, subject_id, tool_name) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`).run(policy.subjectType, policy.subjectId, policy.toolName, policy.decision, policy.updatedAt); }
  listToolPolicies(subjectType?: ToolPolicyRecord["subjectType"], subjectId?: string): ToolPolicyRecord[] { const rows = (subjectType && subjectId ? this.#database.prepare(`SELECT subject_type, subject_id, tool_name, decision, updated_at FROM tool_policies WHERE subject_type = ? AND subject_id = ? ORDER BY tool_name`).all(subjectType, subjectId) : this.#database.prepare(`SELECT subject_type, subject_id, tool_name, decision, updated_at FROM tool_policies ORDER BY subject_type, subject_id, tool_name`).all()) as unknown as ToolPolicyRow[]; return rows.map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id, toolName: row.tool_name, decision: row.decision, updatedAt: row.updated_at })); }
  resolveToolPolicy(userId: string | undefined, role: UserRecord["role"] | undefined, toolName: string): ToolPolicyRecord["decision"] { if (userId) { const row = this.#database.prepare(`SELECT decision FROM tool_policies WHERE subject_type = 'user' AND subject_id = ? AND tool_name = ?`).get(userId, toolName) as { decision: ToolPolicyRecord["decision"] } | undefined; if (row) return row.decision; } if (role) { const row = this.#database.prepare(`SELECT decision FROM tool_policies WHERE subject_type = 'role' AND subject_id = ? AND tool_name = ?`).get(role, toolName) as { decision: ToolPolicyRecord["decision"] } | undefined; if (row) return row.decision; } return "ask"; }
  createToolApproval(approval: ToolApprovalRecord): void { this.#database.prepare(`INSERT INTO tool_approvals (id, session_id, run_id, tool_call_id, tool_name, status, request_json, requested_at, resolved_at, decided_by_user_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(approval.id, approval.sessionId, approval.runId ?? null, approval.toolCallId, approval.toolName, approval.status, JSON.stringify(approval.request), approval.requestedAt, approval.resolvedAt ?? null, approval.decidedByUserId ?? null, approval.note ?? null); }
  getToolApproval(id: string): ToolApprovalRecord | undefined { const row = this.#database.prepare(`SELECT id, session_id, run_id, tool_call_id, tool_name, status, request_json, requested_at, resolved_at, decided_by_user_id, note FROM tool_approvals WHERE id = ?`).get(id) as ToolApprovalRow | undefined; return row ? mapApproval(row) : undefined; }
  listToolApprovals(sessionId?: string, status?: ToolApprovalRecord["status"]): ToolApprovalRecord[] { let rows; if (sessionId && status) rows = this.#database.prepare(`SELECT * FROM tool_approvals WHERE session_id = ? AND status = ? ORDER BY requested_at`).all(sessionId, status); else if (sessionId) rows = this.#database.prepare(`SELECT * FROM tool_approvals WHERE session_id = ? ORDER BY requested_at`).all(sessionId); else if (status) rows = this.#database.prepare(`SELECT * FROM tool_approvals WHERE status = ? ORDER BY requested_at`).all(status); else rows = this.#database.prepare(`SELECT * FROM tool_approvals ORDER BY requested_at`).all(); return (rows as unknown as ToolApprovalRow[]).map(mapApproval); }
  resolveToolApproval(id: string, status: "approved" | "denied", decidedByUserId?: string, note?: string): boolean { return Number(this.#database.prepare(`UPDATE tool_approvals SET status = ?, resolved_at = ?, decided_by_user_id = ?, note = ? WHERE id = ? AND status = 'pending'`).run(status, new Date().toISOString(), decidedByUserId ?? null, note ?? null, id).changes) > 0; }
  cancelToolApproval(id: string, note?: string): boolean { return Number(this.#database.prepare(`UPDATE tool_approvals SET status = 'cancelled', resolved_at = ?, note = ? WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), note ?? null, id).changes) > 0; }
  createArtifact(artifact: ArtifactRecord, content: Uint8Array): void { this.#database.prepare(`INSERT INTO artifacts (id, session_id, name, mime_type, kind, byte_size, sha256, content, created_at, created_by_user_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, artifact.sessionId, artifact.name, artifact.mimeType, artifact.kind, artifact.byteSize, artifact.sha256, content, artifact.createdAt, artifact.createdByUserId ?? null, JSON.stringify(artifact.metadata)); }
  getArtifact(id: string): ArtifactRecord | undefined { const row = this.#database.prepare(`SELECT id, session_id, name, mime_type, kind, byte_size, sha256, created_at, created_by_user_id, metadata_json FROM artifacts WHERE id = ?`).get(id) as ArtifactRow | undefined; return row ? mapArtifact(row) : undefined; }
  listArtifacts(sessionId: string): ArtifactRecord[] { return (this.#database.prepare(`SELECT id, session_id, name, mime_type, kind, byte_size, sha256, created_at, created_by_user_id, metadata_json FROM artifacts WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId) as unknown as ArtifactRow[]).map(mapArtifact); }
  getArtifactContent(id: string): Uint8Array | undefined { const row = this.#database.prepare(`SELECT content FROM artifacts WHERE id = ?`).get(id) as { content: Uint8Array } | undefined; return row?.content; }
  deleteArtifact(id: string): boolean { return this.#database.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id).changes > 0; }

  setSetting(key: string, value: unknown): void {
    this.#database
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.#database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  close(): void {
    this.#database.close();
  }
}

function mapUser(row: UserRow): UserRecord { return { id: row.id, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapPlaybook(row: PlaybookRow): EngineRegistration { const value = JSON.parse(row.configuration_json) as Omit<EngineRegistration, "id" | "displayName" | "createdAt" | "updatedAt">; return { id: row.id, displayName: row.name, ...value, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapDevice(row: DeviceRow): DeviceRecord { return { id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}), ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}) }; }
function mapAgentRun(row: AgentRunRow): AgentRunRecord { return { id: row.id, routeId: row.route_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastSequence: row.last_sequence, ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.error ? { error: row.error } : {}) }; }
function mapProject(row: ProjectRow): ProjectRecord { return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}), ...(row.root_path ? { rootPath: row.root_path } : {}) }; }
function mapSession(row: SessionRow): SessionRecord { return { id: row.id, projectId: row.project_id, title: row.title, status: row.status, connectionId: row.connection_id, routeId: row.route_id, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}) }; }
function mapTranscript(row: TranscriptRow): TranscriptEntryRecord { return { id: row.id, sessionId: row.session_id, sequence: row.sequence, kind: row.kind, content: JSON.parse(row.content_json) as Record<string, unknown>, createdAt: row.created_at, ...(row.role ? { role: row.role } : {}) }; }
function mapApproval(row: ToolApprovalRow): ToolApprovalRecord { return { id: row.id, sessionId: row.session_id, toolCallId: row.tool_call_id, toolName: row.tool_name, status: row.status, request: JSON.parse(row.request_json) as Record<string, unknown>, requestedAt: row.requested_at, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}), ...(row.decided_by_user_id ? { decidedByUserId: row.decided_by_user_id } : {}), ...(row.note ? { note: row.note } : {}) }; }
function mapArtifact(row: ArtifactRow): ArtifactRecord { return { id: row.id, sessionId: row.session_id, name: row.name, mimeType: row.mime_type, kind: row.kind, byteSize: row.byte_size, sha256: row.sha256, createdAt: row.created_at, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}) }; }
