import type { DatabaseSync } from "node:sqlite";
import type { SessionProjection, TranscriptEntryRecord } from "@fitz/protocol";

interface ProjectionRow {
  session_id: string;
  version: number;
  source_revision: number;
  source_transcript_sequence: number;
  transcript_entry_count: number;
  message_count: number;
  reasoning_count: number;
  tool_call_count: number;
  tool_result_count: number;
  compaction_count: number;
  latest_compaction_sequence: number | null;
  latest_compaction_through_sequence: number | null;
  updated_at: string;
}

interface SessionRevisionRow { transcript_revision: number }
interface ProjectionTranscriptRow { sequence: number; kind: TranscriptEntryRecord["kind"]; role: TranscriptEntryRecord["role"] | null; content_json: string }

const PROJECTION_COLUMNS = "session_id, version, source_revision, source_transcript_sequence, transcript_entry_count, message_count, reasoning_count, tool_call_count, tool_result_count, compaction_count, latest_compaction_sequence, latest_compaction_through_sequence, updated_at";
const PROJECTION_VERSION = 1;

/** Rebuildable session read model. It never replaces canonical transcript
 * reads: a revision mismatch triggers a synchronous rebuild from SQLite rows. */
export class SqliteSessionProjectionStore {
  constructor(private readonly database: DatabaseSync) {}

  get(sessionId: string): SessionProjection | undefined {
    const session = this.sessionRevision(sessionId);
    if (!session) return undefined;
    const row = this.database.prepare(`SELECT ${PROJECTION_COLUMNS} FROM session_projections WHERE session_id = ?`).get(sessionId) as ProjectionRow | undefined;
    if (row && row.source_revision === session.transcript_revision && row.version === PROJECTION_VERSION) return mapProjection(row);
    return this.rebuild(sessionId);
  }

  rebuild(sessionId: string): SessionProjection | undefined {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.sessionRevision(sessionId);
      if (!session) {
        if (ownsTransaction) this.database.exec("COMMIT");
        return undefined;
      }
      const sourceRevision = session.transcript_revision;
      const rows = this.database
        .prepare("SELECT sequence, kind, role, content_json FROM transcript_entries WHERE session_id = ? ORDER BY sequence")
        .all(sessionId) as unknown as ProjectionTranscriptRow[];
      const counts = { message: 0, reasoning: 0, toolCall: 0, toolResult: 0, compaction: 0 };
      let latestCompactionSequence: number | undefined;
      let latestCompactionThroughSequence: number | undefined;
      for (const row of rows) {
        if (row.kind === "message") counts.message += 1;
        if (row.kind === "reasoning") counts.reasoning += 1;
        if (row.kind === "tool-call") counts.toolCall += 1;
        if (row.kind === "tool-result") counts.toolResult += 1;
        if (row.kind !== "compaction") continue;
        counts.compaction += 1;
        const content = parseContent(row.content_json);
        const throughSequence = typeof content?.throughSequence === "number" && Number.isSafeInteger(content.throughSequence) && content.throughSequence >= 0
          ? content.throughSequence
          : undefined;
        if (latestCompactionSequence === undefined || row.sequence > latestCompactionSequence) {
          latestCompactionSequence = row.sequence;
          latestCompactionThroughSequence = throughSequence;
        }
      }
      const updatedAt = new Date().toISOString();
      this.database.prepare(`INSERT INTO session_projections (${PROJECTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET version = excluded.version, source_revision = excluded.source_revision, source_transcript_sequence = excluded.source_transcript_sequence, transcript_entry_count = excluded.transcript_entry_count, message_count = excluded.message_count, reasoning_count = excluded.reasoning_count, tool_call_count = excluded.tool_call_count, tool_result_count = excluded.tool_result_count, compaction_count = excluded.compaction_count, latest_compaction_sequence = excluded.latest_compaction_sequence, latest_compaction_through_sequence = excluded.latest_compaction_through_sequence, updated_at = excluded.updated_at`).run(
        sessionId,
        PROJECTION_VERSION,
        sourceRevision,
        rows.at(-1)?.sequence ?? 0,
        rows.length,
        counts.message,
        counts.reasoning,
        counts.toolCall,
        counts.toolResult,
        counts.compaction,
        latestCompactionSequence ?? null,
        latestCompactionThroughSequence ?? null,
        updatedAt,
      );
      if (ownsTransaction) this.database.exec("COMMIT");
      return {
        sessionId,
        version: PROJECTION_VERSION,
        sourceRevision,
        sourceTranscriptSequence: rows.at(-1)?.sequence ?? 0,
        transcriptEntryCount: rows.length,
        messageCount: counts.message,
        reasoningCount: counts.reasoning,
        toolCallCount: counts.toolCall,
        toolResultCount: counts.toolResult,
        compactionCount: counts.compaction,
        ...(latestCompactionSequence !== undefined ? { latestCompactionSequence } : {}),
        ...(latestCompactionThroughSequence !== undefined ? { latestCompactionThroughSequence } : {}),
        updatedAt,
      };
    } catch (error) {
      if (ownsTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private sessionRevision(sessionId: string): SessionRevisionRow | undefined {
    return this.database.prepare("SELECT transcript_revision FROM sessions WHERE id = ?").get(sessionId) as SessionRevisionRow | undefined;
  }
}

function parseContent(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function mapProjection(row: ProjectionRow): SessionProjection {
  return {
    sessionId: row.session_id,
    version: row.version,
    sourceRevision: row.source_revision,
    sourceTranscriptSequence: row.source_transcript_sequence,
    transcriptEntryCount: row.transcript_entry_count,
    messageCount: row.message_count,
    reasoningCount: row.reasoning_count,
    toolCallCount: row.tool_call_count,
    toolResultCount: row.tool_result_count,
    compactionCount: row.compaction_count,
    ...(row.latest_compaction_sequence !== null ? { latestCompactionSequence: row.latest_compaction_sequence } : {}),
    ...(row.latest_compaction_through_sequence !== null ? { latestCompactionThroughSequence: row.latest_compaction_through_sequence } : {}),
    updatedAt: row.updated_at,
  };
}
