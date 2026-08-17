import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  MediaCreditRecord,
  MediaExecutionMetadata,
  MediaGenerationParams,
  MediaJobEvent,
  MediaJobRecord,
  MediaJobStatus,
  MediaModality,
  JobEvent,
} from "@fitz/protocol";
import { SqliteJobStore } from "./sqlite-job-store.js";

export interface MediaJobEventEnvelope {
  jobId: string;
  sequence: number;
  timestamp: string;
  event: MediaJobEvent;
}

interface MediaJobRow {
  id: string;
  source_job_id: string | null;
  session_id: string | null;
  route_id: string;
  modality: MediaModality;
  status: MediaJobStatus;
  params_json: string;
  execution_json: string | null;
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

export interface ListMediaJobsOptions {
  ownerUserId?: string;
  sessionId?: string;
  status?: MediaJobStatus;
  limit?: number;
}

export class SqliteMediaStore {
  constructor(private readonly database: DatabaseSync, private readonly jobs = new SqliteJobStore(database)) {}

  createJob(job: MediaJobRecord): void {
    this.database
      .prepare(
        `INSERT INTO media_jobs (
          id, source_job_id, session_id, route_id, modality, status, params_json, execution_json, progress,
          artifact_id, provider_job_id, error_code, enqueued_at, started_at,
          completed_at, cancelled_at, created_by_user_id, credit_cost_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.sourceJobId ?? null,
        job.sessionId ?? null,
        job.routeId,
        job.modality,
        job.status,
        JSON.stringify(job.params),
        job.execution ? JSON.stringify(job.execution) : null,
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
    this.jobs.create({
      id: job.id,
      kind: "media",
      status: mediaStatusToJobStatus(job.status),
      ...(job.createdByUserId ? { ownerUserId: job.createdByUserId } : {}),
      ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      ...(job.sourceJobId ? { parentJobId: job.sourceJobId } : {}),
      routeId: job.routeId,
      ...(job.progress !== undefined ? { progress: job.progress } : {}),
      ...(job.errorCode ? { error: job.errorCode } : {}),
      createdAt: job.enqueuedAt,
      updatedAt: job.completedAt ?? job.startedAt ?? job.enqueuedAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      metadata: { modality: job.modality },
    });
  }

  getJob(id: string): MediaJobRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, source_job_id, session_id, route_id, modality, status, params_json, execution_json, progress,
                artifact_id, provider_job_id, error_code, enqueued_at, started_at,
                completed_at, cancelled_at, created_by_user_id, credit_cost_cents
         FROM media_jobs WHERE id = ?`,
      )
      .get(id) as MediaJobRow | undefined;
    return row ? mapMediaJob(row) : undefined;
  }

  updateJob(id: string, patch: Partial<Omit<MediaJobRecord, "id" | "enqueuedAt">>): void {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue | undefined): void => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    set("source_job_id", patch.sourceJobId);
    set("session_id", patch.sessionId);
    set("route_id", patch.routeId);
    set("modality", patch.modality);
    set("status", patch.status);
    set("params_json", patch.params === undefined ? undefined : JSON.stringify(patch.params));
    set("execution_json", patch.execution === undefined ? undefined : JSON.stringify(patch.execution));
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
    this.database.prepare(`UPDATE media_jobs SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
    const current = this.getJob(id);
    if (current) this.jobs.update(id, mediaJobToJobPatch(current));
  }

  listJobs(options: ListMediaJobsOptions = {}): MediaJobRecord[] {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (options.ownerUserId !== undefined) {
      conditions.push("created_by_user_id = ?");
      values.push(options.ownerUserId);
    }
    if (options.sessionId !== undefined) {
      conditions.push("session_id = ?");
      values.push(options.sessionId);
    }
    if (options.status !== undefined) {
      conditions.push("status = ?");
      values.push(options.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT id, source_job_id, session_id, route_id, modality, status, params_json, execution_json, progress,
                artifact_id, provider_job_id, error_code, enqueued_at, started_at,
                completed_at, cancelled_at, created_by_user_id, credit_cost_cents
         FROM media_jobs ${where} ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(...values, options.limit ?? 100) as unknown as MediaJobRow[];
    return rows.map(mapMediaJob);
  }

  countNonTerminalJobs(userId: string, since: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM media_jobs
         WHERE created_by_user_id = ? AND enqueued_at >= ? AND status IN ('queued', 'started', 'progressing')`,
      )
      .get(userId, since) as { count: number };
    return Number(row.count);
  }

  recoverInterruptedJobs(): number {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE media_jobs
         SET status = 'interrupted', completed_at = ?, error_code = 'host_restarted'
         WHERE status IN ('queued', 'started', 'progressing')`,
      )
      .run(now);
    const changed = Number(result.changes);
    if (changed > 0) this.jobs.recoverInterrupted("media", now);
    return changed;
  }

  appendJobEvent(jobId: string, event: MediaJobEvent, timestamp: string): MediaJobEventEnvelope {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM media_job_events WHERE job_id = ?")
        .get(jobId) as { sequence: number };
      this.database
        .prepare("INSERT INTO media_job_events (job_id, sequence, timestamp, type, event_json) VALUES (?, ?, ?, ?, ?)")
        .run(jobId, row.sequence, timestamp, event.type, JSON.stringify(event));
      const envelope = { jobId, sequence: row.sequence, timestamp, event };
      this.jobs.appendEvent(jobId, mediaJobEventToJobEvent(event), timestamp);
      this.database.exec("COMMIT");
      return envelope;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(jobId: string, sequence: number, limit = 1000): MediaJobEventEnvelope[] {
    const rows = this.database
      .prepare(
        `SELECT job_id, sequence, timestamp, event_json FROM media_job_events
         WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
      )
      .all(jobId, sequence, limit) as unknown as Array<{
        job_id: string;
        sequence: number;
        timestamp: string;
        event_json: string;
      }>;
    return rows.map((row) => ({
      jobId: row.job_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      event: JSON.parse(row.event_json) as MediaJobEvent,
    }));
  }

  appendCredit(record: MediaCreditRecord): void {
    this.database
      .prepare("INSERT INTO media_quota_ledger (id, user_id, job_id, modality, cost_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.userId, record.jobId, record.modality, record.costCents, record.createdAt);
  }

  sumLedgerForUser(userId: string, since: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(SUM(cost_cents), 0) AS total FROM media_quota_ledger WHERE user_id = ? AND created_at >= ?")
      .get(userId, since) as { total: number };
    return Number(row.total);
  }
}

function mapMediaJob(row: MediaJobRow): MediaJobRecord {
  return {
    id: row.id,
    ...(row.source_job_id ? { sourceJobId: row.source_job_id } : {}),
    routeId: row.route_id,
    modality: row.modality,
    status: row.status,
    params: JSON.parse(row.params_json) as MediaGenerationParams,
    ...(row.execution_json ? { execution: JSON.parse(row.execution_json) as MediaExecutionMetadata } : {}),
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

function mediaJobToJobPatch(job: MediaJobRecord): Parameters<SqliteJobStore["update"]>[1] {
  return {
    status: job.status === "started" ? "running" : job.status,
    ...(job.createdByUserId ? { ownerUserId: job.createdByUserId } : {}),
    ...(job.sessionId ? { sessionId: job.sessionId } : {}),
    ...(job.sourceJobId ? { parentJobId: job.sourceJobId } : {}),
    routeId: job.routeId,
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(job.errorCode ? { error: job.errorCode } : {}),
    updatedAt: new Date().toISOString(),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  };
}

function mediaJobEventToJobEvent(event: MediaJobEvent): JobEvent {
  if (event.type === "started") return { type: "started", status: "running", sourceType: event.type, data: { providerJobId: event.providerJobId } };
  if (event.type === "progress") return { type: "progress", status: "progressing", progress: event.progress, sourceType: event.type };
  if (event.type === "completed") return { type: "completed", status: "completed", sourceType: event.type, data: { mimeType: event.result.mimeType, byteSize: event.result.byteSize } };
  if (event.type === "failed") return { type: "failed", status: "failed", sourceType: event.type, data: { error: event.error } };
  return { type: "cancelled", status: "cancelled", sourceType: event.type };
}

function mediaStatusToJobStatus(status: MediaJobStatus): Exclude<JobEvent["status"], undefined> {
  return status === "started" ? "running" : status;
}
