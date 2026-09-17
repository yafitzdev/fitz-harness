import type { DatabaseSync } from "node:sqlite";
import type { AgentEffort, SessionQueuedMessage, ToolAccessMode } from "@fitz/protocol";

interface QueueRow { id: string; session_id: string; text: string; request_json: string; created_at: string; updated_at: string }
type QueueRequest = Pick<SessionQueuedMessage, "model" | "effort" | "maxTokens" | "temperature" | "accessMode">;

/** Ordered, durable inbox for user turns that have not entered agent context. */
export class SqliteSessionMessageQueue {
  constructor(private readonly database: DatabaseSync) {}

  enqueue(message: Omit<SessionQueuedMessage, "createdAt" | "updatedAt">, timestamp: string): SessionQueuedMessage {
    this.database.prepare(`INSERT INTO session_message_queue (id, session_id, position, text, request_json, created_at, updated_at)
      VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM session_message_queue WHERE session_id = ?), 1), ?, ?, ?, ?)`)
      .run(message.id, message.sessionId, message.sessionId, message.text, JSON.stringify(requestOf(message)), timestamp, timestamp);
    return this.get(message.id)!;
  }

  list(sessionId: string): SessionQueuedMessage[] {
    return (this.database.prepare(`SELECT id, session_id, text, request_json, created_at, updated_at FROM session_message_queue WHERE session_id = ? ORDER BY position`).all(sessionId) as unknown as QueueRow[]).map(mapRow);
  }

  get(id: string): SessionQueuedMessage | undefined {
    const row = this.database.prepare(`SELECT id, session_id, text, request_json, created_at, updated_at FROM session_message_queue WHERE id = ?`).get(id) as QueueRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  update(id: string, text: string, timestamp: string): SessionQueuedMessage | undefined {
    this.database.prepare(`UPDATE session_message_queue SET text = ?, updated_at = ? WHERE id = ?`).run(text, timestamp, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    const position = (this.database.prepare(`SELECT session_id, position FROM session_message_queue WHERE id = ?`).get(id) as { session_id: string; position: number } | undefined);
    if (!position) return false;
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.database.prepare(`DELETE FROM session_message_queue WHERE id = ?`).run(id).changes > 0;
      if (removed) this.database.prepare(`UPDATE session_message_queue SET position = position - 1 WHERE session_id = ? AND position > ?`).run(position.session_id, position.position);
      if (ownsTransaction) this.database.exec("COMMIT");
      return removed;
    } catch (error) { if (ownsTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
}

function requestOf(message: QueueRequest): QueueRequest {
  return { model: message.model, effort: message.effort, maxTokens: message.maxTokens, temperature: message.temperature, accessMode: message.accessMode };
}
function mapRow(row: QueueRow): SessionQueuedMessage {
  const request = JSON.parse(row.request_json) as { model: string; effort: AgentEffort; maxTokens: number; temperature: number; accessMode: ToolAccessMode };
  return { id: row.id, sessionId: row.session_id, text: row.text, ...request, createdAt: row.created_at, updatedAt: row.updated_at };
}
