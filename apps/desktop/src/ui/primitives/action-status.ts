import { svgIcon } from "./dom.js";

export type ActionStatusTone = "neutral" | "success" | "error";
export type ActionFeedback = (message: string, tone: ActionStatusTone) => void;

const STATUS_ICON = '<circle cx="10" cy="10" r="7"></circle><path d="M10 9v4M10 6.5v.5"></path>';
const SUCCESS_ICON = '<path d="m4.2 10.1 3.25 3.25 8.35-8.35"></path>';
const ERROR_ICON = '<circle cx="10" cy="10" r="7"></circle><path d="m7.5 7.5 5 5M12.5 7.5l-5 5"></path>';
const CLOSE_ICON = '<path d="m6 6 8 8M14 6l-8 8"></path>';

const instances = new WeakMap<HTMLElement, ActionStatus>();

/** Compact, dismissible feedback that stays in the page layout instead of appearing as a popup. */
export class ActionStatus {
  readonly root: HTMLElement;
  readonly message: HTMLElement;
  readonly icon: HTMLElement;
  #clearTimer: number | undefined;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "management-action-status";
    this.root.hidden = true;
    this.root.setAttribute("aria-live", "polite");
    this.icon = document.createElement("span");
    this.icon.className = "management-action-status-icon";
    this.message = document.createElement("span");
    this.message.className = "management-action-status-message";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "management-action-status-dismiss";
    dismiss.title = "Dismiss";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.append(svgIcon(CLOSE_ICON));
    dismiss.addEventListener("click", () => this.clear());
    this.root.append(this.icon, this.message, dismiss);
    instances.set(this.root, this);
  }

  show(text: string, tone: ActionStatusTone = "neutral"): void {
    window.clearTimeout(this.#clearTimer);
    this.#clearTimer = undefined;
    this.message.textContent = text;
    this.root.dataset.tone = tone;
    this.root.setAttribute("role", tone === "error" ? "alert" : "status");
    this.icon.replaceChildren(svgIcon(tone === "success" ? SUCCESS_ICON : tone === "error" ? ERROR_ICON : STATUS_ICON));
    this.root.hidden = false;
    if (tone === "success") this.#clearTimer = window.setTimeout(() => this.clear(), 4_000);
  }

  clear(): void {
    window.clearTimeout(this.#clearTimer);
    this.#clearTimer = undefined;
    this.root.hidden = true;
    this.root.removeAttribute("role");
    this.root.removeAttribute("data-tone");
    this.message.textContent = "";
  }

  static find(container: ParentNode): ActionStatus | undefined {
    const root = container.querySelector<HTMLElement>(".management-action-status");
    return root ? instances.get(root) : undefined;
  }
}
