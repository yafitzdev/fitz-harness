import { reconnectDelay } from "@fitz/connectivity/reconnect";
import type { ActionFeedback } from "../primitives/action-status.js";

import { mediaJobIdFromToolResult } from "./media-job-tracker.js";
import { scrollToLatestIfFollowing } from "./conversation-scroll.js";

type Json = Record<string, any>;

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
  completeTool(row: HTMLElement, toolName: string, input: unknown, result: unknown, isError: boolean): void;
  finishWork(completedAt?: string): void;
}

export interface AgentRunRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  sessionId: string;
  accessMode: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
}

export interface AgentRunControllerOptions {
  messages: HTMLElement;
  activity: AgentRunActivity;
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  appendAssistant: () => HTMLElement;
  appendAssistantDelta: (target: HTMLElement, delta: string) => void;
  appendSystem: (message: string) => void;
  appendChangeSummary: (files: Array<{ path: string; action: "edited" | "created" }>) => void;
  addTokenEstimate: (text: string) => void;
  /** Reset the live context estimate to an authoritative number (e.g. after an automatic compaction). */
  recalibrateEstimate: (tokens: number) => void;
  setStatus: (label: string, state: string) => void;
  setEngineState: (state: string) => void;
  refreshControls: () => void;
  queueVisible: () => boolean;
  refreshQueue: () => void | Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  terminalReplayError: (error: unknown) => boolean;
  /** Start following an asynchronous image/audio/video job submitted by an agent tool. */
  onMediaJobSubmitted?: (jobId: string, toolName: string) => void;
}

/** Owns agent-run submission, event replay, reconnect, cancellation, and model warmup state. */
export class AgentRunController {
  readonly #options: AgentRunControllerOptions;
  #runId: string | undefined;
  #starting = false;
  #cancelPending = false;
  #lastSequence = 0;
  #warmupTimer: ReturnType<typeof setTimeout> | undefined;
  #composerHadText = false;

  constructor(options: AgentRunControllerOptions) { this.#options = options; }

  get active(): boolean { return this.#starting || Boolean(this.#runId); }
  get runId(): string | undefined { return this.#runId; }

  resetWarmup(): void {
    this.#composerHadText = false;
    if (this.#warmupTimer) clearTimeout(this.#warmupTimer);
    this.#warmupTimer = undefined;
  }

  scheduleWarmup(prompt: string, model: string): void {
    if (!prompt.length) { this.resetWarmup(); return; }
    if (this.#composerHadText || this.active || !model) return;
    this.#composerHadText = true;
    this.#warmupTimer = setTimeout(() => {
      this.#warmupTimer = undefined;
      void this.#options.api("/api/v1/inference/warm", "POST", { model })
        .catch(() => { this.#composerHadText = false; });
    }, 120);
  }

  async start(request: AgentRunRequest): Promise<void> {
    if (this.active) return;
    this.resetWarmup();
    const activity = this.#options.activity.appendRun("Working");
    const startedAt = Date.now();
    this.#starting = true;
    this.#cancelPending = false;
    this.#lastSequence = 0;
    this.#options.setStatus("Queued", "loading");
    this.#options.setEngineState("QUEUED");
    this.#options.refreshControls();
    try {
      const response = await this.#options.api("/api/v1/agent/runs", "POST", request);
      this.#runId = String(response.data.id);
      this.#starting = false;
      if (response.context?.compacted) {
        this.#options.activity.appendContext();
        // The host reported an automatic compaction: the session context shrank to the
        // checkpoint summary plus the recent window, so reset the meter to match.
        const compactedEstimate = Number(response.context.estimatedContextTokens);
        if (Number.isFinite(compactedEstimate) && compactedEstimate >= 0) this.#options.recalibrateEstimate(compactedEstimate);
      }
      if (this.#cancelPending) await this.#options.api(`/api/v1/agent/runs/${this.#runId}`, "DELETE");
      await this.#follow(this.#runId, activity, startedAt);
    } catch (error) {
      activity.remove();
      this.#options.appendSystem(this.#options.errorMessage(error));
      this.#options.setStatus("Failed", "error");
      this.#options.activity.finishWork();
    } finally {
      this.#runId = undefined;
      this.#starting = false;
      this.#cancelPending = false;
      this.#options.refreshControls();
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.#cancelPending = true;
    this.#options.setStatus("Stopping", "loading");
    this.#options.refreshControls();
    if (!this.#runId) return;
    try {
      await this.#options.api(`/api/v1/agent/runs/${this.#runId}`, "DELETE");
    } catch (error) {
      this.#cancelPending = false;
      this.#options.showStatus(this.#options.errorMessage(error), "error");
      this.#options.refreshControls();
    }
  }

  /** Insert a message into the running conversation. The host forwards it to the active stream. */
  async steer(text: string): Promise<void> {
    if (!this.#runId) throw new Error("No active run to steer");
    await this.#options.api(`/api/v1/agent/runs/${this.#runId}/steer`, "POST", { text });
  }

  async #follow(runId: string, activity: HTMLElement, startedAt: number): Promise<void> {
    let assistant: HTMLElement | undefined;
    let reasoning: HTMLElement | undefined;
    const tools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
    const approvals = new Map<string, HTMLElement>();
    const changedFiles = new Map<string, "edited" | "created">();
    let done = false;
    let queued = true;
    let reconnectAttempt = 0;
    let nextEnginePoll = 0;
    let mediaHandedOff = false;
    while (!done && this.#runId === runId) {
      let replay: Json;
      try {
        replay = await this.#options.api(`/api/v1/agent/runs/${runId}/events?after=${this.#lastSequence}`);
        reconnectAttempt = 0;
      } catch (error) {
        if (this.#options.terminalReplayError(error) || reconnectAttempt >= 12) throw error;
        this.#options.setStatus(`Reconnecting ${reconnectAttempt + 1}`, "loading");
        await this.#delay(reconnectDelay(reconnectAttempt++));
        continue;
      }
      for (const event of replay.events ?? []) {
        this.#lastSequence = Number(event.sequence ?? this.#lastSequence);
        if (event.type === "run.queue.updated") {
          queued = event.data?.status === "queued";
          if (queued) {
            const position = Math.max(1, Number(event.data?.position ?? 1));
            this.#options.setStatus(`Queued ${position}`, "loading");
            this.#options.setEngineState("QUEUED");
            this.#options.activity.setRun(activity, position === 1 ? "Queued · next" : `Queued · ${position - 1} ahead`, startedAt);
          }
          if (this.#options.queueVisible()) void this.#options.refreshQueue();
        }
        if (event.type === "run.started") {
          queued = false;
          this.#options.setStatus("Working", "active");
          this.#options.setEngineState("WORKING");
          this.#options.activity.setRun(activity, "Working", startedAt);
        }
        if (event.type === "assistant.delta") {
          if (!assistant) { activity.remove(); assistant = this.#options.appendAssistant(); }
          const delta = String(event.data?.text ?? "");
          this.#options.appendAssistantDelta(assistant, delta);
          this.#options.addTokenEstimate(delta);
          scrollToLatestIfFollowing(this.#options.messages);
        }
        if (event.type === "reasoning.delta") {
          // Model thinking streams into its own collapsible activity row, separate
          // from the assistant bubble: it is never persisted as a chat message and
          // never re-sent to the model as context.
          const delta = String(event.data?.text ?? "");
          if (delta) {
            if (!reasoning) { activity.remove(); reasoning = this.#options.activity.appendReasoning(true); }
            this.#options.activity.appendReasoningDelta(reasoning, delta);
            this.#options.addTokenEstimate(delta);
          }
        }
        if (event.type === "reasoning.completed") {
          if (reasoning) { this.#options.activity.completeReasoning(reasoning); reasoning = undefined; }
        }
        if (event.type === "user.steer") {
          // A steering message was delivered into the running conversation; the next
          // deltas answer it, so start a fresh assistant bubble instead of merging
          // into the previous turn's text.
          assistant = undefined;
        }
        if (event.type === "tool.approval.requested") {
          const approvalId = String(event.data?.approvalId ?? "");
          activity.remove();
          if (assistant) { this.#options.activity.markAssistantAsCommentary(assistant); assistant = undefined; }
          if (reasoning) { this.#options.activity.completeReasoning(reasoning); reasoning = undefined; }
          approvals.set(approvalId, this.#options.activity.appendApproval({ id: approvalId, toolName: String(event.data?.toolName ?? "tool"), request: event.data?.input ?? {}, status: "pending" }));
          this.#options.setStatus("Waiting for approval", "active");
          this.#options.setEngineState("WAITING");
        }
        if (event.type === "tool.approval.resolved") {
          const approvalId = String(event.data?.approvalId ?? "");
          const decision = event.data?.decision === "approved" ? "approved" : "denied";
          const approval = approvals.get(approvalId) ?? this.#options.messages.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(approvalId)}"]`);
          if (approval) this.#options.activity.resolveApproval(approval, decision);
          this.#options.setStatus("Working", "active");
          this.#options.setEngineState("WORKING");
        }
        if (event.type === "tool.started") {
          const toolName = String(event.data?.toolName ?? "tool");
          const toolCallId = String(event.data?.toolCallId ?? `${toolName}-${event.sequence}`);
          const input = event.data?.input;
          activity.remove();
          if (assistant) { this.#options.activity.markAssistantAsCommentary(assistant); assistant = undefined; }
          if (reasoning) { this.#options.activity.completeReasoning(reasoning); reasoning = undefined; }
          tools.set(toolCallId, { row: this.#options.activity.appendTool(toolName, input, toolCallId, true), toolName, input });
          this.#options.addTokenEstimate(stringifyForEstimate(input));
          this.#options.setStatus(`Running ${toolName}`, "active");
          this.#options.setEngineState(toolName.toUpperCase());
        }
        if (event.type === "tool.completed") {
          const toolCallId = String(event.data?.toolCallId ?? "");
          const existing = tools.get(toolCallId);
          if (existing) this.#options.activity.completeTool(existing.row, existing.toolName, existing.input, event.data?.result, Boolean(event.data?.isError));
          this.#options.addTokenEstimate(stringifyForEstimate(event.data?.result));
          const mediaJobId = mediaJobIdFromToolResult(event.data?.result);
          if (mediaJobId) {
            mediaHandedOff = true;
            this.#options.onMediaJobSubmitted?.(mediaJobId, existing?.toolName ?? String(event.data?.toolName ?? "generate_video"));
          }
          // Track file changes from write/edit tools (updated)
          if (existing && (existing.toolName === "write" || existing.toolName === "edit") && !Boolean(event.data?.isError)) {
            const input = existing.input;
            if (input && typeof input === "object" && "path" in input && typeof input.path === "string") {
              changedFiles.set(input.path, existing.toolName === "write" ? "created" : "edited");
            }
          }
          this.#options.setStatus("Working", "active");
          this.#options.setEngineState("WORKING");
        }
        if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) {
          done = true;
          if (reasoning) { this.#options.activity.completeReasoning(reasoning); reasoning = undefined; }
          const success = event.type === "run.completed";
          this.#options.setStatus(success ? "Ready" : event.type.slice(4), success ? "idle" : "error");
          this.#options.setEngineState(success || event.type === "run.cancelled" ? "READY" : event.type.slice(4).toUpperCase());
          activity.remove();
          if (!success && event.data?.error && event.type !== "run.cancelled") this.#options.appendSystem(String(event.data.error));
          // A media tool deliberately ends the Pi turn as soon as its durable
          // background job exists. No assistant text is expected at this point:
          // MediaJobTracker owns the eventual final answer/artifact card.
          if (success && !assistant && !mediaHandedOff) this.#options.appendSystem("The model completed without returning a response.");
          // Show change summary if files were modified
          if (success && changedFiles.size > 0) {
            this.#options.appendChangeSummary([...changedFiles.entries()].map(([path, action]) => ({ path, action })));
          }
          // Media tools return after durable submission while the GPU job keeps
          // running in the background. Keep the outer work disclosure active;
          // MediaJobTracker closes it with the true terminal timestamp.
          if (!mediaHandedOff) this.#options.activity.finishWork();
        }
      }
      if (!done && !queued && !assistant && Date.now() >= nextEnginePoll) {
        nextEnginePoll = Date.now() + 1_000;
        try {
          const management = await this.#options.api("/api/v1/management/status");
          const state = String(management.engine?.state ?? "");
          this.#options.setEngineState(state || "WORKING");
          if (state === "READY" || state === "BUSY") this.#options.activity.setRun(activity, "Thinking", startedAt);
          else if (state === "FAILED") activity.textContent = `Model failed: ${management.engine?.failureReason ?? "Unknown error"}`;
          else this.#options.activity.setRun(activity, "Working", startedAt);
        } catch { this.#options.activity.setRun(activity, "Working", startedAt); }
      }
      if (!done) await this.#delay(350);
    }
  }

  #delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
}

/** Text form of a tool input/result for context estimation; structured payloads become JSON. */
function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
