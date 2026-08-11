import { estimateTranscriptContext } from "../../context-estimate.js";
import { TranscriptWindow } from "./transcript-window.js";

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
  appendMessage: (role: string, text: string, createdAt?: string, runId?: string) => HTMLElement;
  appendCommentary: (text: string, createdAt?: string) => HTMLElement;
  rebuildHistory: (messages: string[]) => void;
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

  constructor(options: ConversationTranscriptOptions) { this.#options = options; }

  restore(entries: Json[], page: TranscriptPageState = {}): number {
    this.#runSequences.clear();
    this.#hasServerHistory = page.hasEarlier === true;
    this.#estimatedContextTokens = Number.isFinite(Number(page.estimatedContextTokens)) ? Number(page.estimatedContextTokens) : undefined;
    this.#recordSequences(entries);
    this.#render(this.#window.reset(entries));
    this.#rebuildHistory();
    return this.#estimatedContextTokens ?? estimateTranscriptContext(entries);
  }

  #render(entries: readonly Json[]): void {
    this.#options.messages.replaceChildren(); this.#options.activity.clear();
    const tools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
    for (const entry of entries) {
      this.#restoreEntry(entry, tools);
    }
    if (this.#window.hiddenCount > 0 || this.#hasServerHistory) this.#options.messages.prepend(this.#earlierButton());
  }

  eventSequenceForRun(runId: string): number { return this.#runSequences.get(runId) ?? 0; }

  #earlierButton(): HTMLButtonElement {
    const button = document.createElement("button"); button.type = "button"; button.className = "transcript-load-earlier"; button.textContent = "Show earlier events";
    button.addEventListener("click", () => { void this.#expandEarlier(button) });
    return button;
  }

  async #expandEarlier(button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    const oldHeight = this.#options.messages.scrollHeight;
    const oldTop = this.#options.messages.scrollTop;
    try {
      if (this.#window.hiddenCount > 0) {
        this.#render(this.#window.expand());
      } else if (this.#hasServerHistory && this.#options.loadEarlier && this.#window.oldestSequence !== undefined) {
        const response = await this.#options.loadEarlier(this.#window.oldestSequence);
        this.#hasServerHistory = response.page?.hasEarlier === true;
        this.#recordSequences(response.data);
        this.#render(this.#window.prepend(response.data));
      }
      this.#rebuildHistory();
      this.#options.messages.scrollTop = oldTop + this.#options.messages.scrollHeight - oldHeight;
    } catch {
      button.textContent = "Could not load earlier events";
      button.disabled = false;
    }
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

  #restoreEntry(entry: Json, tools: Map<string, { row: HTMLElement; toolName: string; input: unknown }>): void {
    if (entry.kind === "message") {
      const text = String(entry.content?.text ?? "");
      if (entry.role === "assistant" && entry.content?.phase === "commentary") this.#options.appendCommentary(text, entry.createdAt);
      else {
        const runId = typeof entry.content?.runId === "string" ? entry.content.runId : undefined;
        if (runId) this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt, runId);
        else this.#options.appendMessage(entry.role ?? "system", text, entry.createdAt);
      }
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
