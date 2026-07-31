export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS playbooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapter TEXT NOT NULL,
        configuration_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        playbook_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        adapter TEXT NOT NULL,
        model_id TEXT NOT NULL,
        context_tokens INTEGER NOT NULL,
        recipe_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        recipe_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lifecycle_events (
        sequence INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inference_requests (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        status TEXT NOT NULL,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error_code TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_events_timestamp
        ON lifecycle_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_inference_requests_status
        ON inference_requests(status, enqueued_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('administrator', 'agent', 'consumer')),
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS user_route_grants (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, route_id)
      );

      CREATE TABLE IF NOT EXISTS user_quotas (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        quota_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pairing_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        intended_role TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
      CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, timestamp DESC);
    `,
  },
] as const;
