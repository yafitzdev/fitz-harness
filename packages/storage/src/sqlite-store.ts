import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AuditEventRecord,
  AgentEventEnvelope,
  ArtifactRecord,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunCheckpoint,
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
  RouteKind,
  UserQuota,
  UserRecord,
  SnapshotRecord,
  ToolActionRecord,
  TrashEntryRecord,
  MediaCreditRecord,
  MediaGenerationParams,
  MediaJobEvent,
  MediaJobRecord,
  MediaJobStatus,
  MediaModality,
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
  kind: string;
  enabled: number;
  is_default: number;
}

/** Media job row with the sequence envelope returned by event append/replay.
 *  Sequence numbers live only in the `media_job_events` table, mirroring agent_events. */
export interface MediaJobEventEnvelope {
  jobId: string;
  sequence: number;
  timestamp: string;
  event: MediaJobEvent;
}

interface MediaJobRow {
  id: string;
  session_id: string | null;
  route_id: string;
  modality: MediaModality;
  status: MediaJobStatus;
  params_json: string;
  progress: number | null;
  artifact_id: string | null;
  provider_job_id: string | null;
  error_code: string | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_by_user_id: string | null;
  credit_cost_cents: number | null;
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
interface AgentRunStateRow { request_json: string; resume_of_run_id: string | null; checkpoint_json: string; resumable: number; client_request_id?: string | null }
interface ProjectRow { id: string; owner_user_id: string | null; name: string; root_path: string | null; created_at: string; updated_at: string }
interface SessionRow { id: string; project_id: string | null; owner_user_id: string | null; title: string; status: SessionRecord["status"]; connection_id: string; route_id: "fast" | "default" | "smart"; created_at: string; updated_at: string }
interface TranscriptRow { id: string; session_id: string; sequence: number; kind: TranscriptEntryRecord["kind"]; role: TranscriptEntryRecord["role"] | null; content_json: string; created_at: string }
interface ToolPolicyRow { subject_type: ToolPolicyRecord["subjectType"]; subject_id: string; tool_name: string; decision: ToolPolicyRecord["decision"]; updated_at: string }
interface ToolApprovalRow { id: string; session_id: string; run_id: string | null; tool_call_id: string; tool_name: string; status: ToolApprovalRecord["status"]; request_json: string; requested_at: string; resolved_at: string | null; decided_by_user_id: string | null; note: string | null }
interface ArtifactRow { id: string; session_id: string; name: string; mime_type: string; kind: ArtifactRecord["kind"]; byte_size: number; sha256: string; storage_backend: string; object_key: string; created_at: string; created_by_user_id: string | null; metadata_json: string }
export interface ArtifactStorageRef { backend: string; objectKey: string }
export interface LegacyArtifactContent { artifactId: string; content: Uint8Array }
interface ToolActionRow { run_id: string; sequence: number; timestamp: string; tool_name: string; effect: ToolActionRecord["effect"]; path: string | null; detail_json: string }
interface SnapshotRow { run_id: string; workspace_root: string; snapshot_dir: string; created_at: string; status: SnapshotRecord["status"]; file_count: number }
interface TrashRow { id: string; run_id: string | null; workspace_root: string; original_path: string; trash_path: string; created_at: string; restored_at: string | null }
export interface ArtifactStorageEntry { artifactId: string; backend: string; objectKey: string; byteSize: number; sha256: string }

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
    let rebuild = false;
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      if (migration.rebuild) {
        // Table rebuilds (DROP TABLE) must run with foreign keys disabled, or
        // the drop cascades into child rows (transcripts, approvals) and
        // referencing tables (agent_runs.session_id) block it entirely.
        this.#database.exec("PRAGMA foreign_keys = OFF");
        rebuild = true;
      }
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
    if (rebuild) {
      try {
        const violations = this.#database.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(`Foreign key violations after migration: ${JSON.stringify(violations)}`);
        }
      } finally {
        this.#database.exec("PRAGMA foreign_keys = ON");
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
          id, display_name, description, recipe_id, kind, enabled, is_default, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          description = excluded.description,
          recipe_id = excluded.recipe_id,
          kind = excluded.kind,
          enabled = excluded.enabled,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at`,
      )
      .run(
        route.id,
        route.displayName,
        route.description ?? null,
        route.recipeId,
        route.kind ?? "chat",
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
        `SELECT id, display_name, description, recipe_id, kind, enabled, is_default
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
      // `kind` defaults to "chat"; omit it so chat routes round-trip unchanged.
      ...(row.kind !== "chat" ? { kind: row.kind as RouteKind } : {}),
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

  createMediaJob(job: MediaJobRecord): void {
    this.#database
      .prepare(
        `INSERT INTO media_jobs (
          id, session_id, route_id, modality, status, params_json, progress,
          artifact_id, provider_job_id, error_code, enqueued_at, started_at,
          completed_at, cancelled_at, created_by_user_id, credit_cost_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.sessionId ?? null,
        job.routeId,
        job.modality,
        job.status,
        JSON.stringify(job.params),
        job.progress ?? null,
        job.artifactId ?? null,
        job.providerJobId ?? null,
        job.errorCode ?? null,
        job.enqueuedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.cancelledAt ?? null,
        job.createdByUserId ?? null,
        job.creditCostCents ?? null,
      );
  }

  getMediaJob(id: string): MediaJobRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, session_id, route_id, modality, status, params_json, progress,
                artifact_id, provider_job_id, error_code, enqueued_at, started_at,
                completed_at, cancelled_at, created_by_user_id, credit_cost_cents
         FROM media_jobs WHERE id = ?`,
      )
      .get(id) as MediaJobRow | undefined;
    return row ? mapMediaJob(row) : undefined;
  }

  /** Partial update: only present patch fields are written; undefined is skipped. */
  updateMediaJob(id: string, patch: Partial<Omit<MediaJobRecord, "id" | "enqueuedAt">>): void {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue | undefined): void => {
      if (value !== undefined) { assignments.push(`${column} = ?`); values.push(value); }
    };
    set("session_id", patch.sessionId);
    set("route_id", patch.routeId);
    set("modality", patch.modality);
    set("status", patch.status);
    set("params_json", patch.params === undefined ? undefined : JSON.stringify(patch.params));
    set("progress", patch.progress);
    set("artifact_id", patch.artifactId);
    set("provider_job_id", patch.providerJobId);
    set("error_code", patch.errorCode);
    set("started_at", patch.startedAt);
    set("completed_at", patch.completedAt);
    set("cancelled_at", patch.cancelledAt);
    set("created_by_user_id", patch.createdByUserId);
    set("credit_cost_cents", patch.creditCostCents);
    if (assignments.length === 0) return;
    this.#database.prepare(`UPDATE media_jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  listMediaJobs(options: { ownerUserId?: string; sessionId?: string; status?: MediaJobStatus; limit?: number } = {}): MediaJobRecord[] {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (options.ownerUserId !== undefined) { conditions.push("created_by_user_id = ?"); values.push(options.ownerUserId); }
    if (options.sessionId !== undefined) { conditions.push("session_id = ?"); values.push(options.sessionId); }
    if (options.status !== undefined) { conditions.push("status = ?"); values.push(options.status); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const rows = this.#database
      .prepare(
        `SELECT id, session_id, route_id, modality, status, params_json, progress,
                artifact_id, provider_job_id, error_code, enqueued_at, started_at,
                completed_at, cancelled_at, created_by_user_id, credit_cost_cents
         FROM media_jobs ${where} ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(...values, limit) as unknown as MediaJobRow[];
    return rows.map(mapMediaJob);
  }

  /** Non-terminal (queued/started/progressing) jobs created since `since` — the
   *  rolling-window count backing `MediaQuota.maxJobsPerWindow` / `maxConcurrentJobs`. */
  countNonTerminalMediaJobs(userId: string, since: string): number {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM media_jobs
         WHERE created_by_user_id = ? AND enqueued_at >= ? AND status IN ('queued', 'started', 'progressing')`,
      )
      .get(userId, since) as { count: number };
    return Number(row.count);
  }

  /** Host-boot recovery: queued|started|progressing → interrupted (host_restarted),
   *  matching recoverInterruptedRequests / recoverInterruptedAgentRuns. */
  recoverInterruptedMediaJobs(): number {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE media_jobs
         SET status = 'interrupted', completed_at = ?, error_code = 'host_restarted'
         WHERE status IN ('queued', 'started', 'progressing')`,
      )
      .run(now);
    return Number(result.changes);
  }

  appendMediaJobEvent(jobId: string, event: MediaJobEvent, timestamp: string): MediaJobEventEnvelope {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM media_job_events WHERE job_id = ?`).get(jobId) as { sequence: number };
      this.#database.prepare(`INSERT INTO media_job_events (job_id, sequence, timestamp, type, event_json) VALUES (?, ?, ?, ?, ?)`).run(jobId, row.sequence, timestamp, event.type, JSON.stringify(event));
      this.#database.exec("COMMIT");
      return { jobId, sequence: row.sequence, timestamp, event };
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }

  mediaJobEventsAfter(jobId: string, sequence: number, limit = 1000): MediaJobEventEnvelope[] {
    const rows = this.#database
      .prepare(
        `SELECT job_id, sequence, timestamp, event_json FROM media_job_events
         WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(jobId, sequence, limit) as unknown as { job_id: string; sequence: number; timestamp: string; event_json: string }[];
    return rows.map((row) => ({ jobId: row.job_id, sequence: row.sequence, timestamp: row.timestamp, event: JSON.parse(row.event_json) as MediaJobEvent }));
  }

  appendMediaCredit(record: MediaCreditRecord): void {
    this.#database
      .prepare(`INSERT INTO media_quota_ledger (id, user_id, job_id, modality, cost_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.userId, record.jobId, record.modality, record.costCents, record.createdAt);
  }

  /** Sum of credited costs for the user since `since` — the `creditBudgetCents` basis. */
  sumMediaLedgerForUser(userId: string, since: string): number {
    const row = this.#database
      .prepare(`SELECT COALESCE(SUM(cost_cents), 0) AS total FROM media_quota_ledger WHERE user_id = ? AND created_at >= ?`)
      .get(userId, since) as { total: number };
    return Number(row.total);
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

  createAgentRun(run: AgentRunRecord, request?: AgentRunRequest, resumeOfRunId?: string): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`INSERT INTO agent_runs (id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.routeId, run.ownerUserId ?? null, run.sessionId ?? null, run.status, run.createdAt, run.updatedAt, run.lastSequence, run.error ?? null);
      if (request) this.#database.prepare(`INSERT INTO agent_run_state (run_id, request_json, resume_of_run_id, checkpoint_json, resumable, client_request_id) VALUES (?, ?, ?, ?, 0, ?)`).run(run.id, JSON.stringify(request), resumeOfRunId ?? null, JSON.stringify(initialAgentCheckpoint(run.createdAt)), request.clientRequestId ?? null);
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  getAgentRun(id: string): AgentRunRecord | undefined { const row = this.#database.prepare(`SELECT id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined; return row ? this.#withAgentRunState(mapAgentRun(row)) : undefined; }
  listAgentRuns(ownerUserId?: string, limit = 100): AgentRunRecord[] {
    const rows = (ownerUserId ? this.#database.prepare(`SELECT id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error FROM agent_runs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?`).all(ownerUserId, limit) : this.#database.prepare(`SELECT id, route_id, owner_user_id, session_id, status, created_at, updated_at, last_sequence, error FROM agent_runs ORDER BY created_at DESC LIMIT ?`).all(limit)) as unknown as AgentRunRow[]; return rows.map((row) => this.#withAgentRunState(mapAgentRun(row)));
  }
  getAgentRunRequest(id: string): AgentRunRequest | undefined { const row = this.#database.prepare(`SELECT request_json FROM agent_run_state WHERE run_id = ?`).get(id) as Pick<AgentRunStateRow, "request_json"> | undefined; return row ? JSON.parse(row.request_json) as AgentRunRequest : undefined; }
  latestSessionAgentRun(sessionId: string): AgentRunRecord | undefined {
    const row = this.#database.prepare(`SELECT r.id, r.route_id, r.owner_user_id, r.session_id, r.status, r.created_at, r.updated_at, r.last_sequence, r.error FROM agent_runs r LEFT JOIN agent_run_state s ON s.run_id = r.id WHERE r.session_id = ? AND (r.status IN ('queued', 'running') OR s.resumable = 1) ORDER BY CASE WHEN r.status IN ('queued', 'running') THEN 0 ELSE 1 END, r.updated_at DESC LIMIT 1`).get(sessionId) as AgentRunRow | undefined;
    return row ? this.#withAgentRunState(mapAgentRun(row)) : undefined;
  }
  agentRunResumedFrom(sourceRunId: string): AgentRunRecord | undefined {
    const row = this.#database.prepare(`SELECT r.id, r.route_id, r.owner_user_id, r.session_id, r.status, r.created_at, r.updated_at, r.last_sequence, r.error FROM agent_runs r JOIN agent_run_state s ON s.run_id = r.id WHERE s.resume_of_run_id = ? ORDER BY r.created_at DESC LIMIT 1`).get(sourceRunId) as AgentRunRow | undefined;
    return row ? this.#withAgentRunState(mapAgentRun(row)) : undefined;
  }
  agentRunForClientRequest(clientRequestId: string): AgentRunRecord | undefined {
    const row = this.#database.prepare(`SELECT r.id, r.route_id, r.owner_user_id, r.session_id, r.status, r.created_at, r.updated_at, r.last_sequence, r.error FROM agent_runs r JOIN agent_run_state s ON s.run_id = r.id WHERE s.client_request_id = ? LIMIT 1`).get(clientRequestId) as AgentRunRow | undefined;
    return row ? this.#withAgentRunState(mapAgentRun(row)) : undefined;
  }
  claimAgentRunResume(id: string): boolean { return Number(this.#database.prepare(`UPDATE agent_run_state SET resumable = 0 WHERE run_id = ? AND resumable = 1`).run(id).changes) > 0; }
  setAgentRunResumable(id: string, resumable: boolean): void { this.#database.prepare(`UPDATE agent_run_state SET resumable = ? WHERE run_id = ?`).run(resumable ? 1 : 0, id); }
  updateAgentRun(id: string, status: AgentRunRecord["status"], error?: string): void { this.#database.prepare(`UPDATE agent_runs SET status = ?, updated_at = ?, error = ? WHERE id = ?`).run(status, new Date().toISOString(), error ?? null, id); }
  appendAgentEvent(event: AgentEventEnvelope): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`INSERT INTO agent_events (run_id, sequence, timestamp, type, event_json) VALUES (?, ?, ?, ?, ?)`).run(event.runId, event.sequence, event.timestamp, event.type, JSON.stringify(event));
      const status = agentStatusForEvent(event.type);
      const eventError = typeof event.data.error === "string" ? event.data.error : null;
      this.#database.prepare(`UPDATE agent_runs SET last_sequence = ?, updated_at = ?, status = COALESCE(?, status), error = CASE WHEN ? IS NOT NULL THEN ? WHEN ? IN ('completed', 'cancelled', 'running') THEN NULL ELSE error END WHERE id = ?`).run(event.sequence, event.timestamp, status ?? null, eventError, eventError, status ?? null, event.runId);
      this.#advanceAgentCheckpoint(event);
      this.#database.exec("COMMIT");
    } catch (error) { this.#database.exec("ROLLBACK"); throw error; }
  }
  agentEventsAfter(runId: string, sequence: number, limit = 1000): AgentEventEnvelope[] { return (this.#database.prepare(`SELECT event_json FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(runId, sequence, limit) as unknown as { event_json: string }[]).map((row) => JSON.parse(row.event_json) as AgentEventEnvelope); }
  recoverInterruptedAgentRuns(): number {
    // If the process dies after claiming a continuation but before creating its
    // successor, there is no child run to return on retry. Re-open that orphaned
    // claim at startup; sources with a successor remain permanently consumed.
    this.#database.prepare(`UPDATE agent_run_state SET resumable = 1 WHERE resumable = 0 AND run_id IN (SELECT id FROM agent_runs WHERE status IN ('failed', 'interrupted')) AND NOT EXISTS (SELECT 1 FROM agent_run_state child WHERE child.resume_of_run_id = agent_run_state.run_id)`).run();
    const rows = this.#database.prepare(`SELECT id FROM agent_runs WHERE status IN ('queued', 'running')`).all() as unknown as { id: string }[];
    for (const row of rows) {
      const timestamp = new Date().toISOString();
      this.#materializeUncommittedAgentEvents(row.id);
      this.#database.prepare(`UPDATE agent_runs SET status = 'interrupted', updated_at = ?, error = 'host_restarted' WHERE id = ?`).run(timestamp, row.id);
      this.setAgentRunResumable(row.id, true);
      const run = this.getAgentRun(row.id);
      if (run) this.appendAgentEvent({ protocolVersion: "1", runId: row.id, sequence: run.lastSequence + 1, timestamp, type: "run.interrupted", data: { error: "host_restarted", resumable: true } });
    }
    return rows.length;
  }
  recoverInterruptedToolApprovals(): number { const now = new Date().toISOString(); return Number(this.#database.prepare(`UPDATE tool_approvals SET status = 'cancelled', resolved_at = ?, note = 'host_restarted' WHERE status = 'pending'`).run(now).changes); }

  createProject(project: ProjectRecord): void { this.#database.prepare(`INSERT INTO projects (id, owner_user_id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(project.id, project.ownerUserId ?? null, project.name, project.rootPath ?? null, project.createdAt, project.updatedAt); }
  getProject(id: string): ProjectRecord | undefined { const row = this.#database.prepare(`SELECT id, owner_user_id, name, root_path, created_at, updated_at FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined; return row ? mapProject(row) : undefined; }
  listProjects(ownerUserId?: string): ProjectRecord[] { const rows = (ownerUserId ? this.#database.prepare(`SELECT id, owner_user_id, name, root_path, created_at, updated_at FROM projects WHERE owner_user_id = ? ORDER BY updated_at DESC`).all(ownerUserId) : this.#database.prepare(`SELECT id, owner_user_id, name, root_path, created_at, updated_at FROM projects ORDER BY updated_at DESC`).all()) as unknown as ProjectRow[]; return rows.map(mapProject); }
  updateProject(project: ProjectRecord): void { this.#database.prepare(`UPDATE projects SET name = ?, root_path = ?, updated_at = ? WHERE id = ?`).run(project.name, project.rootPath ?? null, project.updatedAt, project.id); }
  deleteProject(id: string): boolean { this.#database.exec("BEGIN IMMEDIATE"); try { this.#database.prepare(`UPDATE agent_runs SET session_id = NULL WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`).run(id); const removed = this.#database.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0; this.#database.exec("COMMIT"); return removed; } catch (error) { this.#database.exec("ROLLBACK"); throw error; } }

  createSession(session: SessionRecord): void { this.#database.prepare(`INSERT INTO sessions (id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(session.id, session.projectId ?? null, session.ownerUserId ?? null, session.title, session.status, session.connectionId ?? "hosted--local", session.routeId ?? "default", session.createdAt, session.updatedAt); }
  getSession(id: string): SessionRecord | undefined { const row = this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined; return row ? mapSession(row) : undefined; }
  listSessions(projectId: string, ownerUserId?: string): SessionRecord[] { const rows = (ownerUserId ? this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE project_id = ? AND owner_user_id = ? ORDER BY updated_at DESC`).all(projectId, ownerUserId) : this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId)) as unknown as SessionRow[]; return rows.map(mapSession); }
  listStandaloneSessions(ownerUserId?: string): SessionRecord[] { const rows = (ownerUserId ? this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE project_id IS NULL AND owner_user_id = ? ORDER BY updated_at DESC`).all(ownerUserId) : this.#database.prepare(`SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions WHERE project_id IS NULL ORDER BY updated_at DESC`).all()) as unknown as SessionRow[]; return rows.map(mapSession); }
  updateSession(session: SessionRecord): void { this.#database.prepare(`UPDATE sessions SET title = ?, status = ?, connection_id = ?, route_id = ?, updated_at = ? WHERE id = ?`).run(session.title, session.status, session.connectionId ?? "hosted--local", session.routeId ?? "default", session.updatedAt, session.id); }

  appendTranscriptEntry(entry: Omit<TranscriptEntryRecord, "sequence">): TranscriptEntryRecord { this.#database.exec("BEGIN IMMEDIATE"); try { const row = this.#database.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM transcript_entries WHERE session_id = ?`).get(entry.sessionId) as { sequence: number }; const complete: TranscriptEntryRecord = { ...entry, sequence: row.sequence }; this.#database.prepare(`INSERT INTO transcript_entries (id, session_id, sequence, kind, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(complete.id, complete.sessionId, complete.sequence, complete.kind, complete.role ?? null, JSON.stringify(complete.content), complete.createdAt); this.#database.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(complete.createdAt, complete.sessionId); this.#database.exec("COMMIT"); return complete; } catch (error) { this.#database.exec("ROLLBACK"); throw error; } }
  transcriptAfter(sessionId: string, sequence: number, limit = 1000): TranscriptEntryRecord[] { return (this.#database.prepare(`SELECT id, session_id, sequence, kind, role, content_json, created_at FROM transcript_entries WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(sessionId, sequence, limit) as unknown as TranscriptRow[]).map(mapTranscript); }

  upsertToolPolicy(policy: ToolPolicyRecord): void { this.#database.prepare(`INSERT INTO tool_policies (subject_type, subject_id, tool_name, decision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject_type, subject_id, tool_name) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`).run(policy.subjectType, policy.subjectId, policy.toolName, policy.decision, policy.updatedAt); }
  listToolPolicies(subjectType?: ToolPolicyRecord["subjectType"], subjectId?: string): ToolPolicyRecord[] { const rows = (subjectType && subjectId ? this.#database.prepare(`SELECT subject_type, subject_id, tool_name, decision, updated_at FROM tool_policies WHERE subject_type = ? AND subject_id = ? ORDER BY tool_name`).all(subjectType, subjectId) : this.#database.prepare(`SELECT subject_type, subject_id, tool_name, decision, updated_at FROM tool_policies ORDER BY subject_type, subject_id, tool_name`).all()) as unknown as ToolPolicyRow[]; return rows.map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id, toolName: row.tool_name, decision: row.decision, updatedAt: row.updated_at })); }
  resolveToolPolicy(userId: string | undefined, role: UserRecord["role"] | undefined, toolName: string): ToolPolicyRecord["decision"] { if (userId) { const row = this.#database.prepare(`SELECT decision FROM tool_policies WHERE subject_type = 'user' AND subject_id = ? AND tool_name = ?`).get(userId, toolName) as { decision: ToolPolicyRecord["decision"] } | undefined; if (row) return row.decision; } if (role) { const row = this.#database.prepare(`SELECT decision FROM tool_policies WHERE subject_type = 'role' AND subject_id = ? AND tool_name = ?`).get(role, toolName) as { decision: ToolPolicyRecord["decision"] } | undefined; if (row) return row.decision; } return "ask"; }
  createToolApproval(approval: ToolApprovalRecord): void { this.#database.prepare(`INSERT INTO tool_approvals (id, session_id, run_id, tool_call_id, tool_name, status, request_json, requested_at, resolved_at, decided_by_user_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(approval.id, approval.sessionId, approval.runId ?? null, approval.toolCallId, approval.toolName, approval.status, JSON.stringify(approval.request), approval.requestedAt, approval.resolvedAt ?? null, approval.decidedByUserId ?? null, approval.note ?? null); }
  getToolApproval(id: string): ToolApprovalRecord | undefined { const row = this.#database.prepare(`SELECT id, session_id, run_id, tool_call_id, tool_name, status, request_json, requested_at, resolved_at, decided_by_user_id, note FROM tool_approvals WHERE id = ?`).get(id) as ToolApprovalRow | undefined; return row ? mapApproval(row) : undefined; }
  listToolApprovals(sessionId?: string, status?: ToolApprovalRecord["status"]): ToolApprovalRecord[] { let rows; if (sessionId && status) rows = this.#database.prepare(`SELECT * FROM tool_approvals WHERE session_id = ? AND status = ? ORDER BY requested_at`).all(sessionId, status); else if (sessionId) rows = this.#database.prepare(`SELECT * FROM tool_approvals WHERE session_id = ? ORDER BY requested_at`).all(sessionId); else if (status) rows = this.#database.prepare(`SELECT * FROM tool_approvals WHERE status = ? ORDER BY requested_at`).all(status); else rows = this.#database.prepare(`SELECT * FROM tool_approvals ORDER BY requested_at`).all(); return (rows as unknown as ToolApprovalRow[]).map(mapApproval); }
  resolveToolApproval(id: string, status: "approved" | "denied", decidedByUserId?: string, note?: string, request?: Readonly<Record<string, unknown>>): boolean {
    return Number(this.#database.prepare(`UPDATE tool_approvals SET status = ?, request_json = COALESCE(?, request_json), resolved_at = ?, decided_by_user_id = ?, note = ? WHERE id = ? AND status = 'pending'`).run(status, request ? JSON.stringify(request) : null, new Date().toISOString(), decidedByUserId ?? null, note ?? null, id).changes) > 0;
  }
  cancelToolApproval(id: string, note?: string): boolean { return Number(this.#database.prepare(`UPDATE tool_approvals SET status = 'cancelled', resolved_at = ?, note = ? WHERE id = ? AND status = 'pending'`).run(new Date().toISOString(), note ?? null, id).changes) > 0; }
  /** Metadata-only artifact catalog. Payload I/O belongs to ArtifactRepository. */
  createArtifact(artifact: ArtifactRecord, storage: ArtifactStorageRef): void { this.#database.prepare(`INSERT INTO artifacts (id, session_id, name, mime_type, kind, byte_size, sha256, storage_backend, object_key, created_at, created_by_user_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(artifact.id, artifact.sessionId, artifact.name, artifact.mimeType, artifact.kind, artifact.byteSize, artifact.sha256, storage.backend, storage.objectKey, artifact.createdAt, artifact.createdByUserId ?? null, JSON.stringify(artifact.metadata)); }
  getArtifact(id: string): ArtifactRecord | undefined { const row = this.#database.prepare(`SELECT id, session_id, name, mime_type, kind, byte_size, sha256, storage_backend, object_key, created_at, created_by_user_id, metadata_json FROM artifacts WHERE id = ?`).get(id) as ArtifactRow | undefined; return row ? mapArtifact(row) : undefined; }
  listArtifacts(sessionId: string): ArtifactRecord[] { return (this.#database.prepare(`SELECT id, session_id, name, mime_type, kind, byte_size, sha256, storage_backend, object_key, created_at, created_by_user_id, metadata_json FROM artifacts WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId) as unknown as ArtifactRow[]).map(mapArtifact); }
  getArtifactStorage(id: string): ArtifactStorageRef | undefined { const row = this.#database.prepare(`SELECT storage_backend, object_key FROM artifacts WHERE id = ?`).get(id) as Pick<ArtifactRow, "storage_backend" | "object_key"> | undefined; return row ? { backend: row.storage_backend, objectKey: row.object_key } : undefined; }
  listArtifactStorage(backend: string): ArtifactStorageRef[] { return (this.#database.prepare(`SELECT storage_backend, object_key FROM artifacts WHERE storage_backend = ?`).all(backend) as unknown as Array<Pick<ArtifactRow, "storage_backend" | "object_key">>).map((row) => ({ backend: row.storage_backend, objectKey: row.object_key })); }
  listArtifactStorageEntries(): ArtifactStorageEntry[] { return (this.#database.prepare(`SELECT id, storage_backend, object_key, byte_size, sha256 FROM artifacts ORDER BY id`).all() as unknown as Array<{ id: string; storage_backend: string; object_key: string; byte_size: number; sha256: string }>).map((row) => ({ artifactId: row.id, backend: row.storage_backend, objectKey: row.object_key, byteSize: row.byte_size, sha256: row.sha256 })); }
  deleteArtifact(id: string): boolean { return this.#database.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id).changes > 0; }
  nextLegacyArtifactContent(): LegacyArtifactContent | undefined { if (!this.#legacyArtifactsExist()) return undefined; const row = this.#database.prepare(`SELECT id, content FROM artifacts_legacy ORDER BY id LIMIT 1`).get() as { id: string; content: Uint8Array } | undefined; return row ? { artifactId: row.id, content: row.content } : undefined; }
  countLegacyArtifactRefs(): number { return Number((this.#database.prepare(`SELECT COUNT(*) AS count FROM artifacts WHERE storage_backend = 'legacy-sqlite'`).get() as { count: number }).count); }
  migrateArtifactStorage(id: string, artifact: Pick<ArtifactRecord, "byteSize" | "sha256">, storage: ArtifactStorageRef): void { this.#database.prepare(`UPDATE artifacts SET byte_size = ?, sha256 = ?, storage_backend = ?, object_key = ? WHERE id = ?`).run(artifact.byteSize, artifact.sha256, storage.backend, storage.objectKey, id); if (this.#legacyArtifactsExist()) this.#database.prepare(`DELETE FROM artifacts_legacy WHERE id = ?`).run(id); }
  dropLegacyArtifacts(): void { if (this.#legacyArtifactsExist()) this.#database.exec(`DROP TABLE artifacts_legacy`); }
  compactArtifactMigration(): void { this.#database.exec(`PRAGMA wal_checkpoint(TRUNCATE); VACUUM;`); }
  #legacyArtifactsExist(): boolean { return Boolean(this.#database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts_legacy'`).get()); }

  appendToolAction(action: Omit<ToolActionRecord, "sequence">): ToolActionRecord {
    const sequence = this.nextToolActionSequence(action.runId);
    const record: ToolActionRecord = { ...action, sequence };
    this.#database.prepare(`INSERT INTO tool_action_log (run_id, sequence, timestamp, tool_name, effect, path, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.runId, record.sequence, record.timestamp, record.toolName, record.effect, record.path ?? null, JSON.stringify(record.detail));
    return record;
  }
  nextToolActionSequence(runId: string): number { const row = this.#database.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM tool_action_log WHERE run_id = ?`).get(runId) as { sequence: number }; return row.sequence; }
  listToolActions(runId: string, limit = 1000): ToolActionRecord[] { const rows = this.#database.prepare(`SELECT run_id, sequence, timestamp, tool_name, effect, path, detail_json FROM tool_action_log WHERE run_id = ? ORDER BY sequence LIMIT ?`).all(runId, limit) as unknown as ToolActionRow[]; return rows.map(mapToolAction); }
  listAllToolActions(limit = 500): ToolActionRecord[] { const rows = this.#database.prepare(`SELECT run_id, sequence, timestamp, tool_name, effect, path, detail_json FROM tool_action_log ORDER BY timestamp DESC, run_id DESC, sequence DESC LIMIT ?`).all(limit) as unknown as ToolActionRow[]; return rows.map(mapToolAction); }

  createSnapshot(snapshot: SnapshotRecord): void { this.#database.prepare(`INSERT INTO snapshots (run_id, workspace_root, snapshot_dir, created_at, status, file_count) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET workspace_root = excluded.workspace_root, snapshot_dir = excluded.snapshot_dir, created_at = excluded.created_at, status = excluded.status, file_count = excluded.file_count`).run(snapshot.runId, snapshot.workspaceRoot, snapshot.snapshotDir, snapshot.createdAt, snapshot.status, snapshot.fileCount); }
  getSnapshot(runId: string): SnapshotRecord | undefined { const row = this.#database.prepare(`SELECT run_id, workspace_root, snapshot_dir, created_at, status, file_count FROM snapshots WHERE run_id = ?`).get(runId) as SnapshotRow | undefined; return row ? mapSnapshot(row) : undefined; }
  listSnapshots(limit = 100): SnapshotRecord[] { return (this.#database.prepare(`SELECT run_id, workspace_root, snapshot_dir, created_at, status, file_count FROM snapshots ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as SnapshotRow[]).map(mapSnapshot); }
  updateSnapshotStatus(runId: string, status: SnapshotRecord["status"]): void { this.#database.prepare(`UPDATE snapshots SET status = ? WHERE run_id = ?`).run(status, runId); }
  deleteSnapshot(runId: string): boolean { return this.#database.prepare(`DELETE FROM snapshots WHERE run_id = ?`).run(runId).changes > 0; }

  createTrashEntry(entry: TrashEntryRecord): void { this.#database.prepare(`INSERT INTO trash_entries (id, run_id, workspace_root, original_path, trash_path, created_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(entry.id, entry.runId ?? null, entry.workspaceRoot, entry.originalPath, entry.trashPath, entry.createdAt, entry.restoredAt ?? null); }
  getTrashEntry(id: string): TrashEntryRecord | undefined { const row = this.#database.prepare(`SELECT id, run_id, workspace_root, original_path, trash_path, created_at, restored_at FROM trash_entries WHERE id = ?`).get(id) as TrashRow | undefined; return row ? mapTrash(row) : undefined; }
  listTrashEntries(workspaceRoot?: string, limit = 200): TrashEntryRecord[] { const rows = (workspaceRoot ? this.#database.prepare(`SELECT id, run_id, workspace_root, original_path, trash_path, created_at, restored_at FROM trash_entries WHERE workspace_root = ? ORDER BY created_at DESC LIMIT ?`).all(workspaceRoot, limit) : this.#database.prepare(`SELECT id, run_id, workspace_root, original_path, trash_path, created_at, restored_at FROM trash_entries ORDER BY created_at DESC LIMIT ?`).all(limit)) as unknown as TrashRow[]; return rows.map(mapTrash); }
  markTrashRestored(id: string, restoredAt: string): boolean { return Number(this.#database.prepare(`UPDATE trash_entries SET restored_at = ? WHERE id = ? AND restored_at IS NULL`).run(restoredAt, id).changes) > 0; }
  deleteTrashEntry(id: string): boolean { return this.#database.prepare(`DELETE FROM trash_entries WHERE id = ?`).run(id).changes > 0; }
  deleteTrashEntriesBefore(before: string, workspaceRoot?: string): number { return Number((workspaceRoot ? this.#database.prepare(`DELETE FROM trash_entries WHERE created_at < ? AND workspace_root = ?`) : this.#database.prepare(`DELETE FROM trash_entries WHERE created_at < ?`)).run(before, ...(workspaceRoot ? [workspaceRoot] : [])).changes); }

  #withAgentRunState(run: AgentRunRecord): AgentRunRecord {
    const state = this.#database.prepare(`SELECT request_json, resume_of_run_id, checkpoint_json, resumable FROM agent_run_state WHERE run_id = ?`).get(run.id) as AgentRunStateRow | undefined;
    if (!state) return run;
    return { ...run, checkpoint: JSON.parse(state.checkpoint_json) as AgentRunCheckpoint, resumable: state.resumable === 1, ...(state.resume_of_run_id ? { resumeOfRunId: state.resume_of_run_id } : {}) };
  }

  #advanceAgentCheckpoint(event: AgentEventEnvelope): void {
    const row = this.#database.prepare(`SELECT checkpoint_json FROM agent_run_state WHERE run_id = ?`).get(event.runId) as Pick<AgentRunStateRow, "checkpoint_json"> | undefined;
    if (!row) return;
    const checkpoint = JSON.parse(row.checkpoint_json) as AgentRunCheckpoint;
    const completedTools = [...checkpoint.completedTools];
    let inFlightTools = [...checkpoint.inFlightTools];
    let pendingApprovalIds = [...checkpoint.pendingApprovalIds];
    let phase = checkpoint.phase;
    if (event.type === "run.started") phase = "running";
    if (event.type === "tool.started") {
      const toolCallId = String(event.data.toolCallId ?? "");
      if (toolCallId && !inFlightTools.some((tool) => tool.toolCallId === toolCallId)) inFlightTools.push({ toolCallId, toolName: String(event.data.toolName ?? "tool"), ...(event.data.input !== undefined ? { input: event.data.input } : {}) });
    }
    if (event.type === "tool.completed") {
      const toolCallId = String(event.data.toolCallId ?? "");
      const running = inFlightTools.find((tool) => tool.toolCallId === toolCallId);
      inFlightTools = inFlightTools.filter((tool) => tool.toolCallId !== toolCallId);
      if (toolCallId) completedTools.push({ toolCallId, toolName: running?.toolName ?? String(event.data.toolName ?? "tool"), ...(running?.input !== undefined ? { input: running.input } : {}), ...(event.data.isError !== undefined ? { isError: Boolean(event.data.isError) } : {}) });
    }
    if (event.type === "tool.approval.requested") { const id = String(event.data.approvalId ?? ""); if (id && !pendingApprovalIds.includes(id)) pendingApprovalIds.push(id); phase = "waiting-approval"; }
    if (event.type === "tool.approval.resolved") { const id = String(event.data.approvalId ?? ""); pendingApprovalIds = pendingApprovalIds.filter((item) => item !== id); phase = "running"; }
    if (event.type === "run.completed") phase = "completed";
    if (event.type === "run.failed") phase = "failed";
    if (event.type === "run.cancelled") phase = "cancelled";
    if (event.type === "run.interrupted") phase = "interrupted";
    const resumeSafety = inFlightTools.length > 0 || pendingApprovalIds.length > 0 ? "review-required" : "safe";
    const next: AgentRunCheckpoint = { sequence: event.sequence, phase, completedTools, inFlightTools, pendingApprovalIds, resumeSafety, updatedAt: event.timestamp };
    const terminalResumable = event.type === "run.failed" || event.type === "run.interrupted";
    const terminalFinal = event.type === "run.completed" || event.type === "run.cancelled";
    this.#database.prepare(`UPDATE agent_run_state SET checkpoint_json = ?, resumable = CASE WHEN ? = 1 THEN 1 WHEN ? = 1 THEN 0 ELSE resumable END WHERE run_id = ?`).run(JSON.stringify(next), terminalResumable ? 1 : 0, terminalFinal ? 1 : 0, event.runId);
  }

  /** Recover event data that reached SQLite before its buffered transcript row.
   * Event-derived ids make this replay idempotent across repeated host boots. */
  #materializeUncommittedAgentEvents(runId: string): void {
    const run = this.getAgentRun(runId);
    if (!run?.sessionId) return;
    const represented = new Set<number>();
    let transcriptSequence = 0;
    while (true) {
      const page = this.transcriptAfter(run.sessionId, transcriptSequence, 1_000);
      for (const entry of page) if (entry.content.runId === runId && Number.isFinite(Number(entry.content.eventSequence))) represented.add(Number(entry.content.eventSequence));
      if (page.length < 1_000) break;
      transcriptSequence = page.at(-1)!.sequence;
    }
    const events: AgentEventEnvelope[] = [];
    let eventSequence = 0;
    while (true) {
      const page = this.agentEventsAfter(runId, eventSequence, 1_000);
      events.push(...page);
      if (page.length < 1_000) break;
      eventSequence = page.at(-1)!.sequence;
    }
    let textType: "assistant.delta" | "reasoning.delta" | undefined;
    let text = ""; let from = 0; let through = 0;
    const flush = () => {
      if (!textType || !text || represented.has(through)) { textType = undefined; text = ""; return; }
      const kind = textType === "assistant.delta" ? "message" : "reasoning";
      this.#appendTranscriptEntryOnce({ id: `agent-event:${runId}:${kind}:${from}-${through}`, sessionId: run.sessionId!, kind, role: "assistant", content: { text, runId, eventSequence: through, ...(kind === "message" ? { phase: "commentary" } : {}) }, createdAt: events.find((event) => event.sequence === through)?.timestamp ?? new Date().toISOString() });
      textType = undefined; text = "";
    };
    for (const event of events) {
      if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
        if (textType && textType !== event.type) flush();
        if (!textType) { textType = event.type; from = event.sequence; }
        text += String(event.data.text ?? ""); through = event.sequence; continue;
      }
      flush();
      if ((event.type === "tool.started" || event.type === "tool.completed") && !represented.has(event.sequence)) this.#appendTranscriptEntryOnce({ id: `agent-event:${runId}:${event.type}:${event.sequence}`, sessionId: run.sessionId, kind: event.type === "tool.started" ? "tool-call" : "tool-result", role: "tool", content: { ...event.data, runId, eventSequence: event.sequence }, createdAt: event.timestamp });
    }
    flush();
  }

  #appendTranscriptEntryOnce(entry: Omit<TranscriptEntryRecord, "sequence">): void {
    const exists = this.#database.prepare(`SELECT 1 AS found FROM transcript_entries WHERE id = ?`).get(entry.id) as { found: number } | undefined;
    if (!exists) this.appendTranscriptEntry(entry);
  }

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

  deleteSetting(key: string): boolean {
    return this.#database.prepare("DELETE FROM settings WHERE key = ?").run(key).changes > 0;
  }

  async backupTo(path: string): Promise<number> {
    return backup(this.#database, path);
  }

  close(): void {
    this.#database.close();
  }
}

function initialAgentCheckpoint(timestamp: string): AgentRunCheckpoint { return { sequence: 0, phase: "queued", completedTools: [], inFlightTools: [], pendingApprovalIds: [], resumeSafety: "safe", updatedAt: timestamp }; }
function agentStatusForEvent(type: AgentEventEnvelope["type"]): AgentRunRecord["status"] | undefined {
  if (type === "run.started") return "running";
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  if (type === "run.interrupted") return "interrupted";
  return undefined;
}

function mapUser(row: UserRow): UserRecord { return { id: row.id, displayName: row.display_name, role: row.role, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapMediaJob(row: MediaJobRow): MediaJobRecord {
  return {
    id: row.id,
    routeId: row.route_id,
    modality: row.modality,
    status: row.status,
    params: JSON.parse(row.params_json) as MediaGenerationParams,
    enqueuedAt: row.enqueued_at,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.progress !== null ? { progress: row.progress } : {}),
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.provider_job_id ? { providerJobId: row.provider_job_id } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at } : {}),
    ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}),
    ...(row.credit_cost_cents !== null ? { creditCostCents: row.credit_cost_cents } : {}),
  };
}
function mapPlaybook(row: PlaybookRow): EngineRegistration { const value = JSON.parse(row.configuration_json) as Omit<EngineRegistration, "id" | "displayName" | "createdAt" | "updatedAt">; return { id: row.id, displayName: row.name, ...value, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapDevice(row: DeviceRow): DeviceRecord { return { id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}), ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}) }; }
function mapAgentRun(row: AgentRunRow): AgentRunRecord { return { id: row.id, routeId: row.route_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastSequence: row.last_sequence, ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.error ? { error: row.error } : {}) }; }
function mapProject(row: ProjectRow): ProjectRecord { return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}), ...(row.root_path ? { rootPath: row.root_path } : {}) }; }
function mapSession(row: SessionRow): SessionRecord { return { id: row.id, title: row.title, status: row.status, connectionId: row.connection_id, routeId: row.route_id, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}) }; }
function mapTranscript(row: TranscriptRow): TranscriptEntryRecord { return { id: row.id, sessionId: row.session_id, sequence: row.sequence, kind: row.kind, content: JSON.parse(row.content_json) as Record<string, unknown>, createdAt: row.created_at, ...(row.role ? { role: row.role } : {}) }; }
function mapApproval(row: ToolApprovalRow): ToolApprovalRecord { return { id: row.id, sessionId: row.session_id, toolCallId: row.tool_call_id, toolName: row.tool_name, status: row.status, request: JSON.parse(row.request_json) as Record<string, unknown>, requestedAt: row.requested_at, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}), ...(row.decided_by_user_id ? { decidedByUserId: row.decided_by_user_id } : {}), ...(row.note ? { note: row.note } : {}) }; }
function mapArtifact(row: ArtifactRow): ArtifactRecord { return { id: row.id, sessionId: row.session_id, name: row.name, mimeType: row.mime_type, kind: row.kind, byteSize: row.byte_size, sha256: row.sha256, createdAt: row.created_at, metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, ...(row.created_by_user_id ? { createdByUserId: row.created_by_user_id } : {}) }; }
function mapToolAction(row: ToolActionRow): ToolActionRecord { return { runId: row.run_id, sequence: row.sequence, timestamp: row.timestamp, toolName: row.tool_name, effect: row.effect, detail: JSON.parse(row.detail_json) as Record<string, unknown>, ...(row.path ? { path: row.path } : {}) }; }
function mapSnapshot(row: SnapshotRow): SnapshotRecord { return { runId: row.run_id, workspaceRoot: row.workspace_root, snapshotDir: row.snapshot_dir, createdAt: row.created_at, status: row.status, fileCount: row.file_count }; }
function mapTrash(row: TrashRow): TrashEntryRecord { return { id: row.id, workspaceRoot: row.workspace_root, originalPath: row.original_path, trashPath: row.trash_path, createdAt: row.created_at, ...(row.run_id ? { runId: row.run_id } : {}), ...(row.restored_at ? { restoredAt: row.restored_at } : {}) }; }
