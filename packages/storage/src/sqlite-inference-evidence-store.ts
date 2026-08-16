import type { DatabaseSync } from "node:sqlite";
import type { InferenceDelta, InferenceEvidenceDelta, InferenceEvidenceRecord } from "@fitz/protocol";

interface EvidenceRow {
  id: string;
  kind: "chat";
  status: InferenceEvidenceRecord["status"];
  route_id: string;
  recipe_id: string | null;
  adapter: string | null;
  model_id: string | null;
  owner_user_id: string | null;
  session_id: string | null;
  run_id: string | null;
  execution_lane: InferenceEvidenceRecord["executionLane"];
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  request_json: string;
  response_json: string | null;
  error_json: string | null;
  engine_json: string | null;
  metadata_json: string;
}

interface EvidenceDeltaRow {
  evidence_id: string;
  sequence: number;
  timestamp: string;
  delta_json: string;
}

/** Durable scheduler-boundary evidence. Evidence is diagnostic truth; the
 * compact request_usage table remains the analytics/reporting fact. */
export class SqliteInferenceEvidenceStore {
  constructor(private readonly database: DatabaseSync) {}

  record(record: InferenceEvidenceRecord): void {
    this.database.prepare(`
      INSERT INTO inference_evidence (
        id, kind, status, route_id, recipe_id, adapter, model_id, owner_user_id,
        session_id, run_id, execution_lane, enqueued_at, started_at, completed_at,
        request_json, response_json, error_json, engine_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        recipe_id = COALESCE(excluded.recipe_id, inference_evidence.recipe_id),
        adapter = COALESCE(excluded.adapter, inference_evidence.adapter),
        model_id = COALESCE(excluded.model_id, inference_evidence.model_id),
        owner_user_id = COALESCE(excluded.owner_user_id, inference_evidence.owner_user_id),
        session_id = COALESCE(excluded.session_id, inference_evidence.session_id),
        run_id = COALESCE(excluded.run_id, inference_evidence.run_id),
        execution_lane = excluded.execution_lane,
        started_at = COALESCE(excluded.started_at, inference_evidence.started_at),
        completed_at = COALESCE(excluded.completed_at, inference_evidence.completed_at),
        request_json = excluded.request_json,
        response_json = COALESCE(excluded.response_json, inference_evidence.response_json),
        error_json = COALESCE(excluded.error_json, inference_evidence.error_json),
        engine_json = COALESCE(excluded.engine_json, inference_evidence.engine_json),
        metadata_json = CASE WHEN excluded.metadata_json = '{}' THEN inference_evidence.metadata_json ELSE excluded.metadata_json END
    `).run(
      record.id,
      record.kind,
      record.status,
      record.routeId,
      record.recipeId ?? null,
      record.adapter ?? null,
      record.modelId ?? null,
      record.ownerUserId ?? null,
      record.sessionId ?? null,
      record.runId ?? null,
      record.executionLane,
      record.enqueuedAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      JSON.stringify(record.request),
      record.response === undefined ? null : JSON.stringify(record.response),
      record.error === undefined ? null : JSON.stringify(record.error),
      record.engine === undefined ? null : JSON.stringify(record.engine),
      JSON.stringify(record.metadata ?? {}),
    );
    for (const observed of record.observedDeltas ?? []) {
      this.recordDelta(record.id, observed.sequence, observed.delta, observed.timestamp);
    }
  }

  /** Appends one observed normalized adapter delta. This is intentionally a
   * separate write path: rewriting the whole response on every stream chunk
   * would be quadratic in output size, while an append-only row survives a
   * host crash between two terminal lifecycle updates. */
  recordDelta(evidenceId: string, sequence: number, delta: InferenceDelta, timestamp = new Date().toISOString()): void {
    if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError("Inference evidence delta sequence must be a positive integer");
    this.database.prepare(`
      INSERT INTO inference_evidence_deltas (evidence_id, sequence, timestamp, delta_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(evidence_id, sequence) DO UPDATE SET timestamp = excluded.timestamp, delta_json = excluded.delta_json
    `).run(evidenceId, sequence, timestamp, JSON.stringify(delta));
  }

  get(id: string): InferenceEvidenceRecord | undefined {
    const row = this.database.prepare(selectEvidence("WHERE id = ?")).get(id) as EvidenceRow | undefined;
    return row ? mapEvidence(row, this.listDeltas(id)) : undefined;
  }

  listForSession(sessionId: string): InferenceEvidenceRecord[] {
    const rows = this.database.prepare(selectEvidence("WHERE session_id = ? ORDER BY enqueued_at, id")).all(sessionId) as unknown as EvidenceRow[];
    return rows.map((row) => mapEvidence(row, this.listDeltas(row.id)));
  }

  listForRun(runId: string): InferenceEvidenceRecord[] {
    const rows = this.database.prepare(selectEvidence("WHERE run_id = ? ORDER BY enqueued_at, id")).all(runId) as unknown as EvidenceRow[];
    return rows.map((row) => mapEvidence(row, this.listDeltas(row.id)));
  }

  listDeltas(evidenceId: string): InferenceEvidenceDelta[] {
    const rows = this.database.prepare(`
      SELECT evidence_id, sequence, timestamp, delta_json
      FROM inference_evidence_deltas WHERE evidence_id = ? ORDER BY sequence
    `).all(evidenceId) as unknown as EvidenceDeltaRow[];
    return rows.map((row) => ({
      evidenceId: row.evidence_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      delta: JSON.parse(row.delta_json) as InferenceDelta,
    }));
  }

  /** Converts queued/running evidence to an explicit terminal fact after a
   * host restart. This operation is idempotent. */
  recoverInterrupted(): number {
    const now = new Date().toISOString();
    const error = JSON.stringify({ name: "HostRestarted", code: "host_restarted", message: "Host restarted before inference completed" });
    return Number(this.database.prepare(`
      UPDATE inference_evidence
      SET status = 'interrupted', completed_at = ?, error_json = COALESCE(error_json, ?)
      WHERE status IN ('queued', 'running')
    `).run(now, error).changes);
  }
}

function selectEvidence(suffix: string): string {
  return `SELECT id, kind, status, route_id, recipe_id, adapter, model_id, owner_user_id,
    session_id, run_id, execution_lane, enqueued_at, started_at, completed_at,
    request_json, response_json, error_json, engine_json, metadata_json
    FROM inference_evidence ${suffix}`;
}

function mapEvidence(row: EvidenceRow, observedDeltas: InferenceEvidenceDelta[] = []): InferenceEvidenceRecord {
  const storedResponse = row.response_json ? JSON.parse(row.response_json) as Record<string, unknown> : undefined;
  const response = observedDeltas.length
    ? { ...(storedResponse ?? {}), deltas: observedDeltas.map((item) => item.delta) }
    : storedResponse;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    routeId: row.route_id,
    executionLane: row.execution_lane,
    enqueuedAt: row.enqueued_at,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    ...(row.recipe_id ? { recipeId: row.recipe_id } : {}),
    ...(row.adapter ? { adapter: row.adapter } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(response ? { response } : {}),
    ...(observedDeltas.length ? { observedDeltas } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) as Record<string, unknown> } : {}),
    ...(row.engine_json ? { engine: JSON.parse(row.engine_json) as Record<string, unknown> } : {}),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}
