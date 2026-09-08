type Json = Record<string, any>;

/** Coarse token estimate for the context meter: roughly 4 characters per token. */
export function estimateTokens(value: string): number { return value ? Math.max(1, Math.ceil(value.length / 4)) : 0; }

/**
 * Estimates how much model context a session's transcript has consumed, counting
 * everything the agent actually processes: user/assistant text, reasoning, tool
 * call arguments, and tool results (file reads, command output, search results).
 * A manual compaction checkpoint replaces everything before it with the summary;
 * checkpoint: the last compaction entry with a summary and a through-sequence boundary,
 * whether it was manual or automatic, matching the host ContextManager.
 */
export function estimateTranscriptContext(entries: Json[]): number {
  const checkpoint = [...entries].reverse().find((entry) => entry.kind === "compaction" && typeof entry.content?.summary === "string" && Number.isFinite(Number(entry.content?.throughSequence))
    && !(entry.content.manual === false && entry.content.compactedMessageCount === 0 && entry.content.activityThroughSequence === undefined));
  const throughSequence = checkpoint ? Number(checkpoint.content.throughSequence) : -1;
  const activityThroughSequence = checkpoint ? Number(checkpoint.content.activityThroughSequence ?? throughSequence) : -1;
  let total = checkpoint?.content.summary ? estimateTokens(`Conversation summary:\n${checkpoint.content.summary}`) : 0;
  for (const entry of entries) {
    if (Number(entry.sequence) <= throughSequence) continue;
    if (entry.kind !== "message" && Number(entry.sequence) <= activityThroughSequence) continue;
    if (entry.kind === "message" || entry.kind === "reasoning" || entry.kind === "system") {
      if (typeof entry.content?.text === "string") total += estimateTokens(entry.content.text);
    } else if (entry.kind === "tool-call") {
      total += estimateTokens(safeStringify(entry.content?.input));
    } else if (entry.kind === "tool-result") {
      total += estimateTokens(safeStringify(entry.content?.result));
    }
  }
  return total;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
