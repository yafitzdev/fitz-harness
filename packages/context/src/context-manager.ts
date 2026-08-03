import { randomUUID } from "node:crypto";
import type { AgentRunRequest, ChatContentPart, ChatMessage, TranscriptEntryRecord } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";

export interface ContextBudgetPolicy { compactionThreshold: number; reserveOutputTokens: number; recentTokenFraction: number }
export interface ContextPreparation { request: AgentRunRequest; compacted: boolean; estimatedInputTokens: number; budgetTokens: number; originalMessageCount: number }
export interface ManualCompactionResult { entry: TranscriptEntryRecord; originalMessageCount: number; estimatedInputTokens: number; estimatedContextTokens: number }
export interface ContextSummarizer { summarize(messages: readonly ChatMessage[], maxTokens: number): Promise<string> }
export const DEFAULT_CONTEXT_POLICY: ContextBudgetPolicy = { compactionThreshold: 0.8, reserveOutputTokens: 8192, recentTokenFraction: 0.5 };

export class ContextManager {
  readonly #policy: ContextBudgetPolicy;
  constructor(private readonly store: SqliteStore, private readonly summarizer: ContextSummarizer = new DeterministicSummarizer(), policy: Partial<ContextBudgetPolicy> = {}) { this.#policy = { ...DEFAULT_CONTEXT_POLICY, ...policy }; validatePolicy(this.#policy); }
  estimate(messages: readonly ChatMessage[]): number { return messages.reduce((total, message) => total + 4 + Math.ceil(contentCharLength(message.content) / 4), 2); }
  async prepare(request: AgentRunRequest, contextTokens: number): Promise<ContextPreparation> {
    const canonical = request.sessionId ? [...sessionContextMessages(allTranscriptEntries(this.store, request.sessionId)), ...request.messages] : [...request.messages];
    const outputReserve = Math.max(request.maxTokens ?? this.#policy.reserveOutputTokens, this.#policy.reserveOutputTokens); const budgetTokens = Math.max(128, Math.floor(contextTokens * this.#policy.compactionThreshold) - outputReserve); const estimatedInputTokens = this.estimate(canonical);
    if (estimatedInputTokens <= budgetTokens) return { request: { ...request, messages: canonical }, compacted: false, estimatedInputTokens, budgetTokens, originalMessageCount: canonical.length };
    const recentBudget = Math.max(64, Math.floor(budgetTokens * this.#policy.recentTokenFraction)); const recent: ChatMessage[] = []; let recentTokens = 0; let split = canonical.length;
    while (split > 0) { const candidate = canonical[split - 1]!; const tokens = this.estimate([candidate]); if (recent.length > 0 && recentTokens + tokens > recentBudget) break; recent.unshift(candidate); recentTokens += tokens; split -= 1; if (recentTokens >= recentBudget) break; }
    const older = canonical.slice(0, split); const summaryBudget = Math.max(32, budgetTokens - recentTokens - 8); const summary = await this.summarizer.summarize(older, summaryBudget); const messages: ChatMessage[] = [{ role: "system", content: `Conversation summary:\n${summary}` }, ...recent];
    if (request.sessionId) this.store.appendTranscriptEntry({ id: randomUUID(), sessionId: request.sessionId, kind: "compaction", role: "system", content: { summary, originalMessageCount: canonical.length, compactedMessageCount: older.length, estimatedInputTokens, budgetTokens }, createdAt: new Date().toISOString() });
    return { request: { ...request, messages }, compacted: true, estimatedInputTokens, budgetTokens, originalMessageCount: canonical.length };
  }
  async compactSession(sessionId: string, contextTokens: number): Promise<ManualCompactionResult> {
    const entries = allTranscriptEntries(this.store, sessionId); const messages = transcriptMessages(entries);
    if (messages.length === 0) throw new TypeError("The session has no conversation to compact");
    const estimatedInputTokens = this.estimate(messages); const summaryBudget = Math.max(128, Math.min(4096, Math.floor(contextTokens * 0.2))); const summary = await this.summarizer.summarize(messages, summaryBudget); const throughSequence = entries.at(-1)?.sequence ?? 0;
    const entry = this.store.appendTranscriptEntry({ id: randomUUID(), sessionId, kind: "compaction", role: "system", content: { summary, manual: true, throughSequence, originalMessageCount: messages.length, compactedMessageCount: messages.length, estimatedInputTokens, budgetTokens: contextTokens }, createdAt: new Date().toISOString() });
    return { entry, originalMessageCount: messages.length, estimatedInputTokens, estimatedContextTokens: this.estimate([{ role: "system", content: `Conversation summary:\n${summary}` }]) };
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
function transcriptMessages(entries: readonly TranscriptEntryRecord[]): ChatMessage[] { return entries.filter((entry) => entry.kind === "message" && entry.role && typeof entry.content.text === "string").map((entry) => ({ role: entry.role!, content: entry.content.text as string })); }
function allTranscriptEntries(store: SqliteStore, sessionId: string): TranscriptEntryRecord[] { const entries: TranscriptEntryRecord[] = []; let after = 0; while (true) { const page = store.transcriptAfter(sessionId, after, 1000); entries.push(...page); if (page.length < 1000) return entries; after = page.at(-1)!.sequence; } }
function sessionContextMessages(entries: readonly TranscriptEntryRecord[]): ChatMessage[] {
  const checkpoint = entries.findLast((entry) => entry.kind === "compaction" && entry.content.manual === true && typeof entry.content.summary === "string" && typeof entry.content.throughSequence === "number");
  if (!checkpoint) return transcriptMessages(entries);
  return [{ role: "system", content: `Conversation summary:\n${checkpoint.content.summary as string}` }, ...transcriptMessages(entries.filter((entry) => entry.sequence > Number(checkpoint.content.throughSequence)))];
}
function validatePolicy(policy: ContextBudgetPolicy): void { if (!(policy.compactionThreshold > 0 && policy.compactionThreshold <= 1)) throw new Error("compactionThreshold must be within (0, 1]"); if (!(policy.recentTokenFraction > 0 && policy.recentTokenFraction < 1)) throw new Error("recentTokenFraction must be within (0, 1)"); if (!Number.isInteger(policy.reserveOutputTokens) || policy.reserveOutputTokens < 0) throw new Error("reserveOutputTokens must be a non-negative integer"); }
