import type { AgentPlanItem, AgentRunPlan } from "@fitz/protocol";

type Json = Record<string, any>;

/** A single mutable view of the active run plan, anchored above the composer. */
export class AgentPlanPanel {
  readonly root: HTMLElement;
  readonly #summary: HTMLElement;
  readonly #list: HTMLOListElement;
  readonly #toggle: HTMLButtonElement;
  readonly #chevron: HTMLElement;
  #runId: string | undefined;
  #revision = -1;

  constructor(mount: HTMLElement) {
    this.root = document.createElement("section");
    this.root.className = "agent-plan-panel";
    this.root.hidden = true;
    this.root.setAttribute("aria-live", "polite");

    const header = document.createElement("header");
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "agent-plan-panel-toggle";
    this.#toggle.setAttribute("aria-expanded", "true");
    const title = document.createElement("strong");
    title.textContent = "Tasks";
    this.#summary = document.createElement("span");
    this.#chevron = document.createElement("span");
    this.#chevron.className = "agent-plan-panel-chevron";
    this.#chevron.setAttribute("aria-hidden", "true");
    this.#chevron.textContent = "›";
    this.#list = document.createElement("ol");
    this.#list.className = "agent-plan-panel-list";
    this.#toggle.append(title, this.#summary, this.#chevron);
    this.#toggle.addEventListener("click", () => this.#setCollapsed(!this.root.classList.contains("collapsed")));
    header.append(this.#toggle);
    this.root.append(header, this.#list);

    const composer = mount.querySelector("form");
    if (composer) composer.before(this.root);
    else mount.append(this.root);
  }

  reset(): void {
    this.#runId = undefined;
    this.#revision = -1;
    this.#summary.textContent = "";
    this.#list.replaceChildren();
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
    this.#runId = plan.runId;
    this.#revision = plan.revision;
    const completed = plan.items.filter((item) => item.status === "completed").length;
    this.#summary.textContent = `${completed} of ${plan.items.length} done`;
    this.root.classList.toggle("completed", plan.status === "completed");
    this.#list.replaceChildren(...plan.items.map((item) => this.#renderItem(item)));
    this.root.hidden = false;
  }

  #setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("collapsed", collapsed);
    this.#list.hidden = collapsed;
    this.#toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  #renderItem(item: AgentPlanItem): HTMLLIElement {
    const row = document.createElement("li");
    row.className = `agent-plan-panel-item ${item.status}`;
    row.dataset.taskId = item.id;
    const mark = document.createElement("span");
    mark.className = "agent-plan-panel-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = item.status === "completed" ? "✓" : item.status === "running" ? "●" : item.status === "failed" ? "!" : "○";
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
