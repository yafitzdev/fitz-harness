import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { JobEvent, JobEventEnvelope, JobRecord, JobStatus, ListJobsOptions } from "@fitz/protocol";

interface JobRow {
  id: string;
  kind: JobRecord["kind"];
  status: JobStatus;
  owner_user_id: string | null;
  session_id: string | null;
  parent_job_id: string | null;
  route_id: string | null;
  progress: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata_json: string;
}

const JOB_COLUMNS = "id, kind, status, owner_user_id, session_id, parent_job_id, route_id, progress, error, created_at, updated_at, started_at, completed_at, metadata_json";

/** Durable common lifecycle index for all long-running work. Specialized
 * stores own source payloads; this store owns only identity, status, and a
 * compact control-plane event stream. */
export class SqliteJobStore {
  constructor(private readonly database: DatabaseSync) {}

  create(job: JobRecord): void {
    this.database
      .prepare(
        `INSERT INTO jobs (${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.kind,
        job.status,
        job.ownerUserId ?? null,
        job.sessionId ?? null,
        job.parentJobId ?? null,
        job.routeId ?? null,
        job.progress ?? null,
        job.error ?? null,
        job.createdAt,
        job.updatedAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        JSON.stringify(job.metadata ?? {}),
      );
    this.appendEvent(job.id, { type: "created", status: job.status, sourceType: "job.created" }, job.createdAt);
  }

  get(id: string): JobRecord | undefined {
    const row = this.database.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  update(id: string, patch: Partial<Omit<JobRecord, "id" | "kind" | "createdAt">>): void {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue | undefined): void => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    set("status", patch.status);
    set("owner_user_id", patch.ownerUserId);
    set("session_id", patch.sessionId);
    set("parent_job_id", patch.parentJobId);
    set("route_id", patch.routeId);
    set("progress", patch.progress);
    set("error", patch.error);
    set("updated_at", patch.updatedAt);
    set("started_at", patch.startedAt);
    set("completed_at", patch.completedAt);
    set("metadata_json", patch.metadata === undefined ? undefined : JSON.stringify(patch.metadata));
    if (assignments.length === 0) return;
    if (!patch.updatedAt) {
      assignments.push("updated_at = ?");
      values.push(new Date().toISOString());
    }
    values.push(id);
    this.database.prepare(`UPDATE jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  }

  list(options: ListJobsOptions = {}): JobRecord[] {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (options.ownerUserId !== undefined) {
      conditions.push("owner_user_id = ?");
      values.push(options.ownerUserId);
    }
    if (options.sessionId !== undefined) {
      conditions.push("session_id = ?");
      values.push(options.sessionId);
    }
    if (options.kind !== undefined) {
      conditions.push("kind = ?");
      values.push(options.kind);
    }
    if (options.status !== undefined) {
      conditions.push("status = ?");
      values.push(options.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...values, options.limit ?? 100) as unknown as JobRow[];
    return rows.map(mapJob);
  }

  appendEvent(jobId: string, event: JobEvent, timestamp: string): JobEventEnvelope {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = ?")
        .get(jobId) as { sequence: number };
      this.database
        .prepare("INSERT INTO job_events (job_id, sequence, timestamp, event_json) VALUES (?, ?, ?, ?)")
        .run(jobId, row.sequence, timestamp, JSON.stringify(event));
      const status = event.status;
      const assignments: string[] = ["updated_at = ?"];
      const values: SQLInputValue[] = [timestamp];
      if (status !== undefined) {
        assignments.push("status = ?");
        values.push(status);
      }
      if (event.progress !== undefined) {
        assignments.push("progress = ?");
        values.push(event.progress);
      }
      if (status === "running" || status === "progressing") {
        assignments.push("started_at = COALESCE(started_at, ?)");
        values.push(timestamp);
      }
      if (status === "completed" || status === "failed" || status === "interrupted") {
        assignments.push("completed_at = COALESCE(completed_at, ?)");
        values.push(timestamp);
      }
      if (status === "cancelled") {
        assignments.push("completed_at = COALESCE(completed_at, ?)");
        values.push(timestamp);
      }
      const error = event.data?.error;
      if (typeof error === "string") {
        assignments.push("error = ?");
        values.push(error);
      }
      values.push(jobId);
      this.database.prepare(`UPDATE jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
      if (ownsTransaction) this.database.exec("COMMIT");
      return { jobId, sequence: row.sequence, timestamp, event };
    } catch (error) {
      if (ownsTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(jobId: string, sequence: number, limit = 1000): JobEventEnvelope[] {
    const rows = this.database
      .prepare("SELECT job_id, sequence, timestamp, event_json FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(jobId, sequence, limit) as unknown as Array<{ job_id: string; sequence: number; timestamp: string; event_json: string }>;
    return rows.map((row) => ({
      jobId: row.job_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      event: JSON.parse(row.event_json) as JobEvent,
    }));
  }

  recoverInterrupted(kind: JobRecord["kind"], timestamp = new Date().toISOString()): number {
    const rows = this.database
      .prepare("SELECT id FROM jobs WHERE kind = ? AND status IN ('queued', 'running', 'progressing')")
      .all(kind) as unknown as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.database
          .prepare("UPDATE jobs SET status = 'interrupted', updated_at = ?, completed_at = COALESCE(completed_at, ?), error = COALESCE(error, 'host_restarted') WHERE id = ?")
          .run(timestamp, timestamp, row.id);
        this.appendEvent(row.id, { type: "interrupted", status: "interrupted", sourceType: "host.recovery", data: { error: "host_restarted", resumable: true } }, timestamp);
      }
      if (ownsTransaction) this.database.exec("COMMIT");
      return rows.length;
    } catch (error) {
      if (ownsTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapJob(row: JobRow): JobRecord {
  const metadata = JSON.parse(row.metadata_json) as Readonly<Record<string, unknown>>;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.parent_job_id ? { parentJobId: row.parent_job_id } : {}),
    ...(row.route_id ? { routeId: row.route_id } : {}),
    ...(row.progress !== null ? { progress: row.progress } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}
