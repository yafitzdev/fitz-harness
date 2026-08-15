import type { DatabaseSync } from "node:sqlite";

/** Small durable JSON settings repository shared by host services. */
export class SqliteSettingsStore {
  constructor(private readonly database: DatabaseSync) {}

  set(key: string, value: unknown): void {
    this.database.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), new Date().toISOString());
  }

  get<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  list(): Record<string, unknown> {
    const rows = this.database.prepare("SELECT key, value_json FROM settings ORDER BY key").all() as unknown as Array<{ key: string; value_json: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
  }

  delete(key: string): boolean { return this.database.prepare("DELETE FROM settings WHERE key = ?").run(key).changes > 0; }
}
