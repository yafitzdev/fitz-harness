import type { SessionQueuedMessage } from "@fitz/protocol";
import type { PromptRunSettings } from "./prompt-submission.js";

type Json = Record<string, any>;

export interface SessionMessageQueueOptions {
  mount: HTMLElement;
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  sessionId: () => string | undefined;
  settings: () => PromptRunSettings;
  submit: (message: SessionQueuedMessage, onAccepted: () => void, onRejected: () => void) => void;
  steer: (text: string) => Promise<void>;
  isRunning: () => boolean;
  onError: (message: string) => void;
}

/** Visible projection and command surface for the durable session inbox. */
export class SessionMessageQueue {
  readonly element = document.createElement("section");
  readonly #options: SessionMessageQueueOptions;
  #items: SessionQueuedMessage[] = [];
  #dispatching: string | undefined;

  constructor(options: SessionMessageQueueOptions) {
    this.#options = options;
    this.element.className = "session-message-queue";
    this.element.hidden = true;
    options.mount.querySelector(".composer-shell")?.prepend(this.element);
  }

  reset(): void { this.#items = []; this.#dispatching = undefined; this.#render(); }
  refresh(): void { this.#render(); }

  async load(sessionId = this.#options.sessionId()): Promise<void> {
    if (!sessionId) { this.reset(); return; }
    const response = await this.#options.api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/message-queue`);
    if (this.#options.sessionId() !== sessionId) return;
    this.#items = Array.isArray(response.data) ? response.data as SessionQueuedMessage[] : [];
    this.#render();
  }

  async enqueue(text: string): Promise<void> {
    const sessionId = this.#options.sessionId(); const value = text.trim();
    if (!sessionId || !value) return;
    const settings = this.#options.settings();
    const response = await this.#options.api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/message-queue`, "POST", {
      text: value, model: settings.routeId, effort: settings.effort, maxTokens: settings.maxTokens,
      temperature: settings.temperature, accessMode: settings.accessMode,
    });
    if (this.#options.sessionId() !== sessionId) return;
    this.#items.push(response.data as SessionQueuedMessage);
    this.#render();
  }

  dispatchNext(): void {
    const item = this.#items[0];
    if (!item || this.#dispatching || this.#options.isRunning()) return;
    this.#dispatching = item.id; this.#render();
    this.#options.submit(item, () => { void this.#remove(item); }, () => { this.#dispatching = undefined; this.#render(); });
  }

  async #remove(item: SessionQueuedMessage): Promise<void> {
    try {
      await this.#options.api(`/api/v1/sessions/${encodeURIComponent(item.sessionId)}/message-queue/${encodeURIComponent(item.id)}`, "DELETE");
      this.#items = this.#items.filter((candidate) => candidate.id !== item.id);
      this.#dispatching = undefined; this.#render();
    } catch (error) { this.#dispatching = undefined; this.#render(); this.#options.onError(error instanceof Error ? error.message : String(error)); }
  }

  #render(): void {
    this.element.replaceChildren(); this.element.hidden = this.#items.length === 0;
    if (!this.#items.length) return;
    const heading = document.createElement("div"); heading.className = "session-message-queue-heading"; heading.textContent = `${this.#items.length} message${this.#items.length === 1 ? "" : "s"} queued`;
    this.element.append(heading);
    for (const item of this.#items) this.element.append(this.#row(item));
  }

  #row(item: SessionQueuedMessage): HTMLElement {
    const row = document.createElement("div"); row.className = "session-message-queue-row"; row.dataset.queueId = item.id;
    const text = document.createElement("span"); text.className = "session-message-queue-text"; text.textContent = item.text;
    const edit = button("Edit", () => this.#edit(row, item));
    const sendNow = button("Send now", async () => {
      try { await this.#options.steer(item.text); await this.#remove(item); }
      catch (error) { this.#options.onError(error instanceof Error ? error.message : String(error)); }
    });
    sendNow.hidden = !this.#options.isRunning();
    const remove = button("Remove", () => { void this.#remove(item); });
    for (const control of [edit, sendNow, remove]) control.disabled = this.#dispatching === item.id;
    row.append(text, edit, sendNow, remove); return row;
  }

  #edit(row: HTMLElement, item: SessionQueuedMessage): void {
    const input = document.createElement("input"); input.className = "session-message-queue-editor"; input.value = item.text; input.setAttribute("aria-label", "Edit queued message");
    const save = button("Save", async () => {
      const value = input.value.trim(); if (!value) return;
      try { const response = await this.#options.api(`/api/v1/sessions/${encodeURIComponent(item.sessionId)}/message-queue/${encodeURIComponent(item.id)}`, "PATCH", { text: value }); Object.assign(item, response.data); this.#render(); }
      catch (error) { this.#options.onError(error instanceof Error ? error.message : String(error)); }
    });
    const cancel = button("Cancel", () => this.#render());
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); save.click(); } else if (event.key === "Escape") cancel.click(); });
    row.replaceChildren(input, save, cancel); input.focus(); input.select();
  }
}

function button(label: string, action: () => void | Promise<void>): HTMLButtonElement {
  const control = document.createElement("button"); control.type = "button"; control.textContent = label; control.addEventListener("click", () => void action()); return control;
}
