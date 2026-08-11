import { createCopyButton } from "../primitives/copy-button.js";
import type { RequestUsageRecord } from "@fitz/protocol";

export type ActionableMessageRole = "user" | "assistant";

export interface MessageActionsOptions {
  canEdit: () => boolean;
  onEditBlocked: () => void;
  copyText: (text: string) => void | Promise<void>;
  resend: (text: string, article: HTMLElement) => void | Promise<void>;
}

/** Owns message metadata, copy actions, and in-bubble user-message editing. */
export class MessageActions {
  readonly #options: MessageActionsOptions;

  constructor(options: MessageActionsOptions) {
    this.#options = options;
  }

  attach(article: HTMLElement, content: HTMLElement, role: ActionableMessageRole, originalText: string, createdAt?: string): void {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const time = document.createElement("time");
    time.className = "message-time";
    time.dateTime = createdAt ?? new Date().toISOString();
    time.textContent = this.#formatTimestamp(createdAt);
    actions.append(time, this.#copyButton(content));
    if (role === "user") actions.append(this.#actionButton("Edit message", this.#editIcon(), () => this.#startEdit(article, content, actions, originalText)));
    article.append(actions);
  }

  setPerformance(content: HTMLElement, usage: RequestUsageRecord): void {
    const time = content.closest("article.message")?.querySelector<HTMLTimeElement>("time.message-time");
    if (!time) return;
    const timestamp = time.dataset.timestampLabel ?? time.textContent ?? "";
    time.dataset.timestampLabel = timestamp;
    const speed = tokenRate(usage.completionTokens, usage.generationMs);
    const compact = [timestamp];
    if (usage.ttftMs !== undefined) compact.push(`${formatDuration(usage.ttftMs)} TTFT`);
    if (speed !== undefined) compact.push(`${Math.round(speed)} tok/s`);
    if (usage.promptTokens !== undefined) compact.push(`${formatCompactNumber(usage.promptTokens)} ctx`);
    const model = usage.modelId ?? usage.recipeId;
    if (model) compact.push(model);
    time.textContent = compact.join(" · ");

    const details = [timestamp];
    if (model) details.push(`Model: ${model}`);
    if (usage.ttftMs !== undefined) details.push(`Time to first token: ${formatDuration(usage.ttftMs)}`);
    if (speed !== undefined) details.push(`Generation speed: ${Math.round(speed)} tok/s`);
    if (usage.promptTokens !== undefined) details.push(`Input tokens: ${formatInteger(usage.promptTokens)}`);
    if (usage.completionTokens !== undefined) details.push(`Output tokens: ${formatInteger(usage.completionTokens)}`);
    if (usage.queueWaitMs !== undefined) details.push(`Queue wait: ${formatDuration(usage.queueWaitMs)}`);
    if (usage.durationMs !== undefined) details.push(`Total model time: ${formatDuration(usage.durationMs)}`);
    time.title = details.join("\n");
  }

  #startEdit(article: HTMLElement, content: HTMLElement, actions: HTMLElement, originalText: string): void {
    if (!this.#options.canEdit()) { this.#options.onEditBlocked(); return; }
    const bubble = document.createElement("div");
    bubble.className = "message-edit-bubble";
    const editor = document.createElement("textarea");
    editor.className = "message-inline-editor";
    editor.value = originalText;
    editor.setAttribute("aria-label", "Edit message");
    const controls = document.createElement("div");
    controls.className = "message-edit-controls";
    const cancel = this.#textButton("Cancel", "message-edit-cancel");
    const send = this.#textButton("Send", "message-edit-send");
    const restore = () => { bubble.replaceWith(content); actions.hidden = false; article.classList.remove("editing"); };
    const submit = () => {
      const revised = editor.value.trim();
      if (!revised) { editor.focus(); return; }
      content.textContent = revised;
      restore();
      void this.#options.resend(revised, article);
    };
    cancel.addEventListener("click", restore);
    send.addEventListener("click", submit);
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); restore(); }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
    });
    controls.append(cancel, send);
    bubble.append(editor, controls);
    actions.hidden = true;
    article.classList.add("editing");
    content.replaceWith(bubble);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  #actionButton(label: string, icon: SVGElement, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-action";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon);
    button.addEventListener("click", action);
    return button;
  }

  #copyButton(content: HTMLElement): HTMLButtonElement {
    return createCopyButton({
      copyText: this.#options.copyText,
      value: () => content.innerText,
      title: "Copy message",
      className: "message-action",
    });
  }

  #textButton(label: string, className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  }

  #formatTimestamp(value?: string): string {
    const date = value ? new Date(value) : new Date();
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
    return `${weekday} ${time}`;
  }

  #icon(markup: string): SVGElement {
    const value = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    value.setAttribute("viewBox", "0 0 20 20");
    value.setAttribute("aria-hidden", "true");
    value.innerHTML = markup;
    return value;
  }

  #editIcon(): SVGElement { return this.#icon('<path d="m4.2 14.8.7-3.2 7.8-7.8a1.45 1.45 0 0 1 2.05 2.05L7 13.65z"></path><path d="m11.7 4.8 2.05 2.05"></path>'); }
}

function tokenRate(tokens: number | undefined, generationMs: number | undefined): number | undefined {
  return tokens !== undefined && generationMs !== undefined && generationMs > 0 ? tokens * 1_000 / generationMs : undefined;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  return `${seconds < 10 ? Number(seconds.toFixed(1)) : Math.round(seconds)}s`;
}

function formatInteger(value: number): string { return new Intl.NumberFormat().format(value); }

function formatCompactNumber(value: number): string {
  if (value < 1_000) return formatInteger(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return `${Number((value / 1_000_000).toFixed(1))}m`;
}
