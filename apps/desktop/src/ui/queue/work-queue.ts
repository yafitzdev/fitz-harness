import { svgIcon, textBlock } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";

type Json = Record<string, any>;
export interface WorkQueueOptions { list: HTMLElement; count: HTMLElement; api: (path: string, method?: string, body?: Json) => Promise<Json>; showStatus: ActionFeedback; errorMessage: (error: unknown) => string }

/** Renders every task waiting on either the single local GPU or a bounded
 * remote-provider lane. Cancellation targets the queue item, not a UI mode. */
export class WorkQueueController {
  constructor(readonly options: WorkQueueOptions) {}
  async refresh(): Promise<void> {
    try {
      const response = await this.options.api("/api/v1/work/queue");
      const items = Array.isArray(response.data) ? response.data : [];
      this.options.list.replaceChildren(); this.options.count.textContent = String(items.length);
      if (!items.length) return void this.options.list.append(textBlock("panel-empty", "No active requests"));
      for (const item of items) this.options.list.append(this.#row(item));
    } catch { this.options.list.replaceChildren(textBlock("panel-empty", "Queue unavailable")); this.options.count.textContent = "—"; }
  }
  #row(item: Json): HTMLElement {
    const row = document.createElement("div"); row.className = `queue-item ${item.status}`;
    const state = document.createElement("span"); state.className = "queue-state"; if (item.status === "queued") state.textContent = String(item.position);
    const copy = document.createElement("span"); copy.className = "queue-copy";
    const title = document.createElement("strong"); title.textContent = item.label ?? `${item.routeId} ${item.kind === "agent" ? "task" : item.kind}`;
    const detail = document.createElement("small"); const location = item.lane === "cloud" ? "Cloud" : "GPU"; detail.textContent = item.status === "running" ? `${item.projectName ?? location} · Running` : `${item.projectName ?? location} · Position ${item.position}`;
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "queue-cancel"; cancel.title = item.status === "running" ? "Stop request" : "Remove from queue"; cancel.setAttribute("aria-label", cancel.title); cancel.append(svgIcon('<path d="m5 5 10 10M15 5 5 15"></path>')); cancel.addEventListener("click", () => void this.#cancel(String(item.id), cancel));
    copy.append(title, detail); row.append(state, copy, cancel); return row;
  }
  async #cancel(id: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try { await this.options.api(`/api/v1/work/queue/${encodeURIComponent(id)}`, "DELETE"); await this.refresh(); }
    catch (error) { button.disabled = false; this.options.showStatus(this.options.errorMessage(error), "error"); }
  }
}
