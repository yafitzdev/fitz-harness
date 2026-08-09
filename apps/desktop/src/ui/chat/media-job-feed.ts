import { svgIcon } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import type { MediaJobSummary } from "./media-job-tracker.js";
import { scrollToLatestIfFollowing } from "./conversation-scroll.js";

type Json = Record<string, any>;

export interface MediaJobFeedOptions {
  messages: HTMLElement;
  appendWork: (element: HTMLElement, createdAt?: string) => void;
  finishWork: (completedAt?: string) => void;
  appendAssistant: (text: string, createdAt?: string) => HTMLElement;
  openArtifact: (artifact: Json) => void | Promise<void>;
  retry: (job: MediaJobSummary) => Promise<MediaJobSummary>;
  watch: (jobId: string) => void;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

/** Owns the durable media-job cards that bridge agent work and final answers. */
export class MediaJobFeed {
  readonly #options: MediaJobFeedOptions;
  readonly #rows = new Map<string, HTMLElement>();

  constructor(options: MediaJobFeedOptions) { this.#options = options; }

  reset(): void { this.#rows.clear(); }

  render(job: MediaJobSummary, failure?: string, artifact?: Json): void {
    const { messages } = this.#options;
    if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
    const completed = job.status === "completed";
    const label = `${job.modality[0]!.toUpperCase()}${job.modality.slice(1)}`;
    let row = this.#rows.get(job.id);
    if (!row) {
      row = document.createElement("article");
      row.className = "message media-job-notice";
      row.dataset.mediaJobId = job.id;
      this.#rows.set(job.id, row);
      if (!completed) this.#options.appendWork(row, job.startedAt ?? job.enqueuedAt);
    }
    row.className = `message media-job-notice ${job.status}`;
    row.replaceChildren();

    const icon = document.createElement("span");
    icon.className = "media-job-icon";
    icon.append(svgIcon(job.status === "completed"
      ? '<path d="m4 10 4 4 8-9"></path>'
      : job.status === "failed" || job.status === "interrupted"
        ? '<path d="m5 5 10 10M15 5 5 15"></path>'
        : '<circle cx="10" cy="10" r="7"></circle>'));
    const copy = document.createElement("span");
    copy.className = "media-job-copy";
    const title = document.createElement("strong");
    title.textContent = completed ? `${label} ready`
      : job.status === "failed" || job.status === "interrupted" ? `${label} generation failed`
        : job.status === "cancelled" ? `${label} generation cancelled`
          : `${label} generation in progress`;
    const detail = document.createElement("small");
    detail.textContent = failure ?? (artifact?.name ? artifact.name : completed ? "Generated artifact" : "Fitz is following this job in the background.");
    copy.append(title, detail);
    row.append(icon, copy);

    if (artifact) row.append(this.#action("Open", () => this.#options.openArtifact(artifact)));
    else if (["failed", "cancelled", "interrupted"].includes(job.status)) row.append(this.#action("Retry", (button) => this.#retry(job, button)));

    if (completed && !row.closest(".media-result-message")) {
      const content = this.#options.appendAssistant(`Here is your ${job.modality}!`, job.completedAt);
      const answer = content.closest<HTMLElement>(".message.assistant");
      if (answer) {
        answer.classList.add("media-result-message");
        const actions = answer.querySelector<HTMLElement>(":scope > .message-actions");
        answer.insertBefore(row, actions);
      }
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) this.#options.finishWork(job.completedAt);
    scrollToLatestIfFollowing(messages);
  }

  #action(label: string, action: (button: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-job-open";
    button.textContent = label;
    button.addEventListener("click", () => void action(button));
    return button;
  }

  async #retry(job: MediaJobSummary, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const retried = await this.#options.retry(job);
      this.render(retried);
      this.#options.watch(retried.id);
    } catch (error) {
      button.disabled = false;
      this.#options.showStatus(this.#options.errorMessage(error), "error");
    }
  }
}
