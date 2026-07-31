import { DatabaseSync } from "node:sqlite";
import type {
  AuditEventRecord,
  DeviceAuthenticationRecord,
  DeviceRecord,
  InferenceLifecycleEvent,
  InferenceRequestRecord,
  QueueUpdatedEvent,
  Recipe,
  Route,
  UserQuota,
  UserRecord,
} from "@fitz/protocol";
import { MIGRATIONS } from "./migrations.js";

interface RecipeRow {
  recipe_json: string;
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
function mapDevice(row: DeviceRow): DeviceRecord { return { id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}), ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}) }; }
