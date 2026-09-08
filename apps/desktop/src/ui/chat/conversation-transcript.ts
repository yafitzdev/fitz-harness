import { estimateTranscriptContext } from "../../context-estimate.js";
import { TranscriptWindow } from "./transcript-window.js";
import type { MessageAttachment, TranscriptMessageMetadata } from "./conversation-message-feed.js";
import { chatContentDocument } from "@fitz/protocol";

type Json = Record<string, any>;

export interface TranscriptActivity {
  clear(): void;
  isolateHistory?(render: () => void): void;
  finishWork?(completedAt?: string, boundary?: "completed" | "next-message"): void;
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
  registerGeneratedFile?: (path: string, action: "edited" | "created") => void;
  appendMessage: (role: string, text: string, createdAt?: string, runId?: string, attachments?: readonly MessageAttachment[], metadata?: TranscriptMessageMetadata) => HTMLElement;
  appendCommentary: (text: string, createdAt?: string) => HTMLElement;
  rebuildHistory: (messages: string[]) => void;
  resetPlan?: () => void;
  loadEarlier?: (beforeSequence: number) => Promise<{ data: Json[]; page?: TranscriptPageState }>;
}

export interface TranscriptPageState { hasEarlier?: boolean; estimatedContextTokens?: number }

/** Restores a persisted transcript into the conversation feed. */
export class ConversationTranscript {
  readonly #options: ConversationTranscriptOptions;
  readonly #runSequences = new Map<string, number>();
  readonly #window = new TranscriptWindow();
  #hasServerHistory = false;
  #estimatedContextTokens: number | undefined;
  #generation = 0;
  #loadingEarlierGeneration: number | undefined;

  constructor(options: ConversationTranscriptOptions) {
    this.#options = options;
    // Older transcript pages are an implementation detail, not a chat event.
    // Pull them in when the user reaches the top instead of inserting a
    // "Show earlier events" control into the conversation.
    this.#options.messages.addEventListener("scroll", () => {
      if (this.#options.messages.scrollTop <= 64) void this.#expandEarlier();
    }, { passive: true });
  }

  restore(entries: Json[], page: TranscriptPageState = {}): number {
    this.#generation += 1;
    this.#loadingEarlierGeneration = undefined;
    this.#runSequences.clear();
    this.#hasServerHistory = page.hasEarlier === true;
    this.#estimatedContextTokens = Number.isFinite(Number(page.estimatedContextTokens)) ? Number(page.estimatedContextTokens) : undefined;
    this.#recordSequences(entries);
    this.#render(this.#window.reset(entries));
    this.#rebuildHistory();
    return this.#estimatedContextTokens ?? estimateTranscriptContext(entries);
  }

  #render(entries: readonly Json[]): void {
    this.#options.messages.replaceChildren(); this.#options.activity.clear(); this.#options.resetPlan?.();
    const tools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
    const planToolCalls = new Set<string>();
    for (const entry of entries) {
      this.#restoreEntry(entry, tools, planToolCalls);
    }
  }

  eventSequenceForRun(runId: string): number { return this.#runSequences.get(runId) ?? 0; }

  /** Removes a discarded branch from the given transcript sequence onward. */
  truncateFrom(sequence: number): void {
    if (!Number.isFinite(sequence)) return;
    this.#window.truncateFrom(sequence);
    this.#runSequences.clear();
    this.#recordSequences(this.#window.entries);
    this.#rebuildHistory();
  }

  async #expandEarlier(): Promise<void> {
    const generation = this.#generation;
    if (this.#loadingEarlierGeneration === generation || (this.#window.hiddenCount === 0 && !this.#hasServerHistory)) return;
    this.#loadingEarlierGeneration = generation;
    try {
      if (this.#window.hiddenCount > 0) {
        const previousLength = this.#window.visible.length;
        const expanded = this.#window.expand();
        this.#prepend(expanded.slice(0, Math.max(0, expanded.length - previousLength)));
      } else if (this.#hasServerHistory && this.#options.loadEarlier && this.#window.oldestSequence !== undefined) {
        const response = await this.#options.loadEarlier(this.#window.oldestSequence);
        if (generation !== this.#generation) return;
        this.#hasServerHistory = response.page?.hasEarlier === true;
        this.#recordSequences(response.data);
        this.#window.prepend(response.data);
        this.#prepend(response.data);
      }
      if (generation !== this.#generation) return;
      this.#rebuildHistory();
    } catch { /* Keep the current bounded page; the next top scroll retries. */ }
    finally {
      if (this.#loadingEarlierGeneration === generation) this.#loadingEarlierGeneration = undefined;
    }
  }

  /** Restores only the newly revealed prefix. Existing nodes stay connected so
   * live projectors, message actions, media cards, and later turns retain their
   * identity and event listeners. */
  #prepend(entries: readonly Json[]): void {
    if (entries.length === 0) return;
    // Measure at insertion time. A server page can arrive while live output is
    // still growing at the bottom or after the user has moved the viewport.
    const oldHeight = this.#options.messages.scrollHeight;
    const oldTop = this.#options.messages.scrollTop;
    const existing = new Set(this.#options.messages.childNodes);
    const anchor = this.#options.messages.firstChild;
    const render = () => {
      const tools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
      const planToolCalls = new Set<string>();
      for (const entry of entries) this.#restoreEntry(entry, tools, planToolCalls);
    };
    if (this.#options.activity.isolateHistory) this.#options.activity.isolateHistory(render);
    else render();
    const fragment = document.createDocumentFragment();
    for (const node of [...this.#options.messages.childNodes]) {
      if (!existing.has(node)) fragment.append(node);
    }
    this.#options.messages.insertBefore(fragment, anchor);
    this.#options.messages.scrollTop = oldTop + this.#options.messages.scrollHeight - oldHeight;
  }

  #recordSequences(entries: readonly Json[]): void {
    for (const entry of entries) {
      const runId = typeof entry.content?.runId === "string" ? entry.content.runId : undefined;
      const eventSequence = Number(entry.content?.eventSequence);
      if (runId && Number.isFinite(eventSequence)) this.#runSequences.set(runId, Math.max(this.#runSequences.get(runId) ?? 0, eventSequence));
    }
  }

  #rebuildHistory(): void {
    this.#options.rebuildHistory(this.#window.visible
      .filter((entry) => entry.kind === "message" && entry.role === "user" && typeof entry.content?.text === "string" && entry.content.text.length > 0)
      .map((entry) => entry.content.text as string));
  }

  #restoreEntry(entry: Json, tools: Map<string, { row: HTMLElement; toolName: string; input: unknown }>, planToolCalls: Set<string>): void {
    if (entry.kind === "message") {
      const text = String(entry.content?.text ?? "");
      if (entry.role === "assistant" && entry.content?.phase === "commentary") this.#options.appendCommentary(text, entry.createdAt);
      else {
        this.#options.activity.finishWork?.(entry.createdAt, entry.role === "user" ? "next-message" : "completed");
        const runId = typeof entry.content?.runId === "string" ? entry.content.runId : undefined;
        const attachments = Array.isArray(entry.content?.attachments) ? entry.content.attachments as MessageAttachment[] : [];
        const document = entry.role === "assistant" ? chatContentDocument(entry.content ?? {}) : undefined;
        const metadata: TranscriptMessageMetadata = {
          ...(typeof entry.id === "string" ? { id: entry.id } : {}),
          ...(Number.isFinite(Number(entry.sequence)) ? { sequence: Number(entry.sequence) } : {}),
          ...(document ? { document } : {}),
        };
        const hasMetadata = Object.keys(metadata).length > 0;
        if (attachments.length) {
          if (hasMetadata) this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt, runId, attachments, metadata);
          else this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt, runId, attachments);
        } else if (runId) {
          if (hasMetadata) this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt, runId, undefined, metadata);
          else this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt, runId);
        } else if (hasMetadata) this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt, undefined, undefined, metadata);
        else this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt);
      }
      return;
    }
    if (entry.kind === "tool-call") {
      const toolCallId = String(entry.content?.toolCallId ?? entry.id);
      const toolName = String(entry.content?.toolName ?? "tool");
      const input = entry.content?.input;
      if (toolName === "agent_plan") { planToolCalls.add(toolCallId); return; }
      tools.set(toolCallId, { row: this.#options.activity.appendTool(toolName, input, toolCallId, true, entry.createdAt), toolName, input });
      return;
    }
    if (entry.kind === "tool-result") {
      const toolCallId = String(entry.content?.toolCallId ?? entry.id);
      const existing = tools.get(toolCallId);
      const toolName = planToolCalls.has(toolCallId) ? "agent_plan" : existing?.toolName ?? String(entry.content?.toolName ?? "tool");
      if (toolName === "agent_plan") {
        planToolCalls.delete(toolCallId);
        return;
      }
      const input = existing?.input;
      const row = existing?.row ?? this.#options.activity.appendTool(toolName, undefined, toolCallId, true, entry.createdAt);
      this.#options.activity.completeTool(row, toolName, input, entry.content?.result, Boolean(entry.content?.isError), entry.createdAt);
      const generatedPath = input && typeof input === "object" ? (input as Record<string, unknown>).path : undefined;
      if (!entry.content?.isError && (toolName === "write" || toolName === "edit") && typeof generatedPath === "string") {
        this.#options.registerGeneratedFile?.(generatedPath, toolName === "write" ? "created" : "edited");
      }
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
