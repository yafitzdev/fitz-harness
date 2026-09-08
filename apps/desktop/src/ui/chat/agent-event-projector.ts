import { mediaJobIdFromToolResult } from "./media-job-tracker.js";
import { scrollToLatestIfFollowing } from "./conversation-scroll.js";

export type Json = Record<string, any>;

export interface AgentRunActivity {
  appendRun(label: string): HTMLElement;
  setRun(activity: HTMLElement, label: string, startedAt: number): void;
  appendContext(label?: string): HTMLElement;
  markAssistantAsCommentary(content: HTMLElement): void;
  appendReasoning(running: boolean): HTMLElement;
  appendReasoningDelta(row: HTMLElement, text: string): void;
  completeReasoning(row: HTMLElement): void;
  appendApproval(approval: Json): HTMLElement;
  resolveApproval(row: HTMLElement, decision: "approved" | "denied"): void;
  appendTool(toolName: string, input: unknown, toolCallId: string, running: boolean): HTMLElement;
  completeTool(row: HTMLElement, toolName: string, input: unknown, result: unknown, isError: boolean, completedAt?: string): void;
  finishWork(completedAt?: string): void;
}

export interface AgentEventProjectorOptions {
  runId: string;
  startedAt: number;
  activityRoot: HTMLElement;
  messages: HTMLElement;
  activity: AgentRunActivity;
  appendAssistant: (runId: string, createdAt?: string) => HTMLElement;
  appendAssistantDelta: (target: HTMLElement, delta: string) => void;
  replaceAssistant: (target: HTMLElement, text: string) => void;
  loadFinalAssistant?: (runId: string) => Promise<{ text: string; createdAt?: string } | undefined>;
  appendSystem: (message: string) => void;
  appendChangeSummary: (files: Array<{ path: string; action: "edited" | "created" }>) => void;
  registerGeneratedFile?: (path: string, action: "edited" | "created") => void;
  addTokenEstimate: (text: string) => void;
  setStatus: (label: string, state: string) => void;
  setEngineState: (state: string) => void;
  updatePlan: (result: unknown) => void;
  clearPlan: () => void;
  findApproval: (approvalId: string) => HTMLElement | undefined;
  findTool: (toolCallId: string) => { row: HTMLElement; toolName: string; input: unknown } | undefined;
  onMediaJobSubmitted?: (jobId: string, toolName: string) => void;
  yieldToPaint: () => Promise<void>;
  /** False after the user leaves the conversation or another run replaces this projection. */
  isCurrent?: () => boolean;
}

type ToolState = { row: HTMLElement; toolName: string; input: unknown };

/**
 * Projects normalized durable agent events into the chat view.
 *
 * This is deliberately independent of the event transport. A run can be
 * replayed from SQLite, delivered by SSE, or resumed after reconnecting; all
 * of those paths feed the same stateful projection here.
 */
export class AgentEventProjector {
  readonly #options: AgentEventProjectorOptions;
  #assistant: HTMLElement | undefined;
  #assistantText = "";
  #reasoning: HTMLElement | undefined;
  readonly #tools = new Map<string, ToolState>();
  readonly #planToolCalls = new Set<string>();
  readonly #approvals = new Map<string, HTMLElement>();
  readonly #changedFiles = new Map<string, "edited" | "created">();
  #done = false;
  #queued = true;
  #mediaHandedOff = false;

  constructor(options: AgentEventProjectorOptions) { this.#options = options; }

  get done(): boolean { return this.#done; }
  get queued(): boolean { return this.#queued; }
  get hasOpenOutput(): boolean { return Boolean(this.#assistant || this.#reasoning); }
  get mediaHandedOff(): boolean { return this.#mediaHandedOff; }

  async apply(event: Json): Promise<void> {
    if (this.#done || this.#options.isCurrent?.() === false) return;
    const data = event.data as Json | undefined;
    if (event.type === "run.queue.updated") this.#queueUpdated(data);
    if (event.type === "run.started") this.#runStarted();
    if (event.type === "assistant.delta") this.#assistantDelta(event);
    if (event.type === "reasoning.delta") await this.#reasoningDelta(event);
    if (event.type === "reasoning.completed") this.#completeReasoning();
    if (event.type === "user.steer") this.#steerDelivered();
    if (event.type === "tool.approval.requested") this.#approvalRequested(data);
    if (event.type === "tool.approval.resolved") this.#approvalResolved(data);
    if (event.type === "tool.started") this.#toolStarted(event, data);
    if (event.type === "tool.completed") await this.#toolCompleted(event, data);
    if (isTerminalEvent(event.type)) await this.#runFinished(event, data);
  }

  #queueUpdated(data: Json | undefined): void {
    this.#queued = data?.status === "queued";
    if (!this.#queued) return;
    const position = Math.max(1, Number(data?.position ?? 1));
    this.#options.setStatus(`Queued ${position}`, "loading");
    this.#options.setEngineState("QUEUED");
    this.#options.activity.setRun(this.#options.activityRoot, position === 1 ? "Queued · next" : `Queued · ${position - 1} ahead`, this.#options.startedAt);
  }

  #runStarted(): void {
    this.#queued = false;
    this.#options.setStatus("Working", "active");
    this.#options.setEngineState("WORKING");
    this.#options.activity.setRun(this.#options.activityRoot, "Working", this.#options.startedAt);
  }

  #assistantDelta(event: Json): void {
    if (!this.#assistant) {
      this.#options.activityRoot.remove();
      this.#assistant = this.#options.appendAssistant(this.#options.runId, typeof event.timestamp === "string" ? event.timestamp : undefined);
    }
    const delta = String(event.data?.text ?? "");
    this.#options.appendAssistantDelta(this.#assistant, delta);
    this.#assistantText += delta;
    this.#options.addTokenEstimate(delta);
    scrollToLatestIfFollowing(this.#options.messages);
  }

  async #reasoningDelta(event: Json): Promise<void> {
    // Provider-native reasoning streams as visible prose between tool bursts.
    // It remains outside the assistant bubble and is never re-sent as context.
    const delta = String(event.data?.text ?? "");
    if (!delta) return;
    if (!this.#reasoning) {
      this.#options.activityRoot.remove();
      this.#reasoning = this.#options.activity.appendReasoning(true);
    }
    this.#options.activity.appendReasoningDelta(this.#reasoning, delta);
    this.#options.addTokenEstimate(delta);
    await this.#options.yieldToPaint();
  }

  #completeReasoning(): void {
    if (!this.#reasoning) return;
    this.#options.activity.completeReasoning(this.#reasoning);
    this.#reasoning = undefined;
  }

  #steerDelivered(): void {
    // A steering message starts a fresh assistant bubble instead of merging
    // the next answer into the previous turn's text.
    this.#assistant = undefined;
    this.#assistantText = "";
  }

  #approvalRequested(data: Json | undefined): void {
    const approvalId = String(data?.approvalId ?? "");
    this.#options.activityRoot.remove();
    if (this.#assistant) {
      this.#options.activity.markAssistantAsCommentary(this.#assistant);
      this.#assistant = undefined;
      this.#assistantText = "";
    }
    this.#completeReasoning();
    // Pending approvals are also restored separately before event replay.
    // Keep one actionable card and resolve that same card when work continues.
    const approval = this.#approvals.get(approvalId) ?? this.#options.findApproval(approvalId) ?? this.#options.activity.appendApproval({
      id: approvalId,
      toolName: String(data?.toolName ?? "tool"),
      request: data?.input ?? {},
      status: "pending",
    });
    this.#approvals.set(approvalId, approval);
    this.#options.setStatus("Waiting for approval", "active");
    this.#options.setEngineState("WAITING");
  }

  #approvalResolved(data: Json | undefined): void {
    const approvalId = String(data?.approvalId ?? "");
    const decision = data?.decision === "approved" ? "approved" : "denied";
    const approval = this.#approvals.get(approvalId) ?? this.#options.findApproval(approvalId);
    if (approval) this.#options.activity.resolveApproval(approval, decision);
    this.#options.setStatus("Working", "active");
    this.#options.setEngineState("WORKING");
  }

  #toolStarted(event: Json, data: Json | undefined): void {
    const toolName = String(data?.toolName ?? "tool");
    const toolCallId = String(data?.toolCallId ?? `${toolName}-${event.sequence}`);
    const input = data?.input;
    this.#options.activityRoot.remove();
    if (this.#assistant) {
      this.#options.activity.markAssistantAsCommentary(this.#assistant);
      this.#assistant = undefined;
      this.#assistantText = "";
    }
    this.#completeReasoning();
    this.#options.addTokenEstimate(stringifyForEstimate(input));
    if (toolName === "agent_plan") {
      this.#planToolCalls.add(toolCallId);
      this.#options.setStatus("Updating tasks", "active");
      this.#options.setEngineState("WORKING");
      return;
    }
    this.#tools.set(toolCallId, {
      row: this.#options.activity.appendTool(toolName, input, toolCallId, true),
      toolName,
      input,
    });
    this.#options.setStatus(`Running ${toolName}`, "active");
    this.#options.setEngineState(toolName.toUpperCase());
  }

  async #toolCompleted(event: Json, data: Json | undefined): Promise<void> {
    const toolCallId = String(data?.toolCallId ?? "");
    let existing = this.#tools.get(toolCallId);
    const completedToolName = this.#planToolCalls.has(toolCallId) ? "agent_plan" : existing?.toolName ?? String(data?.toolName ?? "tool");
    if (completedToolName === "agent_plan") {
      this.#planToolCalls.delete(toolCallId);
      this.#options.updatePlan(data?.result);
      this.#options.addTokenEstimate(stringifyForEstimate(data?.result));
      this.#options.setStatus("Working", "active");
      this.#options.setEngineState("WORKING");
      return;
    }
    if (!existing) existing = this.#options.findTool(toolCallId);
    if (existing) this.#options.activity.completeTool(existing.row, existing.toolName, existing.input, data?.result, Boolean(data?.isError));
    this.#options.addTokenEstimate(stringifyForEstimate(data?.result));
    const mediaJobId = mediaJobIdFromToolResult(data?.result);
    if (mediaJobId) {
      this.#mediaHandedOff = true;
      this.#options.onMediaJobSubmitted?.(mediaJobId, existing?.toolName ?? String(data?.toolName ?? "generate_video"));
    }
    if (existing && (existing.toolName === "write" || existing.toolName === "edit") && !Boolean(data?.isError)) {
      const input = existing.input;
      if (input && typeof input === "object" && "path" in input && typeof input.path === "string") {
        const action = existing.toolName === "write" ? "created" : "edited";
        this.#changedFiles.set(input.path, action);
        this.#options.registerGeneratedFile?.(input.path, action);
      }
    }
    this.#options.setStatus("Working", "active");
    this.#options.setEngineState("WORKING");
  }

  async #runFinished(event: Json, data: Json | undefined): Promise<void> {
    this.#done = true;
    this.#completeReasoning();
    const success = event.type === "run.completed";
    this.#options.setStatus(success ? "Ready" : event.type.slice(4), success ? "idle" : "error");
    this.#options.setEngineState(success || event.type === "run.cancelled" ? "READY" : event.type.slice(4).toUpperCase());
    this.#options.activityRoot.remove();
    if (!success && data?.error && event.type !== "run.cancelled") {
      const error = String(data.error);
      this.#options.appendSystem(error === "host_restarted"
        ? "The host restarted before this reply finished."
        : error === "host_shutdown" ? "The host shut down before this reply finished." : error);
    }
    if (success && !this.#mediaHandedOff && this.#options.loadFinalAssistant) await this.#reconcileFinalAssistant();
    if (this.#options.isCurrent?.() === false) return;
    // A media tool ends Pi's turn after durable submission; its tracker owns
    // the eventual work disclosure and final answer.
    if (success && !this.#assistant && !this.#mediaHandedOff) this.#options.appendSystem("The model completed without returning a response.");
    if (success && this.#changedFiles.size > 0) {
      this.#options.appendChangeSummary([...this.#changedFiles.entries()].map(([path, action]) => ({ path, action })));
    }
    if (!this.#mediaHandedOff) this.#options.activity.finishWork();
    this.#options.clearPlan();
  }

  async #reconcileFinalAssistant(): Promise<void> {
    try {
      const recovered = await this.#options.loadFinalAssistant?.(this.#options.runId);
      if (this.#options.isCurrent?.() === false) return;
      if (!recovered?.text) return;
      if (!this.#assistant) {
        this.#assistant = this.#options.appendAssistant(this.#options.runId, recovered.createdAt);
        this.#options.appendAssistantDelta(this.#assistant, recovered.text);
        this.#options.addTokenEstimate(recovered.text);
      } else if (this.#assistantText !== recovered.text) {
        this.#options.replaceAssistant(this.#assistant, recovered.text);
      }
      this.#assistantText = recovered.text;
    } catch {
      // Keep the streamed answer if transcript reconciliation is temporarily offline.
    }
  }
}

function isTerminalEvent(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.interrupted";
}

/** Text form of a tool input/result for context estimation; structured payloads become JSON. */
function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
