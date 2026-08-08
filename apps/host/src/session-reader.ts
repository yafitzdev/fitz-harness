import type { TranscriptEntryRecord } from "@fitz/protocol";
import type { PiSessionMessage, PiSessionReader } from "@fitz/agent-pi";
import type { SqliteStore } from "@fitz/storage";

/**
 * Store-backed adapter for the pi package's `PiSessionReader` contract. The pi package owns
 * the contract and the `fitz_session` tool; the host only supplies the data from the single
 * canonical store (SQLite). This is the one place transcripts become readable by the agent.
 *
 * Read-only by construction; owner scoping is not applied here because a local single-user
 * host serves its own agent. Scope per principal here if multi-user access is ever required.
 */
export function createSessionReader(store: SqliteStore, options: { maxEntries?: number } = {}): PiSessionReader {
  const defaultLimit = options.maxEntries ?? 200;
  return async (sessionId, lookup) => {
    const session = store.getSession(sessionId);
    if (!session) return undefined;
    const after = Math.max(0, Math.trunc(lookup?.after ?? 0));
    const limit = Math.min(Math.max(1, Math.trunc(lookup?.limit ?? defaultLimit)), 1000);
    const entries = store.transcriptAfter(sessionId, after, limit);
    return {
      title: session.title,
      status: session.status,
      updatedAt: session.updatedAt,
      messages: entries.flatMap((entry) => transcriptMessages(entry)),
    };
  };
}

function transcriptMessages(entry: TranscriptEntryRecord): PiSessionMessage[] {
  const content = entry.content as { text?: unknown; toolName?: unknown; input?: unknown; result?: unknown; summary?: unknown };
  switch (entry.kind) {
    case "message": {
      if ((entry.role === "user" || entry.role === "assistant") && typeof content.text === "string" && content.text.trim()) {
        return [{ sequence: entry.sequence, role: entry.role, text: content.text }];
      }
      return [];
    }
    case "tool-call":
      return [{ sequence: entry.sequence, role: "tool", text: `[tool] ${typeof content.toolName === "string" ? content.toolName : "unknown"}: ${summarizeValue(content.input)}` }];
    case "tool-result":
      return [{ sequence: entry.sequence, role: "tool", text: `[result] ${summarizeValue(content.result)}` }];
    case "compaction":
      return typeof content.summary === "string" && content.summary.trim()
        ? [{ sequence: entry.sequence, role: "system", text: `[context] ${content.summary}` }]
        : [];
    default:
      return [];
  }
}

function summarizeValue(value: unknown, maxChars = 500): string {
  if (value === undefined || value === null) return "(none)";
  const text = typeof value === "string" ? value : safeStringify(value);
  return truncate(text, maxChars);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
}
