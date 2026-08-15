/**
 * One provider-native model reasoning segment. It is rendered directly in the
 * work feed so the text the model actually emitted remains visible between tool
 * bursts, like Codex's running commentary. The surrounding Worked-for section
 * already provides the single collapse boundary for the complete work feed.
 */
export class ReasoningView {
  readonly #element: HTMLElement;
  readonly #content: HTMLDivElement;

  constructor(running: boolean) {
    const element = document.createElement("details");
    element.className = `message agent-activity reasoning-activity${running ? " running" : ""}`;
    const summary = document.createElement("summary");
    summary.textContent = "Reasoning";
    const content = document.createElement("div");
    content.className = "reasoning-content";
    element.append(summary, content);
    this.#element = element;
    this.#content = content;
  }

  get element(): HTMLElement { return this.#element; }

  /** Streams the next chunk of provider-native reasoning into the visible feed. */
  appendDelta(text: string): void {
    this.#content.textContent += text;
  }

  /** Marks the segment finished without replacing or summarizing its text. */
  complete(): void {
    this.#element.classList.remove("running");
  }
}
