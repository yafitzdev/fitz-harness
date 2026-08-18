import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ForensicsPersistenceError,
  ForensicsPersistenceOperation,
  InferenceEvidenceRecord,
} from "@fitz/protocol";

interface PersistenceErrorRow {
  id: string;
  timestamp: string;
  operation: ForensicsPersistenceOperation;
  session_id: string | null;
  request_ids_json: string;
  error_name: string;
  error_message: string;
}

const MAX_MEMORY_ERRORS = 1_000;
const MAX_ACTIVE_REQUESTS = 10_000;

/**
 * Records evidence-persistence health without letting diagnostics break
 * inference. SQLite is attempted first for restart durability; the bounded
 * memory copy remains authoritative when SQLite is the component that failed.
 */
export class ForensicsPersistenceTracker {
  readonly #requestSessions = new Map<string, string>();
  readonly #memoryErrors: ForensicsPersistenceError[] = [];

  constructor(private readonly database: DatabaseSync) {}

  observe(record: Pick<InferenceEvidenceRecord, "id" | "sessionId">): void {
    if (!record.sessionId) return;
    this.#requestSessions.delete(record.id);
    this.#requestSessions.set(record.id, record.sessionId);
    while (this.#requestSessions.size > MAX_ACTIVE_REQUESTS) {
      const oldest = this.#requestSessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#requestSessions.delete(oldest);
    }
  }

  forget(requestId: string): void { this.#requestSessions.delete(requestId); }

  record(operation: ForensicsPersistenceOperation, requestIds: readonly string[], error: unknown, explicitSessionId?: string): ForensicsPersistenceError {
    const normalizedIds = [...new Set(requestIds.filter(Boolean))];
    const inferredSessions = [...new Set(normalizedIds.flatMap((id) => {
      const sessionId = this.#requestSessions.get(id);
      return sessionId ? [sessionId] : [];
    }))];
    const sessionId = explicitSessionId ?? (inferredSessions.length === 1 ? inferredSessions[0] : undefined);
    const failure: ForensicsPersistenceError = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      ...(sessionId ? { sessionId } : {}),
      requestIds: normalizedIds,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    this.#memoryErrors.push(failure);
    if (this.#memoryErrors.length > MAX_MEMORY_ERRORS) this.#memoryErrors.splice(0, this.#memoryErrors.length - MAX_MEMORY_ERRORS);
    try {
      this.database.prepare(`
        INSERT INTO forensics_persistence_errors (
          id, timestamp, operation, session_id, request_ids_json, error_name, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        failure.id,
        failure.timestamp,
        failure.operation,
        failure.sessionId ?? null,
        JSON.stringify(failure.requestIds),
        failure.errorName,
        failure.errorMessage,
      );
    } catch {
      // The evidence write may have failed because SQLite itself is unhealthy.
      // Retain the bounded in-memory copy instead of recursively hiding this.
    }
    return failure;
  }

  listForSession(sessionId: string): ForensicsPersistenceError[] {
    const durable = this.#readDurable(sessionId);
    const merged = new Map(durable.map((failure) => [failure.id, failure]));
    for (const failure of this.#memoryErrors) if (failure.sessionId === sessionId) merged.set(failure.id, failure);
    return [...merged.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  }

  #readDurable(sessionId: string): ForensicsPersistenceError[] {
    try {
      const rows = this.database.prepare(`
        SELECT id, timestamp, operation, session_id, request_ids_json, error_name, error_message
        FROM forensics_persistence_errors WHERE session_id = ? ORDER BY timestamp, id
      `).all(sessionId) as unknown as PersistenceErrorRow[];
      return rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        operation: row.operation,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        requestIds: JSON.parse(row.request_ids_json) as string[],
        errorName: row.error_name,
        errorMessage: row.error_message,
      }));
    } catch {
      return [];
    }
  }
}
