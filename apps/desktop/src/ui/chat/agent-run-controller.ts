import { reconnectDelay } from "@fitz/connectivity/reconnect";
import type { ActionFeedback } from "../primitives/action-status.js";
import type { AgentEffort } from "@fitz/protocol";

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
  completeTool(row: HTMLElement, toolName: string, input: unknown, result: unknown, isError: boolean, completedAt?: string): void;
  finishWork(completedAt?: string): void;
}

export interface AgentRunRequest {
  model: string;
  effort: AgentEffort;
  max_tokens: number;
  temperature: number;
  sessionId: string;
  accessMode: string;
  clientRequestId?: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
}

export interface AgentRunControllerOptions {
  messages: HTMLElement;
  activity: AgentRunActivity;
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  /** Subscribe to the host's normalized live agent feed. Polling remains a
   * compatibility fallback for tests and older shells. */
  subscribeAgentEvents?: (
    input: { runId: string; after: number },
    listener: (message: AgentEventStreamMessage) => void,
  ) => () => void;
  /** Gives the browser a paint boundary between native reasoning deltas. */
  yieldToPaint?: () => Promise<void>;
  appendAssistant: (runId: string, createdAt?: string) => HTMLElement;
  appendAssistantDelta: (target: HTMLElement, delta: string) => void;
  replaceAssistant: (target: HTMLElement, text: string) => void;
  /** Reads the host's durable final transcript when the live relay reaches
   * completion so the rendered answer can be reconciled with durable state. */
  loadFinalAssistant?: (runId: string) => Promise<{ text: string; createdAt?: string } | undefined>;
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
  /** Replace the composer-adjacent plan artifact with the newest durable revision. */
  updatePlan: (result: unknown) => void;
  /** Remove the plan after the run has emitted its terminal answer/state. */
  clearPlan: () => void;
  /** Refresh runtime-derived capabilities after a run may have loaded a model. */
  onRunSettled?: () => void | Promise<void>;
  refreshAssistantPerformance?: (runId: string) => void | Promise<void>;
  /** Start following an asynchronous image/audio/video job submitted by an agent tool. */
  onMediaJobSubmitted?: (jobId: string, toolName: string) => void;
}

type AgentEventStreamMessage =
  | { type: "event"; event: Json }
  | { type: "end" }
  | { type: "error"; error: string };

type AgentEventStreamDelivery = AgentEventStreamMessage | { type: "idle" };

/** Owns agent-run submission, event replay, reconnect, cancellation, and model warmup state. */
export class AgentRunController {
  readonly #options: AgentRunControllerOptions;
  #runId: string | undefined;
  #starting = false;
  #cancelPending = false;
  #lastSequence = 0;
  #warmupTimer: ReturnType<typeof setTimeout> | undefined;
  #composerHadText = false;
  #generation = 0;

  constructor(options: AgentRunControllerOptions) { this.#options = options; }

  get active(): boolean { return this.#starting || Boolean(this.#runId); }
  get runId(): string | undefined { return this.#runId; }

  /** Stop following locally without cancelling the host run. Used when the
   * user switches chats; selecting the chat again reattaches from SQLite. */
  detach(): void {
    this.#generation += 1;
    this.#runId = undefined;
    this.#starting = false;
    this.#cancelPending = false;
    this.#options.refreshControls();
  }

  async attach(run: { id: string; createdAt?: string }, afterSequence = 0): Promise<void> {
    if (this.active) return;
    const generation = ++this.#generation;
    const activity = this.#options.activity.appendRun("Reconnecting");
    const startedAt = Date.parse(run.createdAt ?? "") || Date.now();
    this.#runId = run.id;
    this.#lastSequence = Math.max(0, afterSequence);
    this.#cancelPending = false;
    this.#options.setStatus("Reconnecting", "loading");
    this.#options.refreshControls();
    try { await this.#follow(run.id, activity, startedAt, generation); }
    catch (error) { activity.remove(); this.#options.appendSystem(this.#options.errorMessage(error)); this.#options.setStatus("Disconnected", "error"); }
    finally { if (this.#generation === generation) { this.#runId = undefined; this.#cancelPending = false; this.#options.refreshControls(); } }
  }

  async resume(sourceRunId: string, confirmUnsafe = false): Promise<void> {
    if (this.active) return;
    const generation = ++this.#generation;
    const activity = this.#options.activity.appendRun("Resuming");
    this.#starting = true;
    this.#lastSequence = 0;
    this.#options.setStatus("Resuming", "loading");
    this.#options.refreshControls();
    try {
      const response = await this.#options.api(`/api/v1/agent/runs/${sourceRunId}/resume`, "POST", { confirmUnsafe });
      const runId = String(response.data.id);
      this.#runId = runId; this.#starting = false;
      await this.#follow(runId, activity, Date.now(), generation);
    } catch (error) {
      activity.remove();
      this.#options.appendSystem(this.#options.errorMessage(error));
      this.#options.setStatus("Resume failed", "error");
      throw error;
    }
    finally { if (this.#generation === generation) { this.#runId = undefined; this.#starting = false; this.#cancelPending = false; this.#options.refreshControls(); } }
  }

  resetWarmup(): void {
    this.#composerHadText = false;
    if (this.#warmupTimer) clearTimeout(this.#warmupTimer);
    this.#warmupTimer = undefined;
  }

  scheduleWarmup(prompt: string, model: string): void {
    if (!prompt.length) { this.resetWarmup(); return; }
    // Smart is a consumer-owned cloud endpoint; only the pinned local Default
    // has a host process worth warming while the user types.
    if (model !== "default") return;
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
    const generation = ++this.#generation;
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
      const durableRequest = { ...request, clientRequestId: request.clientRequestId ?? crypto.randomUUID() };
      let response: Json | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try { response = await this.#options.api("/api/v1/agent/runs", "POST", durableRequest); break; }
        catch (error) {
          if (this.#options.terminalReplayError(error) || attempt === 3) throw error;
          this.#options.setStatus(`Submitting · retry ${attempt + 1}`, "loading");
          await this.#delay(reconnectDelay(attempt));
        }
      }
      if (!response) throw new Error("The run could not be created");
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
      await this.#follow(this.#runId, activity, startedAt, generation);
    } catch (error) {
      activity.remove();
      this.#options.appendSystem(this.#options.errorMessage(error));
      this.#options.setStatus("Failed", "error");
      this.#options.activity.finishWork();
    } finally {
      if (this.#generation === generation) {
        this.#runId = undefined;
        this.#starting = false;
        this.#cancelPending = false;
        this.#options.refreshControls();
      }
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

  async #follow(runId: string, activity: HTMLElement, startedAt: number, generation: number): Promise<void> {
    let assistant: HTMLElement | undefined;
    let assistantText = "";
    let reasoning: HTMLElement | undefined;
    const tools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
    const planToolCalls = new Set<string>();
    const approvals = new Map<string, HTMLElement>();
    const changedFiles = new Map<string, "edited" | "created">();
    let done = false;
    let queued = true;
    let reconnectAttempt = 0;
    let nextEnginePoll = 0;
    let mediaHandedOff = false;
    let eventStream: AgentEventInbox | undefined;
    let unsubscribeEventStream: (() => void) | undefined;
    const connectEventStream = () => {
      if (!this.#options.subscribeAgentEvents) return;
      const inbox = new AgentEventInbox();
      eventStream = inbox;
      unsubscribeEventStream = this.#options.subscribeAgentEvents(
        { runId, after: this.#lastSequence },
        (message) => inbox.push(message),
      );
    };
    connectEventStream();
    try {
      while (!done && this.#runId === runId && this.#generation === generation) {
        let replay: Json;
        if (eventStream) {
          const delivery = await eventStream.next(1_000);
          if (this.#runId !== runId || this.#generation !== generation) break;
          if (delivery.type === "event") {
            replay = { events: [delivery.event] };
            reconnectAttempt = 0;
          } else if (delivery.type === "idle") {
            replay = { events: [] };
          } else {
            unsubscribeEventStream?.();
            unsubscribeEventStream = undefined;
            eventStream = undefined;
            const error = new Error(delivery.type === "error" ? delivery.error : "The agent event stream ended before the run reached a terminal state");
            if (reconnectAttempt >= 12) throw error;
            this.#options.setStatus(`Reconnecting ${reconnectAttempt + 1}`, "loading");
            await this.#delay(reconnectDelay(reconnectAttempt++));
            connectEventStream();
            continue;
          }
        } else {
          try {
            replay = await this.#options.api(`/api/v1/agent/runs/${runId}/events?after=${this.#lastSequence}`);
            reconnectAttempt = 0;
          } catch (error) {
            if (this.#options.terminalReplayError(error) || reconnectAttempt >= 12) throw error;
            this.#options.setStatus(`Reconnecting ${reconnectAttempt + 1}`, "loading");
            await this.#delay(reconnectDelay(reconnectAttempt++));
            continue;
          }
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
          if (!assistant) { activity.remove(); assistant = this.#options.appendAssistant(runId, typeof event.timestamp === "string" ? event.timestamp : undefined); }
          const delta = String(event.data?.text ?? "");
          this.#options.appendAssistantDelta(assistant, delta);
          assistantText += delta;
          this.#options.addTokenEstimate(delta);
          scrollToLatestIfFollowing(this.#options.messages);
        }
        if (event.type === "reasoning.delta") {
          // Provider-native reasoning streams as visible prose between tool bursts.
          // It remains outside the assistant bubble and is never re-sent as context.
          const delta = String(event.data?.text ?? "");
          if (delta) {
            if (!reasoning) { activity.remove(); reasoning = this.#options.activity.appendReasoning(true); }
            this.#options.activity.appendReasoningDelta(reasoning, delta);
            this.#options.addTokenEstimate(delta);
            await this.#yieldToPaint();
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
          assistantText = "";
        }
        if (event.type === "tool.approval.requested") {
          const approvalId = String(event.data?.approvalId ?? "");
          activity.remove();
          if (assistant) { this.#options.activity.markAssistantAsCommentary(assistant); assistant = undefined; assistantText = ""; }
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
          if (assistant) { this.#options.activity.markAssistantAsCommentary(assistant); assistant = undefined; assistantText = ""; }
          if (reasoning) { this.#options.activity.completeReasoning(reasoning); reasoning = undefined; }
          this.#options.addTokenEstimate(stringifyForEstimate(input));
          if (toolName === "agent_plan") {
            planToolCalls.add(toolCallId);
            this.#options.setStatus("Updating tasks", "active");
            this.#options.setEngineState("WORKING");
          } else {
            tools.set(toolCallId, { row: this.#options.activity.appendTool(toolName, input, toolCallId, true), toolName, input });
            this.#options.setStatus(`Running ${toolName}`, "active");
            this.#options.setEngineState(toolName.toUpperCase());
          }
        }
        if (event.type === "tool.completed") {
          const toolCallId = String(event.data?.toolCallId ?? "");
          let existing = tools.get(toolCallId);
          const completedToolName = planToolCalls.has(toolCallId) ? "agent_plan" : existing?.toolName ?? String(event.data?.toolName ?? "tool");
          if (completedToolName === "agent_plan") {
            planToolCalls.delete(toolCallId);
            this.#options.updatePlan(event.data?.result);
            this.#options.addTokenEstimate(stringifyForEstimate(event.data?.result));
            this.#options.setStatus("Working", "active");
            this.#options.setEngineState("WORKING");
            continue;
          }
          if (!existing) {
            const restored = this.#options.messages.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
            if (restored) existing = { row: restored, toolName: restored.dataset.toolName ?? String(event.data?.toolName ?? "tool"), input: undefined };
          }
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
          if (success && !mediaHandedOff && this.#options.loadFinalAssistant) {
            try {
              const recovered = await this.#options.loadFinalAssistant(runId);
              if (recovered?.text) {
                if (!assistant) {
                  assistant = this.#options.appendAssistant(runId, recovered.createdAt);
                  this.#options.appendAssistantDelta(assistant, recovered.text);
                  this.#options.addTokenEstimate(recovered.text);
                } else if (assistantText !== recovered.text) {
                  this.#options.replaceAssistant(assistant, recovered.text);
                }
                assistantText = recovered.text;
              }
            } catch {
              // Keep the streamed answer (or the explicit empty-response notice)
              // if transcript reconciliation is temporarily offline.
            }
          }
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
          this.#options.clearPlan();
        }
      }
        if (!done && !queued && !assistant && !reasoning && (!eventStream || (replay.events?.length ?? 0) === 0) && Date.now() >= nextEnginePoll) {
        nextEnginePoll = Date.now() + 1_000;
        try {
          const management = await this.#options.api("/api/v1/management/status");
          const state = String(management.engine?.state ?? "");
          this.#options.setEngineState(state || "WORKING");
          if (state === "PREPARING" || state === "LOADING") {
            const label = state === "PREPARING" ? "Preparing model" : "Loading model";
            this.#options.setStatus(label, "loading");
            this.#options.activity.setRun(activity, label, startedAt);
          }
          else if (state === "READY" || state === "BUSY") this.#options.activity.setRun(activity, "Thinking", startedAt);
          else if (state === "FAILED") activity.textContent = `Model failed: ${management.engine?.failureReason ?? "Unknown error"}`;
          else this.#options.activity.setRun(activity, "Working", startedAt);
        } catch { this.#options.activity.setRun(activity, "Working", startedAt); }
        }
        if (!done && !eventStream) await this.#delay(350);
      }
    } finally {
      unsubscribeEventStream?.();
    }
    if (done) {
      await this.#options.onRunSettled?.();
      await this.#options.refreshAssistantPerformance?.(runId);
    }
  }

  #yieldToPaint(): Promise<void> {
    if (this.#options.yieldToPaint) return this.#options.yieldToPaint();
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  #delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
}

class AgentEventInbox {
  readonly #queue: AgentEventStreamMessage[] = [];
  #waiter: { resolve: (message: AgentEventStreamDelivery) => void; timer: ReturnType<typeof setTimeout> } | undefined;

  push(message: AgentEventStreamMessage): void {
    const waiter = this.#waiter;
    if (!waiter) { this.#queue.push(message); return; }
    this.#waiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  next(timeoutMs: number): Promise<AgentEventStreamDelivery> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#waiter?.resolve === resolve) this.#waiter = undefined;
        resolve({ type: "idle" });
      }, timeoutMs);
      this.#waiter = { resolve, timer };
    });
  }
}

/** Text form of a tool input/result for context estimation; structured payloads become JSON. */
function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
