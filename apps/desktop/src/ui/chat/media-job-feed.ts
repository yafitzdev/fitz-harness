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
  editImage: (job: MediaJobSummary, sourceArtifactId: string, prompt: string) => Promise<MediaJobSummary>;
  watch: (jobId: string) => void;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

/** Owns the durable media-job cards that bridge agent work and final answers. */
export class MediaJobFeed {
  readonly #options: MediaJobFeedOptions;
  readonly #rows = new Map<string, HTMLElement>();
  readonly #anchors = new Map<string, HTMLElement>();
  readonly #jobsByArtifactId = new Map<string, MediaJobSummary>();

  constructor(options: MediaJobFeedOptions) { this.#options = options; }

  reset(): void { this.#rows.clear(); this.#anchors.clear(); this.#jobsByArtifactId.clear(); }

  render(job: MediaJobSummary, failure?: string, artifact?: Json): void {
    const { messages } = this.#options;
    if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
    const completed = job.status === "completed";
    if (artifact?.id) this.#jobsByArtifactId.set(String(artifact.id), job);
    const label = `${job.modality[0]!.toUpperCase()}${job.modality.slice(1)}`;
    let row = this.#rows.get(job.id);
    const wasTracked = Boolean(row);
    if (!row) {
      row = document.createElement("article");
      row.className = "message media-card media-job-notice";
      row.dataset.mediaJobId = job.id;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", "false");
      row.addEventListener("click", (event) => {
        if ((event.target as Element).closest("button, input, textarea, select, label, form")) return;
        this.#toggleDetails(row!);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if ((event.target as Element).closest("button, input, textarea, select, label, form")) return;
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
    row.className = `message media-card media-job-notice ${job.status}${wasOpen ? " open" : ""}`;
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
    const operation = job.params?.operation === "edit" ? "edit" : "generation";
    title.textContent = completed ? `${label} ready`
      : job.status === "failed" || job.status === "interrupted" ? `${label} ${operation} failed`
        : job.status === "cancelled" ? `${label} ${operation} cancelled`
          : `${label} ${operation} in progress`;
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

    const actions = document.createElement("span");
    actions.className = "media-job-actions";
    if (artifact) actions.append(this.#action("Open", () => this.#options.openArtifact(artifact)));
    else if (["failed", "cancelled", "interrupted"].includes(job.status)) actions.append(this.#action("Retry", (button) => this.#retry(job, button)));
    row.append(actions);

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

    const editableArtifactId = completed && job.modality === "image" && artifact?.id ? String(artifact.id) : undefined;
    const specification = this.#specification(job, editableArtifactId);
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
    if (job.status === "completed") return job.params?.operation === "edit" ? "Here is your edited image!" : `Here is your ${job.modality}!`;
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
    this.#setDetailsOpen(row, open, true);
  }

  #setDetailsOpen(row: HTMLElement, open: boolean, reveal: boolean): void {
    const details = row.querySelector<HTMLElement>(":scope > .media-job-specification");
    if (!details) return;
    details.hidden = !open;
    row.classList.toggle("open", open);
    row.setAttribute("aria-expanded", String(open));
    if (open && reveal) this.#revealRow(row);
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

  #specification(job: MediaJobSummary, editableArtifactId?: string): HTMLElement {
    const details = document.createElement("div");
    details.className = "media-job-specification";
    const params = job.params && typeof job.params === "object" ? job.params as Record<string, unknown> : {};
    const list = document.createElement("dl");
    for (const [key, value] of this.#executionSettings(job, params)) {
      const term = document.createElement("dt");
      term.textContent = key;
      const definition = document.createElement("dd");
      definition.textContent = value;
      list.append(term, definition);
    }
    const settingsSection = document.createElement("section");
    settingsSection.className = "media-job-section media-job-settings";
    settingsSection.setAttribute("aria-label", "Settings");
    settingsSection.append(list);
    details.append(settingsSection);
    // The expanded card reads execution facts → next action → provenance.
    if (editableArtifactId) details.append(this.#editForm(job, editableArtifactId));
    const chain = document.createElement("ol");
    chain.className = "media-job-prompt-chain";
    for (const item of this.#promptChain(job)) {
      const row = document.createElement("li");
      const stage = document.createElement("span");
      stage.textContent = item.label;
      const prompt = document.createElement("button");
      prompt.type = "button";
      prompt.className = "media-job-prompt-link";
      prompt.textContent = item.prompt;
      prompt.title = `Jump to ${item.label.toLowerCase()} image card`;
      prompt.setAttribute("aria-label", `${item.label}: ${item.prompt}. Jump to image card`);
      prompt.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#jumpToJob(item.jobId);
      });
      row.append(stage, prompt);
      chain.append(row);
    }
    const promptSection = document.createElement("section");
    promptSection.className = "media-job-section media-job-prompts";
    promptSection.setAttribute("aria-label", "Prompt chain");
    promptSection.append(chain);
    details.append(promptSection);
    return details;
  }

  #executionSettings(job: MediaJobSummary, params: Record<string, unknown>): Array<[string, string]> {
    const execution = job.execution && typeof job.execution === "object" ? job.execution as Record<string, unknown> : {};
    const settings: Array<[string, string]> = [];
    if (typeof execution.recipeDisplayName === "string") settings.push(["Model", execution.recipeDisplayName]);
    if (typeof execution.modelId === "string") settings.push(["Checkpoint", execution.modelId]);
    if (typeof execution.recipeId === "string") settings.push(["Recipe", execution.recipeId]);
    if (typeof execution.adapter === "string") settings.push(["Engine", execution.adapter === "comfyui" ? "ComfyUI" : execution.adapter]);
    if (Object.keys(execution).length === 0) settings.push(["Execution details", "Not recorded for this earlier job"]);
    if (typeof job.routeId === "string") settings.push(["Route", job.routeId]);
    settings.push(["Operation", params.operation === "edit" ? "Edit" : "Generate"]);
    const labels: Record<string, string> = {
      size: "Resolution",
      seed: "Seed",
      sampler: "Sampler",
      steps: "Steps",
      guidance: "Guidance",
      negativePrompt: "Negative prompt",
      durationSeconds: "Duration (seconds)",
      fps: "Frame rate (fps)",
    };
    for (const [key, value] of Object.entries(params)) {
      if (["prompt", "operation", "refs"].includes(key) || value === undefined) continue;
      const label = labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
      settings.push([label, value === "" ? "None" : typeof value === "string" ? value : JSON.stringify(value)]);
    }
    return settings;
  }

  #promptChain(job: MediaJobSummary): Array<{ jobId: string; label: string; prompt: string }> {
    const lineage: Array<{ jobId: string; operation: string; prompt: string }> = [];
    const seen = new Set<string>();
    let current: MediaJobSummary | undefined = job;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const params: Record<string, unknown> = current.params && typeof current.params === "object" ? current.params as Record<string, unknown> : {};
      lineage.unshift({
        jobId: current.id,
        operation: params.operation === "edit" ? "edit" : "generate",
        prompt: typeof params.prompt === "string" ? params.prompt : "Not recorded",
      });
      const refs: unknown[] = Array.isArray(params.refs) ? params.refs : [];
      const source: { artifactId: string } | undefined = refs.find((ref: unknown): ref is { artifactId: string } => Boolean(ref && typeof ref === "object" && typeof (ref as { artifactId?: unknown }).artifactId === "string"));
      current = source ? this.#jobsByArtifactId.get(source.artifactId) : undefined;
    }
    let editNumber = 0;
    return lineage.map((item, index) => {
      if (item.operation !== "edit" && index === 0) return { jobId: item.jobId, label: "Original", prompt: item.prompt };
      editNumber += 1;
      return { jobId: item.jobId, label: lineage.length === 1 ? "Edit" : `Edit ${editNumber}`, prompt: item.prompt };
    });
  }

  #jumpToJob(jobId: string): void {
    const target = this.#rows.get(jobId);
    if (!target?.isConnected) return;
    this.#setDetailsOpen(target, true, false);
    target.scrollIntoView?.({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    target.classList.remove("jump-target");
    // Restart the transition when the same lineage item is clicked repeatedly.
    void target.offsetWidth;
    target.classList.add("jump-target");
    window.setTimeout(() => target.classList.remove("jump-target"), 1_200);
  }

  #editForm(job: MediaJobSummary, sourceArtifactId: string): HTMLFormElement {
    const form = document.createElement("form");
    form.className = "media-job-section media-job-edit";
    form.setAttribute("aria-label", "Edit image");
    const label = document.createElement("label");
    label.className = "media-job-edit-field";
    const controls = document.createElement("span");
    controls.className = "media-job-edit-controls";
    const prompt = document.createElement("textarea");
    prompt.rows = 1;
    prompt.name = "editPrompt";
    prompt.required = true;
    prompt.placeholder = "Describe what should change";
    prompt.setAttribute("aria-label", "Edit prompt");
    const resizePrompt = (): void => {
      prompt.style.height = "29px";
      prompt.style.height = `${Math.min(96, Math.max(29, prompt.scrollHeight))}px`;
    };
    prompt.addEventListener("input", resizePrompt);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "media-job-open media-job-edit-submit";
    submit.textContent = "Edit";
    controls.append(prompt, submit);
    label.append(controls);
    const error = document.createElement("small");
    error.className = "media-job-edit-error";
    error.hidden = true;
    form.append(label, error);
    form.addEventListener("click", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.#edit(job, sourceArtifactId, prompt, submit, error);
    });
    prompt.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      form.requestSubmit();
    });
    return form;
  }

  async #edit(job: MediaJobSummary, sourceArtifactId: string, prompt: HTMLTextAreaElement, submit: HTMLButtonElement, error: HTMLElement): Promise<void> {
    const instruction = prompt.value.trim();
    if (!instruction) {
      prompt.setCustomValidity("Describe what should change");
      prompt.reportValidity();
      return;
    }
    prompt.setCustomValidity("");
    prompt.disabled = true;
    submit.disabled = true;
    error.hidden = true;
    try {
      const edited = await this.#options.editImage(job, sourceArtifactId, instruction);
      prompt.value = "";
      prompt.style.height = "29px";
      this.render(edited);
      this.#options.watch(edited.id);
    } catch (caught) {
      error.textContent = this.#options.errorMessage(caught);
      error.hidden = false;
    } finally {
      prompt.disabled = false;
      submit.disabled = false;
    }
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
