export interface Migration {
  version: number;
  sql: string;
  /** Rebuild migrations drop/recreate a table and must run with foreign keys disabled. */
  rebuild?: boolean;
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
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        owner_user_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_events (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_owner ON agent_runs(owner_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_events_timestamp ON agent_events(timestamp);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, owner_user_id TEXT, name TEXT NOT NULL, root_path TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_user_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcript_entries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, content_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS tool_policies (
        subject_type TEXT NOT NULL CHECK (subject_type IN ('role', 'user')), subject_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'ask')),
        updated_at TEXT NOT NULL, PRIMARY KEY (subject_type, subject_id, tool_name)
      );
      CREATE TABLE IF NOT EXISTS tool_approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
        request_json TEXT NOT NULL, requested_at TEXT NOT NULL, resolved_at TEXT,
        decided_by_user_id TEXT, note TEXT
      );
      ALTER TABLE agent_runs ADD COLUMN session_id TEXT REFERENCES sessions(id);
      CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_entries(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_tool_approvals_status ON tool_approvals(status, requested_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, kind TEXT NOT NULL, byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL,
        created_by_user_id TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at DESC);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE sessions ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'hosted--local';
      ALTER TABLE sessions ADD COLUMN route_id TEXT NOT NULL DEFAULT 'default'
        CHECK (route_id IN ('fast', 'default', 'smart'));
      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id, updated_at DESC);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_action_log (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL,
        path TEXT,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        workspace_root TEXT NOT NULL,
        snapshot_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'restored', 'failed', 'skipped')),
        file_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS trash_entries (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
        workspace_root TEXT NOT NULL,
        original_path TEXT NOT NULL,
        trash_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_action_log_run ON tool_action_log(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_trash_entries_workspace ON trash_entries(workspace_root, created_at DESC);
    `,
  },
  {
    version: 8,
    // Rebuild `sessions` so project_id is nullable, enabling standalone chats
    // (sessions with no project attached). SQLite cannot drop a NOT NULL
    // constraint in place, so we recreate the table. `rebuild: true` makes
    // SqliteStore.migrate() run this with PRAGMA foreign_keys = OFF so the
    // DROP TABLE does not cascade into transcript_entries / tool_approvals,
    // and agent_runs.session_id does not block it.
    rebuild: true,
    sql: `
      CREATE TABLE sessions_v8 (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        owner_user_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        connection_id TEXT NOT NULL DEFAULT 'hosted--local',
        route_id TEXT NOT NULL DEFAULT 'default' CHECK (route_id IN ('fast', 'default', 'smart')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions_v8 (id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at)
        SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v8 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_standalone ON sessions(updated_at DESC) WHERE project_id IS NULL;
    `,
  },
  {
    version: 9,
    // Media generation: routes gain a `kind` (chat default; media routes are
    // image/video/audio), plus the durable job model — media_jobs (submit/poll/
    // cancel, restart recovery), media_job_events ((job_id, sequence) PK for SSE
    // replay, mirroring agent_events), and media_quota_ledger (credit accounting
    // for MediaQuota.creditBudgetCents).
    sql: `
      ALTER TABLE routes ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
        CHECK (kind IN ('chat', 'image', 'video', 'audio'));

      CREATE TABLE IF NOT EXISTS media_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        route_id TEXT NOT NULL,
        modality TEXT NOT NULL CHECK (modality IN ('image', 'video', 'audio')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'started', 'progressing', 'completed', 'failed', 'cancelled', 'interrupted')),
        params_json TEXT NOT NULL,
        progress REAL,
        artifact_id TEXT,
        provider_job_id TEXT,
        error_code TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT,
        created_by_user_id TEXT,
        credit_cost_cents INTEGER
      );

      CREATE TABLE IF NOT EXISTS media_job_events (
        job_id TEXT NOT NULL REFERENCES media_jobs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (job_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS media_quota_ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        job_id TEXT REFERENCES media_jobs(id) ON DELETE CASCADE,
        modality TEXT NOT NULL,
        cost_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_media_jobs_owner ON media_jobs(created_by_user_id, enqueued_at);
      CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, enqueued_at);
      CREATE INDEX IF NOT EXISTS idx_media_quota_ledger_user ON media_quota_ledger(user_id, created_at);
    `,
  },
] as const;
