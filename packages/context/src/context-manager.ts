import { randomUUID } from "node:crypto";
import type { AgentRunRequest, ChatContentPart, ChatMessage, TranscriptEntryRecord } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";

export interface ContextBudgetPolicy { compactionThreshold: number; reserveOutputTokens: number; recentTokenFraction: number }
export interface ContextPreparation { request: AgentRunRequest; compacted: boolean; estimatedInputTokens: number; budgetTokens: number; originalMessageCount: number; estimatedContextTokens: number }
export interface ManualCompactionResult { entry: TranscriptEntryRecord; originalMessageCount: number; estimatedInputTokens: number; estimatedContextTokens: number }
export interface ContextSummarizer { summarize(messages: readonly ChatMessage[], maxTokens: number): Promise<string> }
export const DEFAULT_CONTEXT_POLICY: ContextBudgetPolicy = { compactionThreshold: 0.8, reserveOutputTokens: 8192, recentTokenFraction: 0.5 };

export class ContextManager {
  readonly #policy: ContextBudgetPolicy;
  constructor(private readonly store: SqliteStore, private readonly summarizer: ContextSummarizer = new DeterministicSummarizer(), policy: Partial<ContextBudgetPolicy> = {}) { this.#policy = { ...DEFAULT_CONTEXT_POLICY, ...policy }; validatePolicy(this.#policy); }
  estimate(messages: readonly ChatMessage[]): number { return messages.reduce((total, message) => total + 4 + Math.ceil(contentCharLength(message.content) / 4), 2); }
  /** Full session context weight: every message, reasoning block, tool call, and tool result since the last compaction checkpoint (manual or automatic), plus the checkpoint summary. Mirrors the renderer's context meter so the compaction trigger and the displayed estimate agree. */
  estimateSessionActivity(entries: readonly TranscriptEntryRecord[]): number {
    const checkpoint = findCheckpoint(entries);
    const throughSequence = checkpoint ? Number(checkpoint.content.throughSequence) : -1;
    let total = 0;
    if (checkpoint) total += this.estimate([{ role: "system", content: `Conversation summary:\n${checkpoint.content.summary as string}` }]);
    for (const entry of entries) {
      if (entry.sequence <= throughSequence) continue;
      if (entry.kind === "message" || entry.kind === "reasoning" || entry.kind === "system") {
        if (typeof entry.content.text === "string") total += this.estimate([{ role: entry.role ?? "assistant", content: entry.content.text }]);
      } else if (entry.kind === "tool-call") {
        total += this.estimate([{ role: "tool", content: stringifyContent(entry.content.input) }]);
      } else if (entry.kind === "tool-result") {
        total += this.estimate([{ role: "tool", content: stringifyContent(entry.content.result) }]);
      }
    }
    return total;
  }
  estimateSession(sessionId: string): number { return this.estimateSessionActivity(sessionContextEntries(this.store, sessionId)); }
  async prepare(request: AgentRunRequest, contextTokens: number): Promise<ContextPreparation> {
    const entries = request.sessionId ? sessionContextEntries(this.store, request.sessionId) : [];
    const canonical = request.sessionId ? [...sessionContextMessages(entries), ...request.messages] : [...request.messages];
    const outputReserve = Math.max(request.maxTokens ?? this.#policy.reserveOutputTokens, this.#policy.reserveOutputTokens); const budgetTokens = Math.max(128, Math.floor(contextTokens * this.#policy.compactionThreshold) - outputReserve); const estimatedInputTokens = this.estimate(request.messages) + (request.sessionId ? this.estimateSessionActivity(entries) : 0);
    if (estimatedInputTokens <= budgetTokens) return { request: { ...request, messages: canonical }, compacted: false, estimatedInputTokens, budgetTokens, originalMessageCount: canonical.length, estimatedContextTokens: estimatedInputTokens };
    const recentBudget = Math.max(64, Math.floor(budgetTokens * this.#policy.recentTokenFraction)); const recent: ChatMessage[] = []; let recentTokens = 0; let split = canonical.length;
    while (split > 0) { const candidate = canonical[split - 1]!; const tokens = this.estimate([candidate]); if (recent.length > 0 && recentTokens + tokens > recentBudget) break; recent.unshift(candidate); recentTokens += tokens; split -= 1; if (recentTokens >= recentBudget) break; }
    const older = canonical.slice(0, split); const summaryBudget = Math.max(32, budgetTokens - recentTokens - 8); const summary = await this.summarizer.summarize(older, summaryBudget); const messages: ChatMessage[] = [{ role: "system", content: `Conversation summary:\n${summary}` }, ...recent];
    if (request.sessionId) {
      // Automatic compactions are durable checkpoints too: they record how far the summary
      // reaches (throughSequence) so the next run rebuilds context from summary + recent
      // instead of re-sending the full history and re-compacting on every run.
      const transcriptRecentCount = Math.max(0, recent.length - request.messages.length);
      const throughSequence = lastSummarizedSequence(entries, findCheckpoint(entries), transcriptRecentCount);
      this.store.appendTranscriptEntry({ id: randomUUID(), sessionId: request.sessionId, kind: "compaction", role: "system", content: { summary, manual: false, throughSequence, originalMessageCount: canonical.length, compactedMessageCount: older.length, estimatedInputTokens, budgetTokens }, createdAt: new Date().toISOString() });
    }
    return { request: { ...request, messages }, compacted: true, estimatedInputTokens, budgetTokens, originalMessageCount: canonical.length, estimatedContextTokens: this.estimate(messages) };
  }
  async compactSession(sessionId: string, contextTokens: number): Promise<ManualCompactionResult> {
    const entries = allTranscriptEntries(this.store, sessionId); const messages = transcriptMessages(entries);
    if (messages.length === 0) throw new TypeError("The session has no conversation to compact");
    const estimatedInputTokens = this.estimate(messages); const summaryBudget = Math.max(128, Math.min(4096, Math.floor(contextTokens * 0.2))); const summary = await this.summarizer.summarize(messages, summaryBudget); const throughSequence = entries.at(-1)?.sequence ?? 0;
    const entry = this.store.appendTranscriptEntry({ id: randomUUID(), sessionId, kind: "compaction", role: "system", content: { summary, manual: true, throughSequence, originalMessageCount: messages.length, compactedMessageCount: messages.length, estimatedInputTokens, budgetTokens: contextTokens }, createdAt: new Date().toISOString() });
    // Recalculate from the durable checkpoint rather than returning only the
    // summary's size. This includes any entries that raced the compaction and
    // makes the value identical to the transcript endpoint and context meter.
    return { entry, originalMessageCount: messages.length, estimatedInputTokens, estimatedContextTokens: this.estimateSession(sessionId) };
  }
}

export class DeterministicSummarizer implements ContextSummarizer { async summarize(messages: readonly ChatMessage[], maxTokens: number): Promise<string> { const text = messages.map((message) => `[${message.role}] ${extractText(message.content)}`).join("\n"); const maxChars = maxTokens * 4; return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 16))}\n[truncated]`; } }
function extractText(content: string | ChatContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text).join(" ");
}
function contentCharLength(content: string | ChatContentPart[]): number {
  if (typeof content === "string") return content.length;
  return content.filter((p) => p.type === "text").reduce((t, p) => t + (p.text ?? "").length, 0);
}
interface SemanticTranscriptMessage { sequence: number; message: ChatMessage }

/**
 * Reconstruct only the semantic conversation seen by the next model run. Ordinary tool
 * traffic stays out of model history, but a durable media handoff is also the terminal
 * assistant action for its turn: the Pi run deliberately ends once the asynchronous job
 * has been accepted. Representing that handoff as an assistant message prevents the next
 * request from seeing a stack of apparently unanswered media prompts.
 */
function semanticTranscriptMessages(entries: readonly TranscriptEntryRecord[]): SemanticTranscriptMessage[] {
  return entries.flatMap((entry): SemanticTranscriptMessage[] => {
    if (entry.kind === "message" && entry.role && typeof entry.content.text === "string") {
      return [{ sequence: entry.sequence, message: { role: entry.role, content: entry.content.text } }];
    }
    const mediaHandoff = mediaHandoffMessage(entry);
    return mediaHandoff ? [{ sequence: entry.sequence, message: mediaHandoff }] : [];
  });
}

function transcriptMessages(entries: readonly TranscriptEntryRecord[]): ChatMessage[] {
  return semanticTranscriptMessages(entries).map(({ message }) => message);
}

function mediaHandoffMessage(entry: TranscriptEntryRecord): ChatMessage | undefined {
  if (entry.kind !== "tool-result") return undefined;
  const toolName = entry.content.toolName;
  if (toolName !== "generate_image" && toolName !== "generate_video" && toolName !== "generate_audio") return undefined;
  const result = asRecord(entry.content.result);
  const details = asRecord(result?.details);
  const jobId = details?.mediaJobId;
  if (typeof jobId !== "string" || !jobId.trim()) return undefined;
  const rawStatus = details?.status;
  const status = typeof rawStatus === "string" && rawStatus.trim() ? rawStatus.trim() : "accepted";
  const modality = toolName.slice("generate_".length);
  return {
    role: "assistant",
    content: `Media generation handoff accepted: submitted asynchronous ${modality} job ${jobId} (status: ${status}). The preceding user request is being handled asynchronously and is not awaiting an assistant response.`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function allTranscriptEntries(store: SqliteStore, sessionId: string): TranscriptEntryRecord[] { const entries: TranscriptEntryRecord[] = []; let after = 0; while (true) { const page = store.transcriptAfter(sessionId, after, 1000); entries.push(...page); if (page.length < 1000) return entries; after = page.at(-1)!.sequence; } }
function sessionContextEntries(store: SqliteStore, sessionId: string): TranscriptEntryRecord[] {
  const checkpoint = store.latestTranscriptCompaction(sessionId);
  if (!checkpoint) return allTranscriptEntries(store, sessionId);
  const throughSequence = Number(checkpoint.content.throughSequence);
  if (!Number.isFinite(throughSequence)) return allTranscriptEntries(store, sessionId);
  const entries: TranscriptEntryRecord[] = [checkpoint];
  let after = throughSequence;
  while (true) {
    const page = store.transcriptAfter(sessionId, after, 1000);
    entries.push(...page.filter((entry) => entry.id !== checkpoint.id));
    if (page.length < 1000) return entries;
    after = page.at(-1)!.sequence;
  }
}
function sessionContextMessages(entries: readonly TranscriptEntryRecord[]): ChatMessage[] {
  const checkpoint = findCheckpoint(entries);
  if (!checkpoint) return transcriptMessages(entries);
  return [{ role: "system", content: `Conversation summary:\n${checkpoint.content.summary as string}` }, ...transcriptMessages(entries.filter((entry) => entry.sequence > Number(checkpoint.content.throughSequence)))];
}
/** The last durable compaction checkpoint: manual or automatic, as long as it carries a summary and a through-sequence boundary. */
function findCheckpoint(entries: readonly TranscriptEntryRecord[]): TranscriptEntryRecord | undefined {
  return entries.findLast((entry) => entry.kind === "compaction" && typeof entry.content.summary === "string" && Number.isFinite(Number(entry.content.throughSequence)));
}
/** Sequence of the last transcript entry fully covered by the summary: everything up to here (including interleaved tool activity) is checkpointed. */
function lastSummarizedSequence(entries: readonly TranscriptEntryRecord[], checkpoint: TranscriptEntryRecord | undefined, transcriptRecentCount: number): number {
  const afterCheckpoint = checkpoint ? entries.filter((entry) => entry.sequence > Number(checkpoint.content.throughSequence)) : entries;
  const messageEntries = semanticTranscriptMessages(afterCheckpoint);
  const floor = checkpoint ? Number(checkpoint.content.throughSequence) : 0;
  const recentIndex = Math.max(0, messageEntries.length - transcriptRecentCount);
  if (recentIndex === 0) return Math.max(floor, afterCheckpoint.at(-1)?.sequence ?? floor);
  return Math.max(floor, messageEntries[recentIndex - 1]!.sequence);
}
function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
function validatePolicy(policy: ContextBudgetPolicy): void { if (!(policy.compactionThreshold > 0 && policy.compactionThreshold <= 1)) throw new Error("compactionThreshold must be within (0, 1]"); if (!(policy.recentTokenFraction > 0 && policy.recentTokenFraction < 1)) throw new Error("recentTokenFraction must be within (0, 1)"); if (!Number.isInteger(policy.reserveOutputTokens) || policy.reserveOutputTokens < 0) throw new Error("reserveOutputTokens must be a non-negative integer"); }
