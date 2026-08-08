import { svgIcon } from "../primitives/dom.js";
import { ReasoningView } from "./reasoning-view.js";
import { activityKind, burstIconPath, describeTool, iconPathFor, summarizeBurst, toolPath } from "./tool-activity.js";

type Json = Record<string, any>;
type WorkSummary = { root: HTMLElement; toggle: HTMLButtonElement; details: HTMLElement; startedAt: number; lastAt: number };
type ActivityBurst = {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  icon: HTMLElement;
  label: HTMLElement;
  details: HTMLElement;
  commands: number;
  edits: number;
  running: number;
  tools: Record<string, number>;
};

export interface ActivityTimelineOptions {
  messages: HTMLElement;
  inspectResource: (reference: string) => void | Promise<void>;
  decideApproval: (approvalId: string, decision: "approved" | "denied", request?: Json) => Promise<"approved" | "denied">;
  showToast: (message: string) => void;
}

function isMediaTool(toolName: string | undefined): boolean {
  return toolName === "generate_image" || toolName === "generate_video" || toolName === "generate_audio";
}

/** Renders the collapsible agent-work feed, tools, approvals, and compaction events. */
export class ActivityTimeline {
  readonly #options: ActivityTimelineOptions;
  readonly #searchRoots = new Set<string>();
  readonly #burstsByTool = new WeakMap<HTMLElement, ActivityBurst>();
  readonly #reasoningByRow = new WeakMap<HTMLElement, ReasoningView>();
  readonly #approvalRequests = new WeakMap<HTMLElement, Json>();
  #work: WorkSummary | undefined;
  #burst: ActivityBurst | undefined;

  constructor(options: ActivityTimelineOptions) { this.#options = options; }

  clear(): void { this.#work = undefined; this.#burst = undefined; this.#searchRoots.clear(); }
  searchRoots(): string[] { return [...this.#searchRoots]; }

  markAssistantAsCommentary(content: HTMLElement): void {
    const article = content.closest<HTMLElement>(".message.assistant");
    if (!article) return;
    article.classList.remove("assistant");
    article.classList.add("commentary");
    article.querySelector(":scope > .message-actions")?.remove();
    this.appendCommentary(article);
  }

  /** Narration is the boundary between two consecutive tool/edit bursts. */
  appendCommentary(node: HTMLElement, createdAt?: string): void {
    this.#burst = undefined;
    this.appendWork(node, createdAt);
  }

  /** A user steering message queued into the running conversation: rendered inside the agent's work feed, among the tool calls and reasoning. */
  appendSteer(text: string, createdAt?: string): HTMLElement {
    this.#removeLanding();
    this.#burst = undefined;
    const row = document.createElement("div");
    row.className = "message agent-activity steer-activity";
    const icon = document.createElement("span");
    icon.className = "agent-activity-icon";
    icon.append(svgIcon('<path d="M12 11.5a4.25 4.25 0 1 0-4.25-4.25A4.25 4.25 0 0 0 12 11.5Zm0 2.25c-3.55 0-6.5 1.95-6.5 4.4V19.5h13v-1.35c0-2.45-2.95-4.4-6.5-4.4Z"></path>'));
    const label = document.createElement("span");
    label.className = "agent-activity-label";
    label.textContent = text;
    label.title = text;
    row.append(icon, label);
    this.appendWork(row, createdAt);
    return row;
  }

  /** A model thinking segment, rendered as a collapsible row inside the work feed. */
  appendReasoning(running: boolean): HTMLElement {
    this.#removeLanding();
    this.#burst = undefined;
    const view = new ReasoningView(running);
    this.#reasoningByRow.set(view.element, view);
    this.appendWork(view.element);
    this.#scroll();
    return view.element;
  }

  appendReasoningDelta(row: HTMLElement, text: string): void {
    this.#reasoningByRow.get(row)?.appendDelta(text);
    this.#scroll();
  }

  completeReasoning(row: HTMLElement): void {
    this.#reasoningByRow.get(row)?.complete();
  }

  appendTool(toolName: string, input: unknown, toolCallId: string, running: boolean, createdAt?: string): HTMLElement {
    this.#removeLanding();
    const row = document.createElement("div");
    row.className = `message agent-activity${running ? " running" : ""}`;
    row.dataset.toolCallId = toolCallId;
    row.dataset.toolName = toolName;
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "agent-activity-summary";
    summary.setAttribute("aria-expanded", "false");
    const icon = document.createElement("span");
    icon.className = "agent-activity-icon";
    icon.append(svgIcon(iconPathFor(toolName)));
    const label = document.createElement("span");
    label.className = "agent-activity-label";
    label.textContent = describeTool(toolName, input, running);
    label.title = label.textContent;
    this.#registerSearchRoot(input);
    const resource = this.#resourceReference(toolName, input);
    if (resource) {
      label.classList.add("file-target");
      label.tabIndex = 0;
      label.setAttribute("role", "link");
      const inspect = (event: Event) => { event.stopPropagation(); void this.#options.inspectResource(resource); };
      label.addEventListener("click", inspect);
      label.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspect(event); } });
    }
    const chevron = document.createElement("span");
    chevron.className = "agent-activity-chevron";
    chevron.append(svgIcon('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
    summary.append(icon, label, chevron);
    const details = document.createElement("div");
    details.className = "agent-activity-details";
    if (toolName === "bash") this.#renderShell(details, input, running);
    else {
      if (input !== undefined) details.append(this.#detail("Input", input, "tool-activity-input"));
      details.append(this.#detail("Result", running ? undefined : null, "tool-activity-result"));
    }
    details.hidden = true;
    summary.addEventListener("click", () => {
      const open = details.hasAttribute("hidden");
      details.hidden = !open;
      row.classList.toggle("open", open);
      summary.setAttribute("aria-expanded", String(open));
    });
    row.append(summary, details);
    const burst = this.#ensureBurst(createdAt);
    this.#touchWork(createdAt);
    const kind = activityKind(toolName);
    if (kind === "edit") burst.edits += 1;
    else burst.commands += 1;
    if (running) burst.running += 1;
    burst.tools[toolName] = (burst.tools[toolName] ?? 0) + 1;
    burst.details.append(row);
    this.#burstsByTool.set(row, burst);
    this.#updateBurst(burst);
    this.#scroll();
    return row;
  }

  completeTool(row: HTMLElement, toolName: string, input: unknown, result: unknown, isError: boolean): void {
    const wasRunning = row.classList.contains("running");
    row.classList.remove("running");
    row.classList.toggle("failed", isError);
    const label = row.querySelector<HTMLElement>(".agent-activity-label");
    if (label) { const description = describeTool(toolName, input, false); label.textContent = isError ? `${description} (failed)` : description; label.title = label.textContent; }
    const resultValue = row.querySelector<HTMLElement>(".tool-activity-result .tool-activity-value");
    if (resultValue) resultValue.textContent = this.#formatPayload(result, "No result returned");
    const shellOutput = row.querySelector<HTMLElement>(".shell-output");
    if (shellOutput) shellOutput.textContent = this.#shellOutput(result);
    const shellStatus = row.querySelector<HTMLElement>(".shell-status");
    if (shellStatus) { shellStatus.textContent = isError ? "× Failed" : "✓ Success"; shellStatus.classList.toggle("failed", isError); }
    const burst = this.#burstsByTool.get(row);
    if (burst && wasRunning) { burst.running = Math.max(0, burst.running - 1); this.#updateBurst(burst); }
  }

  appendContext(text = "Context automatically compacted"): HTMLElement {
    this.finishWork();
    const row = document.createElement("div");
    row.className = "message context-activity";
    const icon = document.createElement("span");
    icon.className = "agent-activity-icon";
    icon.append(svgIcon('<path d="M4 3.5h8l3 3v10H4z"></path><path d="M12 3.5v3h3M6.5 10h6M6.5 13h4"></path><path d="m2.5 12-1.2 1.2L2.5 14.4"></path>'));
    const label = document.createElement("span");
    label.className = "agent-activity-label";
    label.textContent = text;
    row.append(icon, label);
    this.#options.messages.append(row);
    this.#scroll();
    return row;
  }

  appendApproval(approval: Json): HTMLElement {
    this.#burst = undefined;
    const row = document.createElement("section");
    row.className = "message tool-approval";
    row.dataset.approvalId = String(approval.id ?? "");
    row.dataset.toolName = String(approval.toolName ?? "tool");
    this.#approvalRequests.set(row, { ...(approval.request ?? {}) });
    const heading = document.createElement("div");
    heading.className = "tool-approval-heading";
    heading.append(svgIcon(iconPathFor(String(approval.toolName ?? "tool"))), Object.assign(document.createElement("span"), { textContent: `Allow ${String(approval.toolName ?? "tool")}?` }));
    const request = isMediaTool(row.dataset.toolName)
      ? this.#mediaApprovalForm(row.dataset.toolName, approval.request ?? {})
      : Object.assign(document.createElement("pre"), { className: "tool-approval-request", textContent: this.#formatPayload(approval.request, "No arguments") });
    const actions = document.createElement("div");
    actions.className = "tool-approval-actions";
    const deny = this.#button("Deny");
    const approve = this.#button("Approve", "approve-tool");
    deny.addEventListener("click", () => void this.#decide(row, "denied"));
    approve.addEventListener("click", () => void this.#decide(row, "approved"));
    const status = document.createElement("span");
    status.className = "tool-approval-status";
    actions.append(deny, approve);
    row.append(heading, request, actions, status);
    this.#options.messages.append(row);
    this.#scroll();
    if (approval.status === "approved" || approval.status === "denied") this.resolveApproval(row, approval.status);
    return row;
  }

  resolveApproval(row: HTMLElement, decision: "approved" | "denied"): void {
    row.classList.add("resolved");
    const status = row.querySelector<HTMLElement>(".tool-approval-status");
    if (status) status.textContent = decision === "approved" ? "Approved" : "Denied";
  }

  appendRun(text: string): HTMLElement {
    const value = document.createElement("div");
    value.className = "message run-activity";
    value.textContent = text;
    this.appendWork(value);
    return value;
  }

  appendWork(node: HTMLElement, createdAt?: string): void {
    const work = this.#ensureWork(createdAt);
    this.#touchWork(createdAt);
    work.details.append(node);
    this.#scroll();
  }

  finishWork(completedAt?: string): void {
    const work = this.#work;
    if (!work) return;
    const endedAt = Math.max(work.lastAt, this.#timestamp(completedAt));
    const label = work.toggle.querySelector<HTMLElement>(".work-summary-label");
    if (label) label.textContent = `Worked for ${this.#formatElapsed(endedAt - work.startedAt)}`;
    work.details.hidden = true;
    work.root.classList.remove("open");
    work.toggle.setAttribute("aria-expanded", "false");
    this.#work = undefined;
    this.#burst = undefined;
  }

  setRun(activity: HTMLElement, label: string, startedAt: number): void { activity.textContent = `${label}… ${this.#formatElapsed(Date.now() - startedAt)}`; }

  #ensureWork(createdAt?: string): WorkSummary {
    if (this.#work) return this.#work;
    const root = document.createElement("section"); root.className = "work-summary open";
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "work-summary-toggle"; toggle.setAttribute("aria-expanded", "true");
    const label = document.createElement("span"); label.className = "work-summary-label"; label.textContent = "Working…";
    const chevron = document.createElement("span"); chevron.className = "work-summary-chevron"; chevron.append(svgIcon('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
    const details = document.createElement("div"); details.className = "work-summary-details";
    toggle.append(label, chevron);
    toggle.addEventListener("click", () => { const open = details.hasAttribute("hidden"); details.hidden = !open; root.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); });
    root.append(toggle, details);
    this.#options.messages.append(root);
    const timestamp = this.#timestamp(createdAt);
    this.#work = { root, toggle, details, startedAt: timestamp, lastAt: timestamp };
    return this.#work;
  }

  #ensureBurst(createdAt?: string): ActivityBurst {
    if (this.#burst) return this.#burst;
    const work = this.#ensureWork(createdAt);
    const root = document.createElement("section");
    root.className = "activity-burst";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "activity-burst-toggle";
    toggle.setAttribute("aria-expanded", "false");
    const icon = document.createElement("span");
    icon.className = "agent-activity-icon";
    icon.append(svgIcon(iconPathFor("bash")));
    const label = document.createElement("span");
    label.className = "activity-burst-label";
    const chevron = document.createElement("span");
    chevron.className = "activity-burst-chevron";
    chevron.append(svgIcon('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
    const details = document.createElement("div");
    details.className = "activity-burst-details";
    details.hidden = true;
    toggle.append(icon, label, chevron);
    toggle.addEventListener("click", () => {
      const open = details.hasAttribute("hidden");
      details.hidden = !open;
      root.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
    });
    root.append(toggle, details);
    work.details.append(root);
    this.#burst = { root, toggle, icon, label, details, commands: 0, edits: 0, running: 0, tools: {} };
    return this.#burst;
  }

  #touchWork(createdAt?: string): void {
    if (this.#work) this.#work.lastAt = Math.max(this.#work.lastAt, this.#timestamp(createdAt));
  }

  #updateBurst(burst: ActivityBurst): void {
    const running = burst.running > 0;
    burst.label.textContent = summarizeBurst(burst.tools, running);
    burst.icon.replaceChildren(svgIcon(burstIconPath(burst.edits, burst.commands)));
    burst.root.classList.toggle("running", running);
  }

  async #decide(row: HTMLElement, decision: "approved" | "denied"): Promise<void> {
    const id = row.dataset.approvalId;
    if (!id) return;
    for (const button of row.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
    const status = row.querySelector<HTMLElement>(".tool-approval-status");
    if (status) status.textContent = decision === "approved" ? "Approving…" : "Denying…";
    const request = decision === "approved" && isMediaTool(row.dataset.toolName) ? this.#readMediaApproval(row) : undefined;
    try { this.resolveApproval(row, await this.#options.decideApproval(id, decision, request)); }
    catch (error) { for (const button of row.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false; if (status) status.textContent = ""; this.#options.showToast(error instanceof Error ? error.message : String(error)); }
  }

  #mediaApprovalForm(toolName: string, request: Json): HTMLElement {
    const form = document.createElement("div");
    form.className = "tool-approval-request media-approval-form";
    form.append(this.#approvalField("Prompt", "prompt", request.prompt, { multiline: true, required: true }));
    const parameters = document.createElement("div");
    parameters.className = "media-approval-parameters";
    if (toolName === "generate_image") {
      parameters.append(
        this.#approvalField("Size", "size", request.size, { placeholder: "Route default" }),
        this.#approvalField("Seed", "seed", request.seed, { type: "number", placeholder: "Random" }),
      );
      form.append(parameters, this.#approvalField("Negative prompt", "negative_prompt", request.negative_prompt, { multiline: true, placeholder: "Optional" }));
    } else if (toolName === "generate_video") {
      parameters.append(
        this.#approvalField("Duration", "duration_seconds", request.duration_seconds, { type: "number", suffix: "seconds", min: "0.1", step: "0.1", placeholder: "Route default" }),
        this.#approvalField("Resolution", "resolution", request.resolution, { placeholder: "Route default" }),
        this.#approvalField("Frame rate", "fps", request.fps, { type: "number", suffix: "fps", min: "1", step: "1", placeholder: "Route default" }),
      );
      form.append(parameters);
    } else {
      parameters.append(this.#approvalField("Duration", "duration_seconds", request.duration_seconds, { type: "number", suffix: "seconds", min: "0.1", step: "0.1", placeholder: "Route default" }));
      form.append(parameters);
    }
    if (Array.isArray(request.refs) && request.refs.length) {
      const references = document.createElement("p");
      references.className = "media-approval-references";
      references.textContent = `${request.refs.length} reference${request.refs.length === 1 ? "" : "s"} attached`;
      form.append(references);
    }
    return form;
  }

  #approvalField(labelText: string, name: string, value: unknown, options: { multiline?: boolean; required?: boolean; type?: string; suffix?: string; min?: string; step?: string; placeholder?: string } = {}): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = `media-approval-field${options.multiline ? " media-prompt-field" : ""}`;
    const title = document.createElement("span");
    title.textContent = labelText;
    const control = options.multiline ? document.createElement("textarea") : document.createElement("input");
    control.dataset.approvalField = name;
    if (control instanceof HTMLInputElement) control.type = options.type ?? "text";
    control.value = value === undefined || value === null ? "" : String(value);
    control.required = Boolean(options.required);
    if (options.placeholder) control.placeholder = options.placeholder;
    if (control instanceof HTMLInputElement) {
      if (options.min) control.min = options.min;
      if (options.step) control.step = options.step;
    }
    const shell = document.createElement("span");
    shell.className = "media-approval-control";
    shell.append(control);
    if (options.suffix) shell.append(Object.assign(document.createElement("span"), { className: "media-approval-suffix", textContent: options.suffix }));
    label.append(title, shell);
    return label;
  }

  #readMediaApproval(row: HTMLElement): Json {
    const request = { ...(this.#approvalRequests.get(row) ?? {}) };
    for (const control of row.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-approval-field]")) {
      const name = control.dataset.approvalField!;
      const value = control.value.trim();
      if (!value) delete request[name];
      else request[name] = control instanceof HTMLInputElement && control.type === "number" ? Number(value) : value;
    }
    return request;
  }

  #renderShell(details: HTMLElement, input: unknown, running: boolean): void {
    details.classList.add("shell-details");
    const title = document.createElement("span"); title.className = "shell-title"; title.textContent = "Shell";
    const command = document.createElement("pre"); command.className = "shell-command"; command.textContent = this.#shellCommand(input);
    const output = document.createElement("pre"); output.className = "shell-output"; output.textContent = running ? "Running…" : "No output";
    const status = document.createElement("span"); status.className = "shell-status"; status.textContent = running ? "Running…" : "✓ Success";
    details.append(title, command, output, status);
  }

  #detail(label: string, value: unknown, className: string): HTMLElement {
    const section = document.createElement("section"); section.className = `tool-activity-detail ${className}`;
    const heading = document.createElement("span"); heading.className = "tool-activity-detail-label"; heading.textContent = label;
    const content = document.createElement("pre"); content.className = "tool-activity-value"; content.textContent = this.#formatPayload(value, "Waiting for result…");
    section.append(heading, content); return section;
  }

  #resourceReference(toolName: string, input: unknown): string | undefined {
    if (!["edit", "write", "read"].includes(toolName)) return undefined;
    return toolPath(input);
  }

  #registerSearchRoot(input: unknown): void {
    const path = toolPath(input);
    if (!path || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return;
    this.#searchRoots.delete(path); this.#searchRoots.add(path);
    while (this.#searchRoots.size > 32) this.#searchRoots.delete(this.#searchRoots.values().next().value!);
  }

  #shellCommand(input: unknown): string { if (input && typeof input === "object") { const value = input as Json; const command = value.command ?? value.cmd; if (typeof command === "string") return command; } return this.#formatPayload(input, "Command unavailable"); }
  #shellOutput(result: unknown): string { if (result && typeof result === "object") { const content = (result as Json).content; if (Array.isArray(content)) { const text = content.filter((item) => item && typeof item === "object" && typeof item.text === "string").map((item) => item.text).join(""); if (text) return text.trimEnd(); } } return this.#formatPayload(result, "No output"); }
  #formatPayload(value: unknown, emptyLabel: string): string { if (value === undefined || value === null) return emptyLabel; const raw = typeof value === "string" ? value : this.#safeStringify(value); return raw.length > 50_000 ? `${raw.slice(0, 50_000)}\n… ${raw.length - 50_000} more characters` : raw; }
  #safeStringify(value: unknown): string { try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); } }
  #button(label: string, className?: string): HTMLButtonElement { const button = document.createElement("button"); button.type = "button"; if (className) button.className = className; button.textContent = label; return button; }
  #timestamp(value?: string): number { if (value) { const timestamp = Date.parse(value); if (Number.isFinite(timestamp)) return timestamp; } return Date.now(); }
  #formatElapsed(value: number): string {
    const seconds = Math.max(0, Math.floor(value / 1_000));
    const minutes = Math.floor(seconds / 60);
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
  }
  #removeLanding(): void { if (this.#options.messages.querySelector(".landing, .new-chat-landing")) this.#options.messages.replaceChildren(); }
  #scroll(): void { this.#options.messages.scrollTop = this.#options.messages.scrollHeight; }
}
