import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  GpuWorkRecord,
  InferenceLifecycleEvent,
  InferenceRequestRecord,
  QueueUpdatedEvent,
  RequestUsageRecord,
  UsageReport,
} from "@fitz/protocol";

interface EventRow { event_json: string }
interface InferenceRequestRow { id: string; route_id: string; status: InferenceRequestRecord["status"]; enqueued_at: string; started_at: string | null; completed_at: string | null; error_code: string | null }
interface GpuWorkRow { id: string; route_id: string; kind: GpuWorkRecord["kind"]; status: GpuWorkRecord["status"]; position: number; depth: number; enqueued_at: string; started_at: string | null; completed_at: string | null; error_code: string | null }
interface UsageAggregateRow { requests: number; successful: number; failed: number; cancelled: number; interrupted: number; prompt_tokens: number; completion_tokens: number; token_reported_requests: number; media_jobs: number; credit_cost_cents: number; average_queue_wait_ms: number | null; average_ttft_ms: number | null; average_duration_ms: number | null }
interface RequestUsageRow {
  id: string; kind: RequestUsageRecord["kind"]; status: RequestUsageRecord["status"];
  route_id: string; recipe_id: string | null; playbook_id: string | null;
  adapter: string | null; model_id: string | null; owner_user_id: string | null;
  session_id: string | null; run_id: string | null; execution_lane: RequestUsageRecord["executionLane"];
  enqueued_at: string; started_at: string | null; first_output_at: string | null;
  completed_at: string; queue_wait_ms: number | null; ttft_ms: number | null;
  generation_ms: number | null; duration_ms: number | null; prompt_tokens: number | null;
  completion_tokens: number | null; credit_cost_cents: number | null; error_code: string | null;
  metadata_json: string;
}

/** Lifecycle, queue, request, and usage telemetry persistence. */
export class SqliteInferenceTelemetryStore {
  constructor(private readonly database: DatabaseSync) {}

  appendLifecycleEvent(event: InferenceLifecycleEvent): void { this.database.prepare(`INSERT OR REPLACE INTO lifecycle_events (sequence, type, timestamp, event_json) VALUES (?, ?, ?, ?)`).run(event.sequence, event.type, event.timestamp, JSON.stringify(event)); }
  lifecycleEventsAfter(sequence: number, limit = 500): InferenceLifecycleEvent[] { const rows = this.database.prepare(`SELECT event_json FROM lifecycle_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`).all(sequence, limit) as unknown as EventRow[]; return rows.map((row) => JSON.parse(row.event_json) as InferenceLifecycleEvent); }
  latestLifecycleSequence(): number { return (this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM lifecycle_events").get() as { sequence: number }).sequence; }

  recordQueueEvent(event: QueueUpdatedEvent): void {
    this.database.prepare(`INSERT INTO inference_requests (id, route_id, status, enqueued_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(event.data.requestId, event.data.routeId, event.data.status, event.timestamp);
    if (event.data.status === "queued") return;
    if (event.data.status === "started") { this.database.prepare(`UPDATE inference_requests SET status = 'started', started_at = COALESCE(started_at, ?) WHERE id = ?`).run(event.timestamp, event.data.requestId); return; }
    this.database.prepare(`UPDATE inference_requests SET status = ?, completed_at = ?, error_code = ? WHERE id = ?`).run(event.data.status, event.timestamp, event.data.status === "failed" ? "inference_failed" : null, event.data.requestId);
  }

  recordGpuQueueEvent(event: QueueUpdatedEvent): void {
    const status = event.data.status === "started" ? "running" : event.data.status;
    this.database.prepare(`INSERT INTO gpu_work_items (id, route_id, kind, status, position, depth, enqueued_at, started_at, completed_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, position = excluded.position, depth = excluded.depth, started_at = COALESCE(gpu_work_items.started_at, excluded.started_at), completed_at = COALESCE(excluded.completed_at, gpu_work_items.completed_at), error_code = excluded.error_code`).run(event.data.requestId, event.data.routeId, event.data.kind, status, event.data.position, event.data.depth, event.timestamp, status === "running" ? event.timestamp : null, ["completed", "failed", "cancelled"].includes(status) ? event.timestamp : null, status === "failed" ? "gpu_work_failed" : null);
  }
  recoverInterruptedGpuWork(): number { const result = this.database.prepare(`UPDATE gpu_work_items SET status = 'interrupted', position = 0, depth = 0, completed_at = ?, error_code = 'host_restarted' WHERE status IN ('queued', 'running')`).run(new Date().toISOString()); return Number(result.changes); }
  listGpuWork(limit = 100): GpuWorkRecord[] {
    const rows = this.database.prepare(`SELECT id, route_id, kind, status, position, depth, enqueued_at, started_at, completed_at, error_code FROM gpu_work_items ORDER BY enqueued_at DESC LIMIT ?`).all(limit) as unknown as GpuWorkRow[];
    return rows.map((row) => ({ id: row.id, routeId: row.route_id, kind: row.kind, status: row.status, position: row.position, depth: row.depth, enqueuedAt: row.enqueued_at, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) }));
  }

  recoverInterruptedRequests(): number { const result = this.database.prepare(`UPDATE inference_requests SET status = 'interrupted', completed_at = ?, error_code = 'host_restarted' WHERE status IN ('queued', 'started')`).run(new Date().toISOString()); return Number(result.changes); }
  listInferenceRequests(limit = 100): InferenceRequestRecord[] {
    const rows = this.database.prepare(`SELECT id, route_id, status, enqueued_at, started_at, completed_at, error_code FROM inference_requests ORDER BY enqueued_at DESC LIMIT ?`).all(limit) as unknown as InferenceRequestRow[];
    return rows.map((row) => ({ id: row.id, routeId: row.route_id, status: row.status, enqueuedAt: row.enqueued_at, ...(row.started_at ? { startedAt: row.started_at } : {}), ...(row.completed_at ? { completedAt: row.completed_at } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) }));
  }

  recordRequestUsage(record: RequestUsageRecord): void {
    this.database.prepare(`
      INSERT INTO request_usage (
        id, kind, status, route_id, recipe_id, playbook_id, adapter, model_id,
        owner_user_id, session_id, run_id, execution_lane, enqueued_at,
        started_at, first_output_at, completed_at, queue_wait_ms, ttft_ms,
        generation_ms, duration_ms, prompt_tokens, completion_tokens,
        credit_cost_cents, error_code, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        recipe_id=COALESCE(excluded.recipe_id, request_usage.recipe_id),
        playbook_id=COALESCE(excluded.playbook_id, request_usage.playbook_id),
        adapter=COALESCE(excluded.adapter, request_usage.adapter),
        model_id=COALESCE(excluded.model_id, request_usage.model_id),
        owner_user_id=COALESCE(excluded.owner_user_id, request_usage.owner_user_id),
        session_id=COALESCE(excluded.session_id, request_usage.session_id),
        run_id=COALESCE(excluded.run_id, request_usage.run_id),
        started_at=COALESCE(excluded.started_at, request_usage.started_at),
        first_output_at=COALESCE(excluded.first_output_at, request_usage.first_output_at),
        queue_wait_ms=COALESCE(excluded.queue_wait_ms, request_usage.queue_wait_ms),
        ttft_ms=COALESCE(excluded.ttft_ms, request_usage.ttft_ms), generation_ms=COALESCE(excluded.generation_ms, request_usage.generation_ms),
        duration_ms=COALESCE(excluded.duration_ms, request_usage.duration_ms), prompt_tokens=COALESCE(excluded.prompt_tokens, request_usage.prompt_tokens),
        completion_tokens=COALESCE(excluded.completion_tokens, request_usage.completion_tokens), credit_cost_cents=COALESCE(excluded.credit_cost_cents, request_usage.credit_cost_cents),
        error_code=COALESCE(excluded.error_code, request_usage.error_code),
        metadata_json=CASE WHEN excluded.metadata_json='{}' THEN request_usage.metadata_json ELSE excluded.metadata_json END
    `).run(
      record.id, record.kind, record.status, record.routeId, record.recipeId ?? null,
      record.playbookId ?? null, record.adapter ?? null, record.modelId ?? null,
      record.ownerUserId ?? null, record.sessionId ?? null, record.runId ?? null,
      record.executionLane, record.enqueuedAt, record.startedAt ?? null,
      record.firstOutputAt ?? null, record.completedAt, record.queueWaitMs ?? null,
      record.ttftMs ?? null, record.generationMs ?? null, record.durationMs ?? null,
      record.promptTokens ?? null, record.completionTokens ?? null,
      record.creditCostCents ?? null, record.errorCode ?? null,
      JSON.stringify(record.metadata ?? {}),
    );
  }

  listRequestUsageForRun(runId: string): RequestUsageRecord[] {
    const rows = this.database.prepare(`SELECT id, kind, status, route_id, recipe_id, playbook_id, adapter, model_id, owner_user_id, session_id, run_id, execution_lane, enqueued_at, started_at, first_output_at, completed_at, queue_wait_ms, ttft_ms, generation_ms, duration_ms, prompt_tokens, completion_tokens, credit_cost_cents, error_code, metadata_json FROM request_usage WHERE run_id = ? ORDER BY COALESCE(started_at, enqueued_at), completed_at, id`).all(runId) as unknown as RequestUsageRow[];
    return rows.map(mapRequestUsage);
  }

  usageReport(options: { from: string; to: string; bucket: "hour" | "day"; ownerUserId?: string }): UsageReport {
    const filters = ["completed_at >= ?", "completed_at < ?"];
    const values: SQLInputValue[] = [options.from, options.to];
    if (options.ownerUserId) { filters.push("owner_user_id = ?"); values.push(options.ownerUserId); }
    const where = filters.join(" AND ");
    const totals = this.database.prepare(`SELECT COUNT(*) requests, SUM(status='completed') successful, SUM(status='failed') failed, SUM(status='cancelled') cancelled, SUM(status='interrupted') interrupted, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens, SUM(prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL) token_reported_requests, SUM(kind!='chat') media_jobs, COALESCE(SUM(credit_cost_cents),0) credit_cost_cents, AVG(queue_wait_ms) average_queue_wait_ms, AVG(ttft_ms) average_ttft_ms, AVG(duration_ms) average_duration_ms FROM request_usage WHERE ${where}`).get(...values) as unknown as UsageAggregateRow;
    const bucketExpression = options.bucket === "hour" ? "substr(completed_at,1,13) || ':00:00.000Z'" : "substr(completed_at,1,10) || 'T00:00:00.000Z'";
    const timeline = this.database.prepare(`SELECT ${bucketExpression} timestamp, COUNT(*) requests, SUM(status='failed') failed, SUM(status='interrupted') interrupted, SUM(kind!='chat') media_jobs, COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens FROM request_usage WHERE ${where} GROUP BY 1 ORDER BY 1`).all(...values) as unknown as UsageReport["timeline"];
    const breakdown = (keyExpression: string, labelExpression: string): UsageReport["routes"] => this.database.prepare(`SELECT ${keyExpression} key, ${labelExpression} label, COUNT(*) requests, SUM(status='failed') failed, SUM(status='interrupted') interrupted, COALESCE(SUM(prompt_tokens),0)+COALESCE(SUM(completion_tokens),0) totalTokens, AVG(ttft_ms) averageTtftMs, AVG(duration_ms) averageDurationMs FROM request_usage WHERE ${where} GROUP BY 1,2 ORDER BY requests DESC LIMIT 12`).all(...values).map((row: any) => ({ key: String(row.key), label: String(row.label), requests: Number(row.requests), failed: Number(row.failed), interrupted: Number(row.interrupted), totalTokens: Number(row.totalTokens), ...(row.averageTtftMs !== null ? { averageTtftMs: Number(row.averageTtftMs) } : {}), ...(row.averageDurationMs !== null ? { averageDurationMs: Number(row.averageDurationMs) } : {}) }));
    const promptTokens = Number(totals.prompt_tokens ?? 0);
    const completionTokens = Number(totals.completion_tokens ?? 0);
    return {
      from: options.from, to: options.to, bucket: options.bucket,
      totals: {
        requests: Number(totals.requests ?? 0), successful: Number(totals.successful ?? 0), failed: Number(totals.failed ?? 0), cancelled: Number(totals.cancelled ?? 0), interrupted: Number(totals.interrupted ?? 0),
        promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
        tokenReportedRequests: Number(totals.token_reported_requests ?? 0), mediaJobs: Number(totals.media_jobs ?? 0), creditCostCents: Number(totals.credit_cost_cents ?? 0),
        ...(totals.average_queue_wait_ms !== null ? { averageQueueWaitMs: Number(totals.average_queue_wait_ms) } : {}),
        ...(totals.average_ttft_ms !== null ? { averageTtftMs: Number(totals.average_ttft_ms) } : {}),
        ...(totals.average_duration_ms !== null ? { averageDurationMs: Number(totals.average_duration_ms) } : {}),
      },
      timeline: timeline.map((row: any) => ({ timestamp: String(row.timestamp), requests: Number(row.requests), failed: Number(row.failed), interrupted: Number(row.interrupted), mediaJobs: Number(row.media_jobs), promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens) })),
      routes: breakdown("route_id", "route_id"),
      recipes: breakdown("COALESCE(recipe_id,'unknown')", "COALESCE(model_id,recipe_id,'Unknown recipe')"),
      modalities: breakdown("kind", "CASE kind WHEN 'chat' THEN 'Text' WHEN 'image' THEN 'Images' WHEN 'video' THEN 'Videos' ELSE 'Audio' END"),
    };
  }
}

function mapRequestUsage(row: RequestUsageRow): RequestUsageRecord {
  return {
    id: row.id, kind: row.kind, status: row.status, routeId: row.route_id,
    executionLane: row.execution_lane, enqueuedAt: row.enqueued_at, completedAt: row.completed_at,
    ...(row.recipe_id ? { recipeId: row.recipe_id } : {}), ...(row.playbook_id ? { playbookId: row.playbook_id } : {}),
    ...(row.adapter ? { adapter: row.adapter } : {}), ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}), ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.first_output_at ? { firstOutputAt: row.first_output_at } : {}), ...(row.queue_wait_ms !== null ? { queueWaitMs: row.queue_wait_ms } : {}),
    ...(row.ttft_ms !== null ? { ttftMs: row.ttft_ms } : {}), ...(row.generation_ms !== null ? { generationMs: row.generation_ms } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}), ...(row.prompt_tokens !== null ? { promptTokens: row.prompt_tokens } : {}),
    ...(row.completion_tokens !== null ? { completionTokens: row.completion_tokens } : {}), ...(row.credit_cost_cents !== null ? { creditCostCents: row.credit_cost_cents } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}), metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}
