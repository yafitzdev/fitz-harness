import { svgIcon } from "../primitives/dom.js";

/**
 * A model reasoning segment, rendered as a collapsible row inside the agent's
 * work feed. Reasoning is its own component: it never merges into assistant
 * chat text, renders without markdown or message actions, and only exposes
 * streaming text plus a completed state.
 */
export class ReasoningView {
  readonly #element: HTMLElement;
  readonly #summary: HTMLButtonElement;
  readonly #label: HTMLSpanElement;
  readonly #details: HTMLElement;
  readonly #content: HTMLPreElement;
  #open = false;

  constructor(running: boolean) {
    const element = document.createElement("div");
    element.className = `message agent-activity reasoning-activity${running ? " running" : ""}`;

    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "agent-activity-summary";
    summary.setAttribute("aria-expanded", "false");
    const icon = document.createElement("span");
    icon.className = "agent-activity-icon";
    icon.append(svgIcon('<path d="M10.5 2.6c.55 3.6 2.35 5.5 6.1 6.9-3.75 1.4-5.55 3.3-6.1 6.9-.55-3.6-2.35-5.5-6.1-6.9 3.75-1.4 5.55-3.3 6.1-6.9Z"></path><path d="m18.4 3.4.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"></path>'));
    const label = document.createElement("span");
    label.className = "agent-activity-label";
    label.textContent = running ? "Thinking…" : "Thought through the approach";
    label.title = label.textContent;
    const chevron = document.createElement("span");
    chevron.className = "agent-activity-chevron";
    chevron.append(svgIcon('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
    summary.append(icon, label, chevron);

    const details = document.createElement("div");
    details.className = "agent-activity-details reasoning-details";
    const content = document.createElement("pre");
    content.className = "reasoning-content";
    details.append(content);
    details.hidden = true;
    summary.addEventListener("click", () => this.#toggle());

    element.append(summary, details);
    this.#element = element;
    this.#summary = summary;
    this.#label = label;
    this.#details = details;
    this.#content = content;
  }

  get element(): HTMLElement { return this.#element; }

  /** Streams the next chunk of reasoning text into the collapsible body. */
  appendDelta(text: string): void {
    this.#content.textContent += text;
  }

  /** Marks the segment finished: stops the running state and settles the label. */
  complete(): void {
    this.#element.classList.remove("running");
    this.#label.textContent = "Thought through the approach";
    this.#label.title = this.#label.textContent;
  }

  #toggle(): void {
    this.#open = !this.#open;
    this.#details.hidden = !this.#open;
    this.#element.classList.toggle("open", this.#open);
    this.#summary.setAttribute("aria-expanded", String(this.#open));
  }
}
