export type ActionStatusTone = "neutral" | "success" | "error";
export type ActionFeedback = (message: string, tone: ActionStatusTone) => void;

/** Accessible, app-wide feedback for actions that do not own durable inline UI. */
export class ActionStatusView {
  readonly root: HTMLElement;
  readonly #dismissAfterMs: number;
  #dismissTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(owner: Document, dismissAfterMs = 5_000) {
    this.#dismissAfterMs = dismissAfterMs;
    this.root = owner.createElement("div");
    this.root.className = "action-status";
    this.root.hidden = true;
    this.root.setAttribute("aria-atomic", "true");
    this.root.addEventListener("click", () => this.clear());
    owner.body.append(this.root);
  }

  show(message: string, tone: ActionStatusTone): void {
    const text = message.trim();
    if (!text) return;
    if (this.#dismissTimer) clearTimeout(this.#dismissTimer);
    this.root.textContent = text;
    this.root.dataset.tone = tone;
    this.root.setAttribute("role", tone === "error" ? "alert" : "status");
    this.root.hidden = false;
    this.#dismissTimer = setTimeout(() => this.clear(), this.#dismissAfterMs);
  }

  clear(): void {
    if (this.#dismissTimer) clearTimeout(this.#dismissTimer);
    this.#dismissTimer = undefined;
    this.root.hidden = true;
  }
}
