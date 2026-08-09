import { svgIcon, textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

export interface AgentQueueOptions {
  list: HTMLElement;
  count: HTMLElement;
  api: (path: string, method?: string, body?: Json) => Promise<Json>;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

/** Owns rendering and cancellation for the host's serialized agent queue. */
export class AgentQueueController {
  readonly #options: AgentQueueOptions;

  constructor(options: AgentQueueOptions) { this.#options = options; }

  async refresh(): Promise<void> {
    const { list, count } = this.#options;
    try {
      const response = await this.#options.api("/api/v1/agent/queue");
      const items = Array.isArray(response.data) ? response.data : [];
      list.replaceChildren();
      count.textContent = String(items.length);
      if (!items.length) {
        list.append(textBlock("panel-empty", "No active requests"));
        return;
      }
      for (const item of items) list.append(this.#row(item));
    } catch {
      list.replaceChildren(textBlock("panel-empty", "Queue unavailable"));
      count.textContent = "—";
    }
  }

  #row(item: Json): HTMLElement {
    const row = document.createElement("div");
    row.className = `queue-item ${item.status}`;
    const state = document.createElement("span");
    state.className = "queue-state";
    if (item.status === "queued") state.textContent = String(item.position);
    const copy = document.createElement("span");
    copy.className = "queue-copy";
    const title = document.createElement("strong");
    title.textContent = item.sessionTitle ?? `${item.routeId} task`;
    const detail = document.createElement("small");
    detail.textContent = item.status === "running"
      ? `${item.projectName ?? "Agent"} · Running`
      : `${item.projectName ?? "Agent"} · Position ${item.position}`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "queue-cancel";
    cancel.title = item.status === "running" ? "Stop request" : "Remove from queue";
    cancel.setAttribute("aria-label", cancel.title);
    cancel.append(svgIcon('<path d="m5 5 10 10M15 5 5 15"></path>'));
    cancel.addEventListener("click", () => void this.#cancel(String(item.runId), cancel));
    copy.append(title, detail);
    row.append(state, copy, cancel);
    return row;
  }

  async #cancel(runId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.#options.api(`/api/v1/agent/runs/${runId}`, "DELETE");
      await this.refresh();
    } catch (error) {
      button.disabled = false;
      this.#options.showToast(this.#options.errorMessage(error));
    }
  }
}
