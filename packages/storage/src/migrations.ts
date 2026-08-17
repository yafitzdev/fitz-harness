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
  {
    version: 10,
    // Durable agent continuation state. The request is stored separately from
    // the event log so an interrupted run can be continued without guessing
    // model/access settings from rendered transcript text.
    sql: `
      CREATE TABLE IF NOT EXISTS agent_run_state (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        request_json TEXT NOT NULL,
        resume_of_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        checkpoint_json TEXT NOT NULL,
        resumable INTEGER NOT NULL DEFAULT 0 CHECK (resumable IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_status
        ON agent_runs(session_id, status, updated_at DESC);
    `,
  },
  {
    version: 11,
    // A client-generated request identity makes run creation safe to retry
    // after a connection drops between commit and HTTP response delivery.
    sql: `
      ALTER TABLE agent_run_state ADD COLUMN client_request_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_state_client_request
        ON agent_run_state(client_request_id) WHERE client_request_id IS NOT NULL;
    `,
  },
  {
    version: 12,
    // Artifact payloads are deliberately outside SQLite. The database owns
    // searchable metadata and an opaque object reference; a short-lived legacy
    // table lets ArtifactRepository migrate pre-v12 BLOBs without data loss.
    sql: `
      ALTER TABLE artifacts RENAME TO artifacts_legacy;
      DROP INDEX IF EXISTS idx_artifacts_session;
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_backend TEXT NOT NULL,
        object_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_user_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO artifacts (
        id, session_id, name, mime_type, kind, byte_size, sha256,
        storage_backend, object_key, created_at, created_by_user_id, metadata_json
      ) SELECT
        id, session_id, name, mime_type, kind, byte_size, sha256,
        'legacy-sqlite', id, created_at, created_by_user_id, metadata_json
      FROM artifacts_legacy;
      CREATE INDEX idx_artifacts_session ON artifacts(session_id, created_at DESC);
      CREATE INDEX idx_artifacts_object ON artifacts(storage_backend, object_key);
    `,
  },
  {
    version: 13,
    // One durable admission ledger for every operation that can activate or
    // consume the host GPU. Executable streams remain in memory; unfinished
    // admissions become explicit interrupted records after a restart while
    // native agent/media request state supplies request-level continuation.
    sql: `
      CREATE TABLE IF NOT EXISTS gpu_work_items (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'media', 'warm')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        position INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL DEFAULT 0,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gpu_work_status
        ON gpu_work_items(status, enqueued_at);
    `,
  },
  {
    version: 14,
    // Engine performance policy belongs to the host, not to individual
    // consumers or recipes. Existing engines retain normal behavior; the
    // bundled local media engine starts in the safer paced profile.
    sql: `
      UPDATE playbooks
      SET configuration_json = json_set(
        configuration_json,
        '$.performanceMode',
        CASE WHEN lower(id) = 'comfyui' THEN 'safe' ELSE 'normal' END
      )
      WHERE json_extract(configuration_json, '$.performanceMode') IS NULL;
    `,
  },
  {
    version: 15,
    // Analytics facts are separate from mutable queue/job state. One row is
    // upserted at the terminal boundary of every request, allowing exact
    // retries/recovery without double-counting.
    sql: `
      CREATE TABLE request_usage (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'image', 'video', 'audio')),
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'interrupted')),
        route_id TEXT NOT NULL,
        recipe_id TEXT,
        playbook_id TEXT,
        adapter TEXT,
        model_id TEXT,
        owner_user_id TEXT,
        session_id TEXT,
        run_id TEXT,
        execution_lane TEXT NOT NULL CHECK (execution_lane IN ('gpu', 'cloud')),
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        first_output_at TEXT,
        completed_at TEXT NOT NULL,
        queue_wait_ms INTEGER,
        ttft_ms INTEGER,
        generation_ms INTEGER,
        duration_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        credit_cost_cents INTEGER,
        error_code TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_request_usage_completed ON request_usage(completed_at);
      CREATE INDEX idx_request_usage_owner ON request_usage(owner_user_id, completed_at);
      CREATE INDEX idx_request_usage_route ON request_usage(route_id, completed_at);
      CREATE INDEX idx_request_usage_recipe ON request_usage(recipe_id, completed_at);

      INSERT OR IGNORE INTO request_usage (
        id, kind, status, route_id, execution_lane, enqueued_at, started_at,
        completed_at, queue_wait_ms, duration_ms, error_code
      )
      SELECT id, 'chat', status, route_id, 'gpu', enqueued_at, started_at,
        COALESCE(completed_at, enqueued_at),
        CASE WHEN started_at IS NOT NULL THEN CAST((julianday(started_at)-julianday(enqueued_at))*86400000 AS INTEGER) END,
        CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL THEN CAST((julianday(completed_at)-julianday(started_at))*86400000 AS INTEGER) END,
        error_code
      FROM inference_requests WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted');

      INSERT OR IGNORE INTO request_usage (
        id, kind, status, route_id, owner_user_id, session_id, execution_lane,
        enqueued_at, started_at, completed_at, queue_wait_ms, duration_ms,
        credit_cost_cents, error_code, metadata_json
      )
      SELECT id, modality, status, route_id, created_by_user_id, session_id, 'gpu',
        enqueued_at, started_at, COALESCE(completed_at, cancelled_at, enqueued_at),
        CASE WHEN started_at IS NOT NULL THEN CAST((julianday(started_at)-julianday(enqueued_at))*86400000 AS INTEGER) END,
        CASE WHEN started_at IS NOT NULL THEN CAST((julianday(COALESCE(completed_at,cancelled_at,enqueued_at))-julianday(started_at))*86400000 AS INTEGER) END,
        credit_cost_cents, error_code, params_json
      FROM media_jobs WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted');
    `,
  },
  {
    version: 16,
    // Pin the engine identity selected at admission separately from mutable
    // route assignments. Effective generation parameters remain in params_json.
    sql: `ALTER TABLE media_jobs ADD COLUMN execution_json TEXT;`,
  },
  {
    version: 17,
    // Direct job ancestry makes edit lineage durable and queryable without
    // reconstructing it from whichever artifact rows happen to be loaded.
    sql: `ALTER TABLE media_jobs ADD COLUMN source_job_id TEXT REFERENCES media_jobs(id);`,
  },
  {
    version: 18,
    // Public chat sessions now choose only the host's local Default or the
    // consumer's Smart cloud model. Fast remains an internal subagent role.
    // Historical Fast sessions continue on Default after the cutover.
    rebuild: true,
    sql: `
      CREATE TABLE sessions_v18 (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        owner_user_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        connection_id TEXT NOT NULL DEFAULT 'hosted--local',
        route_id TEXT NOT NULL DEFAULT 'default' CHECK (route_id IN ('default', 'smart')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions_v18 (id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at)
        SELECT id, project_id, owner_user_id, title, status, connection_id,
          CASE WHEN route_id = 'smart' THEN 'smart' ELSE 'default' END,
          created_at, updated_at
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v18 RENAME TO sessions;
      CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at DESC);
      CREATE INDEX idx_sessions_connection ON sessions(connection_id, updated_at DESC);
      CREATE INDEX idx_sessions_standalone ON sessions(updated_at DESC) WHERE project_id IS NULL;
    `,
  },
  {
    version: 19,
    // Fast is now selectable in chat as well as being the delegated-worker
    // route. Expand the durable session constraint without rewriting values.
    rebuild: true,
    sql: `
      CREATE TABLE sessions_v19 (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        owner_user_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        connection_id TEXT NOT NULL DEFAULT 'hosted--local',
        route_id TEXT NOT NULL DEFAULT 'default' CHECK (route_id IN ('default', 'fast', 'smart')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions_v19 (id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at)
        SELECT id, project_id, owner_user_id, title, status, connection_id, route_id, created_at, updated_at
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v19 RENAME TO sessions;
      CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at DESC);
      CREATE INDEX idx_sessions_connection ON sessions(connection_id, updated_at DESC);
      CREATE INDEX idx_sessions_standalone ON sessions(updated_at DESC) WHERE project_id IS NULL;
    `,
  },
  {
    version: 20,
    // Recipes own anonymous worker capacity. Dispatch behavior is a separate,
    // system-owned and versioned registry so every child run can snapshot the
    // exact instructions and permissions it received.
    sql: `
      CREATE TABLE subagent_role_definitions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        display_name TEXT NOT NULL,
        dispatch_description TEXT NOT NULL,
        system_instructions TEXT NOT NULL,
        access_mode TEXT NOT NULL CHECK (access_mode IN ('full', 'read-only')),
        tool_call_budget INTEGER NOT NULL CHECK (tool_call_budget > 0),
        max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
        output_contract TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE UNIQUE INDEX idx_subagent_role_enabled
        ON subagent_role_definitions(id) WHERE enabled = 1;

      INSERT INTO subagent_role_definitions VALUES (
        'implementer', 1, 'Implementer',
        'Use for a bounded implementation task that should modify files and verify the result.',
        'Implement the assigned change. Inspect before editing, preserve unrelated work, stay inside the requested scope, and verify the result in proportion to risk.',
        'full', 40, 10000,
        'Return a concise report with the outcome, files changed, verification performed, and remaining risks.',
        1, datetime('now')
      );
      INSERT INTO subagent_role_definitions VALUES (
        'researcher', 1, 'Researcher',
        'Use for evidence gathering, repository investigation, or a focused technical question.',
        'Investigate the assigned question without modifying files. Inspect the highest-value sources first, distinguish evidence from inference, and stop exploring once the question can be answered reliably.',
        'read-only', 20, 4096,
        'Return a compact synthesis with precise file or source references and any unresolved uncertainty.',
        1, datetime('now')
      );
      INSERT INTO subagent_role_definitions VALUES (
        'reviewer', 1, 'Reviewer',
        'Use for an independent review of correctness, regressions, security, or test coverage.',
        'Independently inspect and critique the assigned scope without modifying files. Prioritize concrete correctness, security, and regression risks over stylistic preferences.',
        'read-only', 16, 4096,
        'Return findings ordered by severity with precise file references, verification performed, and a clear statement when no actionable issue is found.',
        1, datetime('now')
      );
    `,
  },
  {
    version: 21,
    // A root run's execution plan is a durable, independently queryable
    // artifact. The JSON document is revisioned so background workers and the
    // main agent cannot silently overwrite one another's state transitions.
    sql: `
      CREATE TABLE agent_run_plans (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `,
  },
  {
    version: 22,
    // Final synthesis is runtime-owned. The model finishes prerequisite work,
    // moves the plan to ready_for_answer, and the runtime marks it completed
    // only after one final assistant answer has been emitted.
    rebuild: true,
    sql: `
      CREATE TABLE agent_run_plans_v22 (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'ready_for_answer', 'completed')),
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO agent_run_plans_v22 (run_id, revision, status, plan_json, created_at, updated_at, completed_at)
        SELECT run_id, revision, status, plan_json, created_at, updated_at, completed_at FROM agent_run_plans;
      DROP TABLE agent_run_plans;
      ALTER TABLE agent_run_plans_v22 RENAME TO agent_run_plans;

      UPDATE subagent_role_definitions
      SET system_instructions = system_instructions || ' For claims about the current implementation, executable source and package manifests outrank design documents. Never infer a framework, runtime, test count, or architecture detail from aspirational documentation; identify intended design separately from verified current code.'
      WHERE id IN ('researcher', 'reviewer') AND enabled = 1;
    `,
  },
  {
    version: 23,
    // Repository research should return evidence, not consume an entire worker
    // context through open-ended exploration. Preserve v1 for historical run
    // snapshots and enable the bounded v2 definition for new dispatches.
    sql: `
      UPDATE subagent_role_definitions SET enabled = 0 WHERE id = 'researcher' AND enabled = 1;
      INSERT INTO subagent_role_definitions (
        id, version, display_name, dispatch_description, system_instructions,
        access_mode, tool_call_budget, max_output_tokens, output_contract, enabled, created_at
      )
      SELECT id, 2, display_name, dispatch_description, system_instructions,
        access_mode, 12, max_output_tokens, output_contract, 1, datetime('now')
      FROM subagent_role_definitions WHERE id = 'researcher' AND version = 1;
    `,
  },
  {
    version: 24,
    // A normalized, engine-neutral request/response envelope at the shared
    // inference boundary. It makes model calls recoverable by session_id even
    // when the agent runtime or provider process disappears mid-stream.
    sql: `
      CREATE TABLE IF NOT EXISTS inference_evidence (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind = 'chat'),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        route_id TEXT NOT NULL,
        recipe_id TEXT,
        adapter TEXT,
        model_id TEXT,
        owner_user_id TEXT,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        execution_lane TEXT NOT NULL CHECK (execution_lane IN ('gpu', 'cloud')),
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        request_json TEXT NOT NULL,
        response_json TEXT,
        error_json TEXT,
        engine_json TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_inference_evidence_session
        ON inference_evidence(session_id, enqueued_at, id);
      CREATE INDEX IF NOT EXISTS idx_inference_evidence_run
        ON inference_evidence(run_id, enqueued_at, id);
      CREATE INDEX IF NOT EXISTS idx_inference_evidence_status
        ON inference_evidence(status, enqueued_at);
    `,
  },
  {
    version: 25,
    // Append-only normalized deltas let an interrupted request retain the
    // exact response observed before the host/provider disappeared. The
    // evidence row remains the request lifecycle fact; this table is the
    // durable stream behind its response snapshot.
    sql: `
      CREATE TABLE IF NOT EXISTS inference_evidence_deltas (
        evidence_id TEXT NOT NULL REFERENCES inference_evidence(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        timestamp TEXT NOT NULL,
        delta_json TEXT NOT NULL,
        PRIMARY KEY (evidence_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_inference_evidence_deltas_evidence
        ON inference_evidence_deltas(evidence_id, sequence);
    `,
  },
  {
    version: 26,
    // Session-rooted exports read request usage by session repeatedly during
    // diagnosis; keep that lookup bounded on long-lived stores.
    sql: `
      CREATE INDEX IF NOT EXISTS idx_request_usage_session
        ON request_usage(session_id, enqueued_at, id);
    `,
  },
  {
    version: 27,
    // A compact, engine-neutral lifecycle registry. Agent and media tables
    // remain the source of truth for their specialized payloads; this table
    // makes all durable background work queryable through one contract.
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'media', 'maintenance')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'progressing', 'completed', 'failed', 'cancelled', 'interrupted')),
        owner_user_id TEXT,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        parent_job_id TEXT,
        route_id TEXT,
        progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        timestamp TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (job_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_owner_updated ON jobs(owner_user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_session_updated ON jobs(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_updated ON jobs(kind, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_events_job_sequence ON job_events(job_id, sequence);

      INSERT OR IGNORE INTO jobs (
        id, kind, status, owner_user_id, session_id, route_id, error,
        created_at, updated_at, metadata_json
      )
      SELECT id, 'agent', status, owner_user_id, session_id, route_id, error,
        created_at, updated_at, '{}'
      FROM agent_runs;

      INSERT OR IGNORE INTO jobs (
        id, kind, status, owner_user_id, session_id, route_id, error,
        created_at, updated_at, started_at, completed_at, progress, metadata_json
      )
      SELECT id, 'media', CASE WHEN status = 'started' THEN 'running' ELSE status END, created_by_user_id, session_id, route_id, error_code,
        enqueued_at, COALESCE(completed_at, started_at, enqueued_at), started_at,
        completed_at, progress, '{}'
      FROM media_jobs;
    `,
  },
  {
    version: 28,
    // Session transcript revisions make rebuildable projections exact even
    // when regeneration deletes the tail and later reuses sequence numbers.
    // The projection itself is a cache; canonical transcript rows remain the
    // source of truth and can recreate it at any time.
    sql: `
      ALTER TABLE sessions ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS session_projections (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        source_revision INTEGER NOT NULL,
        source_transcript_sequence INTEGER NOT NULL,
        transcript_entry_count INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        reasoning_count INTEGER NOT NULL,
        tool_call_count INTEGER NOT NULL,
        tool_result_count INTEGER NOT NULL,
        compaction_count INTEGER NOT NULL,
        latest_compaction_sequence INTEGER,
        latest_compaction_through_sequence INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_projections_revision
        ON session_projections(source_revision, updated_at DESC);
    `,
  },
] as const;
