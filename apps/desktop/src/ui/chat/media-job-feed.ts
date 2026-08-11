import { svgIcon } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import type { MediaJobSummary } from "./media-job-tracker.js";
import { scrollToLatestIfFollowing } from "./conversation-scroll.js";

type Json = Record<string, any>;

const MEDIA_PREPARATION_PERCENT = 25;

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
  readonly #anchors = new Map<string, HTMLElement>();

  constructor(options: MediaJobFeedOptions) { this.#options = options; }

  reset(): void { this.#rows.clear(); this.#anchors.clear(); }

  render(job: MediaJobSummary, failure?: string, artifact?: Json): void {
    const { messages } = this.#options;
    if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
    const completed = job.status === "completed";
    const label = `${job.modality[0]!.toUpperCase()}${job.modality.slice(1)}`;
    let row = this.#rows.get(job.id);
    const wasTracked = Boolean(row);
    if (!row) {
      row = document.createElement("article");
      row.className = "message media-job-notice";
      row.dataset.mediaJobId = job.id;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", "false");
      row.addEventListener("click", (event) => {
        if ((event.target as Element).closest("button")) return;
        this.#toggleDetails(row!);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if ((event.target as Element).closest("button")) return;
        event.preventDefault();
        this.#toggleDetails(row!);
      });
      this.#rows.set(job.id, row);
      if (!this.#terminal(job.status)) {
        this.#options.appendWork(row, job.startedAt ?? job.enqueuedAt);
        const anchor = row.closest<HTMLElement>(".work-summary");
        if (anchor) this.#anchors.set(job.id, anchor);
      }
    }
    const wasOpen = row.classList.contains("open");
    row.className = `message media-job-notice ${job.status}${wasOpen ? " open" : ""}`;
    row.setAttribute("aria-expanded", String(wasOpen));
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
    const displayProgress = this.#displayProgress(job);
    if (!this.#terminal(job.status) && displayProgress !== undefined) {
      detail.textContent = job.status === "started" && job.progress === undefined
        ? `Preparing model… ${displayProgress}%`
        : `Generating… ${displayProgress}%`;
    } else {
      detail.textContent = failure ?? (artifact?.name ? artifact.name : completed ? "Generated artifact" : "Fitz is following this job in the background.");
    }
    copy.append(title, detail);
    row.append(icon, copy);

    const chevron = document.createElement("span");
    chevron.className = "media-job-chevron";
    chevron.append(svgIcon('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
    row.append(chevron);

    if (artifact) row.append(this.#action("Open", () => this.#options.openArtifact(artifact)));
    else if (["failed", "cancelled", "interrupted"].includes(job.status)) row.append(this.#action("Retry", (button) => this.#retry(job, button)));

    // Thin progress bar across the bottom of the card while the job is active.
    // Reserve the first quarter for model preparation. Once ComfyUI begins
    // reporting diffusion steps, map that real 0..1 measurement over 25..100%.
    if (!this.#terminal(job.status)) {
      const progress = document.createElement("div");
      progress.className = "media-job-progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      if (displayProgress !== undefined) {
        progress.style.setProperty("--progress", `${displayProgress}%`);
        progress.setAttribute("aria-valuenow", String(displayProgress));
      }
      row.append(progress);
    }

    const specification = this.#specification(job);
    specification.hidden = !wasOpen;
    row.append(specification);

    if (this.#terminal(job.status) && !row.closest(".media-result-message")) {
      const anchor = this.#anchors.get(job.id) ?? this.#originatingWork(job.id);
      const content = this.#options.appendAssistant(this.#terminalMessage(job), job.completedAt ?? job.cancelledAt);
      const answer = content.closest<HTMLElement>(".message.assistant");
      if (answer) {
        answer.classList.add("media-result-message");
        const actions = answer.querySelector<HTMLElement>(":scope > .message-actions");
        answer.insertBefore(row, actions);
        if (anchor?.isConnected) anchor.after(answer);
      }
    }
    // Only a job that was previously rendered as active may own unfinished
    // work. A terminal job restored from storage must never create/close work.
    if (wasTracked && this.#terminal(job.status)) this.#options.finishWork(job.completedAt ?? job.cancelledAt);
    scrollToLatestIfFollowing(messages);
  }

  #action(label: string, action: (button: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "media-job-open";
    button.textContent = label;
    button.addEventListener("click", (event) => { event.stopPropagation(); void action(button); });
    return button;
  }

  #terminal(status: string): boolean {
    return ["completed", "failed", "cancelled", "interrupted"].includes(status);
  }

  #displayProgress(job: MediaJobSummary): number | undefined {
    if (job.status === "started" && job.progress === undefined) return MEDIA_PREPARATION_PERCENT;
    if (typeof job.progress !== "number") return undefined;
    const generationProgress = Math.min(1, Math.max(0, job.progress));
    return Math.round(MEDIA_PREPARATION_PERCENT + generationProgress * (100 - MEDIA_PREPARATION_PERCENT));
  }

  #terminalMessage(job: MediaJobSummary): string {
    if (job.status === "completed") return `Here is your ${job.modality}!`;
    if (job.status === "cancelled") return `${this.#capitalized(job.modality)} generation was cancelled.`;
    if (job.status === "interrupted") return `${this.#capitalized(job.modality)} generation was interrupted.`;
    return `I couldn't generate your ${job.modality}.`;
  }

  #capitalized(value: string): string { return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`; }

  #originatingWork(jobId: string): HTMLElement | undefined {
    for (const tool of this.#options.messages.querySelectorAll<HTMLElement>("[data-media-job-id]")) {
      if (tool.dataset.mediaJobId !== jobId) continue;
      const work = tool.closest<HTMLElement>(".work-summary");
      if (work) { this.#anchors.set(jobId, work); return work; }
    }
    return undefined;
  }

  #toggleDetails(row: HTMLElement): void {
    const details = row.querySelector<HTMLElement>(":scope > .media-job-specification");
    if (!details) return;
    const open = details.hasAttribute("hidden");
    details.hidden = !open;
    row.classList.toggle("open", open);
    row.setAttribute("aria-expanded", String(open));
    if (open) this.#revealRow(row);
  }

  /** After expanding a card, scroll the chat so the card's bottom edge is
   *  visible. Cards near the bottom of the chat open downwards into the fold,
   *  and without this the user must scroll down again to see the details. */
  #revealRow(row: HTMLElement): void {
    const { messages } = this.#options;
    const rowRect = row.getBoundingClientRect();
    const containerRect = messages.getBoundingClientRect();
    const overflow = rowRect.bottom - containerRect.bottom;
    if (overflow <= 0) return; // already fully visible
    messages.scrollTop += overflow;
  }

  #specification(job: MediaJobSummary): HTMLElement {
    const details = document.createElement("div");
    details.className = "media-job-specification";
    const params = job.params && typeof job.params === "object" ? job.params as Record<string, unknown> : {};
    const promptLabel = document.createElement("strong");
    promptLabel.textContent = "Prompt";
    const prompt = document.createElement("pre");
    prompt.textContent = typeof params.prompt === "string" ? params.prompt : "Not recorded";
    details.append(promptLabel, prompt);
    const settings = Object.entries(params).filter(([key]) => key !== "prompt");
    const settingsLabel = document.createElement("strong");
    settingsLabel.textContent = "Settings";
    const list = document.createElement("dl");
    if (settings.length === 0) {
      const empty = document.createElement("span");
      empty.className = "media-job-settings-empty";
      empty.textContent = "Route defaults";
      list.append(empty);
    } else {
      for (const [key, value] of settings) {
        const term = document.createElement("dt");
        term.textContent = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
        const definition = document.createElement("dd");
        definition.textContent = typeof value === "string" ? value : JSON.stringify(value);
        list.append(term, definition);
      }
    }
    details.append(settingsLabel, list);
    return details;
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
