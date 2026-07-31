import { DatabaseSync } from "node:sqlite";
import type {
  InferenceLifecycleEvent,
  InferenceRequestRecord,
  QueueUpdatedEvent,
  Recipe,
  Route,
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
