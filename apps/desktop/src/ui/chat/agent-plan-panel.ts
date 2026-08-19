import type { AgentPlanItem, AgentRunPlan } from "@fitz/protocol";

type Json = Record<string, any>;

/** A single mutable view of the active run plan, anchored above the composer. */
export class AgentPlanPanel {
  readonly root: HTMLElement;
  readonly #summary: HTMLElement;
  readonly #currentTask: HTMLElement;
  readonly #currentTaskText: HTMLElement;
  readonly #list: HTMLOListElement;
  readonly #toggle: HTMLButtonElement;
  readonly #chevron: HTMLElement;
  #runId: string | undefined;
  #revision = -1;
  #runningOrder = new Map<string, number>();
  #nextRunningOrder = 0;
  #overflowFrame: number | undefined;
  #resizeObserver: ResizeObserver | undefined;

  constructor(mount: HTMLElement) {
    this.root = document.createElement("section");
    this.root.className = "agent-plan-panel";
    this.root.hidden = true;
    this.root.setAttribute("aria-live", "polite");

    const header = document.createElement("header");
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "agent-plan-panel-toggle";
    this.#toggle.setAttribute("aria-expanded", "false");
    const title = document.createElement("strong");
    title.textContent = "Tasks";
    this.#currentTask = document.createElement("span");
    this.#currentTask.className = "agent-plan-panel-current";
    this.#currentTask.hidden = true;
    this.#currentTaskText = document.createElement("span");
    this.#currentTaskText.className = "agent-plan-panel-current-text";
    this.#currentTask.append(this.#currentTaskText);
    this.#summary = document.createElement("span");
    this.#summary.className = "agent-plan-panel-summary";
    this.#chevron = document.createElement("span");
    this.#chevron.className = "agent-plan-panel-chevron";
    this.#chevron.setAttribute("aria-hidden", "true");
    this.#chevron.textContent = "›";
    this.#list = document.createElement("ol");
    this.#list.className = "agent-plan-panel-list";
    this.#list.id = "agent-plan-panel-list";
    this.#list.hidden = true;
    this.#toggle.setAttribute("aria-controls", this.#list.id);
    this.root.classList.add("collapsed");
    this.#toggle.append(title, this.#currentTask, this.#summary, this.#chevron);
    this.#toggle.addEventListener("click", () => this.#setCollapsed(!this.root.classList.contains("collapsed")));
    header.append(this.#toggle);
    this.root.append(header, this.#list);

    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => this.#scheduleCurrentTaskOverflow());
      this.#resizeObserver.observe(this.#currentTask);
    }

    const shell = mount.querySelector(".composer-shell") ?? mount;
    const composer = shell.querySelector("form");
    if (composer) composer.before(this.root);
    else shell.append(this.root);
  }

  reset(): void {
    this.#runId = undefined;
    this.#revision = -1;
    this.#runningOrder.clear();
    this.#nextRunningOrder = 0;
    this.#summary.textContent = "";
    this.#currentTask.hidden = true;
    this.#currentTaskText.textContent = "";
    this.#currentTask.removeAttribute("title");
    this.#currentTask.classList.remove("overflowing");
    this.#list.replaceChildren();
    this.#setCollapsed(true);
    this.root.hidden = true;
    this.root.classList.remove("completed");
  }

  updateFromToolResult(result: unknown): boolean {
    const plan = this.#planFromResult(result);
    if (!plan) return false;
    this.update(plan);
    return true;
  }

  update(plan: AgentRunPlan): void {
    if (this.#runId === plan.runId && plan.revision < this.#revision) return;
    const isNewPlan = this.#runId !== plan.runId;
    if (isNewPlan) {
      this.#runningOrder.clear();
      this.#nextRunningOrder = 0;
    }
    this.#runId = plan.runId;
    this.#revision = plan.revision;
    const completed = plan.items.filter((item) => item.status === "completed").length;
    this.#summary.textContent = `${completed} of ${plan.items.length} done`;
    this.#updateCurrentTask(plan.items);
    this.root.classList.toggle("completed", plan.status === "completed");
    this.#list.replaceChildren(...plan.items.map((item) => this.#renderItem(item)));
    if (isNewPlan) this.#setCollapsed(true);
    this.root.hidden = false;
    this.#scheduleCurrentTaskOverflow();
  }

  #setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("collapsed", collapsed);
    this.#list.hidden = collapsed;
    this.#toggle.setAttribute("aria-expanded", String(!collapsed));
    this.#scheduleCurrentTaskOverflow();
  }

  #updateCurrentTask(items: AgentPlanItem[]): void {
    const running = items.filter((item) => item.status === "running");
    const runningIds = new Set(running.map((item) => item.id));
    for (const id of this.#runningOrder.keys()) {
      if (!runningIds.has(id)) this.#runningOrder.delete(id);
    }
    for (const item of running) {
      if (!this.#runningOrder.has(item.id)) this.#runningOrder.set(item.id, this.#nextRunningOrder++);
    }
    const current = running.reduce<AgentPlanItem | undefined>((first, item) => {
      if (!first) return item;
      return (this.#runningOrder.get(item.id) ?? Number.MAX_SAFE_INTEGER) < (this.#runningOrder.get(first.id) ?? Number.MAX_SAFE_INTEGER)
        ? item
        : first;
    }, undefined);
    this.#currentTask.hidden = !current;
    this.#currentTaskText.textContent = current?.task ?? "";
    if (current) this.#currentTask.title = current.task;
    else this.#currentTask.removeAttribute("title");
  }

  #scheduleCurrentTaskOverflow(): void {
    if (typeof requestAnimationFrame === "undefined") {
      this.#syncCurrentTaskOverflow();
      return;
    }
    if (this.#overflowFrame !== undefined) cancelAnimationFrame(this.#overflowFrame);
    this.#overflowFrame = requestAnimationFrame(() => {
      this.#overflowFrame = undefined;
      this.#syncCurrentTaskOverflow();
    });
  }

  #syncCurrentTaskOverflow(): void {
    const distance = Math.ceil(this.#currentTaskText.scrollWidth - this.#currentTask.clientWidth);
    const overflowing = !this.#currentTask.hidden && this.root.classList.contains("collapsed") && distance > 1;
    this.#currentTask.classList.toggle("overflowing", overflowing);
    if (!overflowing) {
      this.#currentTask.style.removeProperty("--agent-plan-scroll-distance");
      this.#currentTask.style.removeProperty("--agent-plan-scroll-duration");
      return;
    }
    this.#currentTask.style.setProperty("--agent-plan-scroll-distance", `${distance}px`);
    this.#currentTask.style.setProperty("--agent-plan-scroll-duration", `${Math.min(18, Math.max(7, 5 + distance / 32))}s`);
  }

  #renderItem(item: AgentPlanItem): HTMLLIElement {
    const row = document.createElement("li");
    row.className = `agent-plan-panel-item ${item.status}`;
    row.dataset.taskId = item.id;
    const mark = document.createElement("span");
    mark.className = `agent-plan-panel-mark${item.status === "running" ? " agent-plan-panel-spinner" : ""}`;
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = item.status === "completed" ? "✓" : item.status === "failed" ? "!" : item.status === "pending" ? "○" : "";
    const task = document.createElement("span");
    task.className = "agent-plan-panel-task";
    task.textContent = item.task;
    const owner = document.createElement("span");
    owner.className = "agent-plan-panel-owner";
    owner.textContent = item.owner;
    row.append(mark, task, owner);
    return row;
  }

  #planFromResult(result: unknown): AgentRunPlan | undefined {
    if (!result || typeof result !== "object") return undefined;
    const details = (result as Json).details;
    const plan = details && typeof details === "object" ? details.plan : undefined;
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.items)) return undefined;
    if (typeof plan.runId !== "string" || !Number.isFinite(Number(plan.revision))) return undefined;
    return plan as AgentRunPlan;
  }
}
