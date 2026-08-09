import { estimateTranscriptContext } from "../../context-estimate.js";

type Json = Record<string, any>;

export interface TranscriptActivity {
  clear(): void;
  appendTool(toolName: string, input: unknown, toolCallId: string, running: boolean, createdAt?: string): HTMLElement;
  completeTool(row: HTMLElement, toolName: string, input: unknown, result: unknown, isError: boolean, completedAt?: string): void;
  appendReasoning(running: boolean, createdAt?: string): HTMLElement;
  appendReasoningDelta(row: HTMLElement, text: string): void;
  completeReasoning(row: HTMLElement): void;
  appendContext(label?: string, createdAt?: string): HTMLElement;
}

export interface ConversationTranscriptOptions {
  messages: HTMLElement;
  activity: TranscriptActivity;
  appendMessage: (role: string, text: string, createdAt?: string) => HTMLElement;
  appendCommentary: (text: string, createdAt?: string) => HTMLElement;
  rebuildHistory: (messages: string[]) => void;
}

/** Restores a persisted transcript into the conversation feed. */
export class ConversationTranscript {
  readonly #options: ConversationTranscriptOptions;
  readonly #runSequences = new Map<string, number>();

  constructor(options: ConversationTranscriptOptions) { this.#options = options; }

  restore(entries: Json[]): number {
    this.#runSequences.clear();
    this.#options.rebuildHistory(entries
      .filter((entry) => entry.kind === "message" && entry.role === "user" && typeof entry.content?.text === "string" && entry.content.text.length > 0)
      .map((entry) => entry.content.text as string));
    this.#options.messages.replaceChildren();
    this.#options.activity.clear();
    const tools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
    for (const entry of entries) {
      const runId = typeof entry.content?.runId === "string" ? entry.content.runId : undefined;
      const eventSequence = Number(entry.content?.eventSequence);
      if (runId && Number.isFinite(eventSequence)) this.#runSequences.set(runId, Math.max(this.#runSequences.get(runId) ?? 0, eventSequence));
      this.#restoreEntry(entry, tools);
    }
    return estimateTranscriptContext(entries);
  }

  eventSequenceForRun(runId: string): number { return this.#runSequences.get(runId) ?? 0; }

  #restoreEntry(entry: Json, tools: Map<string, { row: HTMLElement; toolName: string; input: unknown }>): void {
    if (entry.kind === "message") {
      const text = String(entry.content?.text ?? "");
      if (entry.role === "assistant" && entry.content?.phase === "commentary") this.#options.appendCommentary(text, entry.createdAt);
      else this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt);
      return;
    }
    if (entry.kind === "tool-call") {
      const toolCallId = String(entry.content?.toolCallId ?? entry.id);
      const toolName = String(entry.content?.toolName ?? "tool");
      const input = entry.content?.input;
      tools.set(toolCallId, { row: this.#options.activity.appendTool(toolName, input, toolCallId, true, entry.createdAt), toolName, input });
      return;
    }
    if (entry.kind === "tool-result") {
      const toolCallId = String(entry.content?.toolCallId ?? entry.id);
      const existing = tools.get(toolCallId);
      const toolName = existing?.toolName ?? String(entry.content?.toolName ?? "tool");
      const input = existing?.input;
      const row = existing?.row ?? this.#options.activity.appendTool(toolName, undefined, toolCallId, true, entry.createdAt);
      this.#options.activity.completeTool(row, toolName, input, entry.content?.result, Boolean(entry.content?.isError), entry.createdAt);
      return;
    }
    if (entry.kind === "reasoning") {
      const row = this.#options.activity.appendReasoning(false, entry.createdAt);
      this.#options.activity.appendReasoningDelta(row, String(entry.content?.text ?? ""));
      this.#options.activity.completeReasoning(row);
      return;
    }
    if (entry.kind === "compaction") this.#options.activity.appendContext(entry.content?.manual === true ? "Context compacted" : "Context automatically compacted", entry.createdAt);
  }
}
