import { reconnectDelay } from "@fitz/connectivity/reconnect";
import type { ActionFeedback } from "../primitives/action-status.js";
import type { AgentEffort } from "@fitz/protocol";
import { AgentEventProjector, type AgentRunActivity, type Json } from "./agent-event-projector.js";

export type { AgentRunActivity } from "./agent-event-projector.js";

export interface AgentRunRequest {
  model: string;
  effort: AgentEffort;
  max_tokens: number;
  temperature: number;
  sessionId: string;
  accessMode: string;
  clientRequestId?: string;
  persistedMessageId?: string;
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
  registerGeneratedFile?: (path: string, action: "edited" | "created") => void;
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
  #sessionId: string | undefined;
  #starting = false;
  #cancelPending = false;
  #lastSequence = 0;
  #warmupTimer: ReturnType<typeof setTimeout> | undefined;
  #composerHadText = false;
  #generation = 0;

  constructor(options: AgentRunControllerOptions) { this.#options = options; }

  get active(): boolean { return this.#starting || Boolean(this.#runId); }
  get runId(): string | undefined { return this.#runId; }
  /** The chat owned by the locally-followed run, independent of selection. */
  get activeSessionId(): string | undefined { return this.#sessionId; }

  /** Stop following locally without cancelling the host run. Used when the
   * user switches chats; selecting the chat again reattaches from SQLite. */
  detach(): void {
    this.#generation += 1;
    this.#runId = undefined;
    this.#sessionId = undefined;
    this.#starting = false;
    this.#cancelPending = false;
    this.#options.refreshControls();
  }

  async attach(run: { id: string; createdAt?: string; sessionId?: string }, afterSequence = 0): Promise<void> {
    if (this.active) return;
    const generation = ++this.#generation;
    const activity = this.#options.activity.appendRun("Reconnecting");
    const startedAt = Date.parse(run.createdAt ?? "") || Date.now();
    this.#runId = run.id;
    this.#sessionId = typeof run.sessionId === "string" ? run.sessionId : undefined;
    this.#lastSequence = Math.max(0, afterSequence);
    this.#cancelPending = false;
    this.#options.setStatus("Reconnecting", "loading");
    this.#options.refreshControls();
    try { await this.#follow(run.id, activity, startedAt, generation); }
    catch (error) {
      if (this.#generation !== generation) return;
      activity.remove(); this.#options.appendSystem(this.#options.errorMessage(error)); this.#options.setStatus("Disconnected", "error");
    }
    finally { if (this.#generation === generation) { this.#runId = undefined; this.#sessionId = undefined; this.#cancelPending = false; this.#options.refreshControls(); } }
  }

  async resume(sourceRunId: string, confirmUnsafe = false, onAccepted?: () => void): Promise<void> {
    if (this.active) return;
    const generation = ++this.#generation;
    const activity = this.#options.activity.appendRun("Resuming");
    this.#starting = true;
    this.#sessionId = undefined;
    this.#lastSequence = 0;
    this.#options.setStatus("Resuming", "loading");
    this.#options.refreshControls();
    try {
      const response = await this.#options.api(`/api/v1/agent/runs/${sourceRunId}/resume`, "POST", { confirmUnsafe });
      if (this.#generation !== generation) return;
      const runId = String(response.data.id);
      this.#runId = runId; this.#sessionId = typeof response.data?.sessionId === "string" ? response.data.sessionId : undefined; this.#starting = false;
      onAccepted?.();
      await this.#follow(runId, activity, Date.now(), generation);
    } catch (error) {
      if (this.#generation !== generation) return;
      activity.remove();
      this.#options.appendSystem(this.#options.errorMessage(error));
      this.#options.setStatus("Resume failed", "error");
      throw error;
    }
    finally { if (this.#generation === generation) { this.#runId = undefined; this.#sessionId = undefined; this.#starting = false; this.#cancelPending = false; this.#options.refreshControls(); } }
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

  async start(request: AgentRunRequest, onAccepted?: () => void): Promise<void> {
    if (this.active) return;
    const generation = ++this.#generation;
    this.resetWarmup();
    let activity: HTMLElement | undefined;
    const startedAt = Date.now();
    this.#starting = true;
    this.#sessionId = request.sessionId;
    this.#cancelPending = false;
    this.#lastSequence = 0;
    this.#options.setStatus("Queued", "loading");
    this.#options.setEngineState("QUEUED");
    this.#options.refreshControls();
    try {
      const durableRequest = { ...request, clientRequestId: request.clientRequestId ?? crypto.randomUUID() };
      let response: Json | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (this.#generation !== generation) return;
        try { response = await this.#options.api("/api/v1/agent/runs", "POST", durableRequest); break; }
        catch (error) {
          if (this.#generation !== generation) return;
          if (this.#options.terminalReplayError(error) || attempt === 3) throw error;
          this.#options.setStatus(`Submitting · retry ${attempt + 1}`, "loading");
          await this.#delay(reconnectDelay(attempt));
        }
      }
      if (!response) throw new Error("The run could not be created");
      const acceptedRunId = typeof response.data?.id === "string" ? response.data.id.trim() : "";
      if (!acceptedRunId) throw new Error("The host accepted the request without returning a run id");
      // A successful creation response is the durable admission boundary. Let
      // the composer commit its optimistic UI state even if the user detached
      // while the response was in flight; the callback owns its session guard.
      try { onAccepted?.(); }
      catch (error) { this.#options.showStatus(this.#options.errorMessage(error), "error"); }
      if (this.#generation !== generation) return;
      // Admission commits the user turn before its work group is rendered, so
      // reasoning always follows the prompt it belongs to in the transcript.
      activity = this.#options.activity.appendRun("Working");
      this.#runId = acceptedRunId;
      this.#sessionId = request.sessionId;
      this.#starting = false;
      const preparedEstimate = Number(response.context?.estimatedContextTokens);
      // Every run is prepared from the host's canonical transcript. Re-anchor the local
      // meter on that authoritative request so deleted or regenerated turns cannot leak
      // into the next run through accumulated renderer-only estimates.
      if (Number.isFinite(preparedEstimate) && preparedEstimate >= 0) this.#options.recalibrateEstimate(preparedEstimate);
      if (response.context?.compacted) this.#options.activity.appendContext();
      if (this.#cancelPending) await this.#options.api(`/api/v1/agent/runs/${acceptedRunId}`, "DELETE");
      await this.#follow(acceptedRunId, activity, startedAt, generation);
    } catch (error) {
      if (this.#generation !== generation) return;
      activity?.remove();
      this.#options.appendSystem(this.#options.errorMessage(error));
      this.#options.setStatus("Failed", "error");
      if (activity) this.#options.activity.finishWork();
    } finally {
      if (this.#generation === generation) {
        this.#runId = undefined;
        this.#sessionId = undefined;
        this.#starting = false;
        this.#cancelPending = false;
        this.#options.refreshControls();
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    const generation = this.#generation;
    this.#cancelPending = true;
    this.#options.setStatus("Stopping", "loading");
    this.#options.refreshControls();
    const runId = this.#runId;
    if (!runId) return;
    try {
      await this.#options.api(`/api/v1/agent/runs/${runId}`, "DELETE");
    } catch (error) {
      if (this.#generation !== generation || this.#runId !== runId) return;
      this.#cancelPending = false;
      this.#options.showStatus(this.#options.errorMessage(error), "error");
      this.#options.refreshControls();
    }
  }

  /** Insert a message into the running conversation. The host forwards it to the active stream. */
  async steer(text: string): Promise<void> {
    const runId = this.#runId;
    const generation = this.#generation;
    if (!runId) throw new Error("No active run to steer");
    try { await this.#options.api(`/api/v1/agent/runs/${runId}/steer`, "POST", { text }); }
    catch (error) {
      if (this.#generation !== generation || this.#runId !== runId) return;
      throw error;
    }
  }

  async #follow(runId: string, activity: HTMLElement, startedAt: number, generation: number): Promise<void> {
    let reconnectAttempt = 0;
    let nextEnginePoll = 0;
    let eventStream: AgentEventInbox | undefined;
    let unsubscribeEventStream: (() => void) | undefined;
    const projector = new AgentEventProjector({
      runId,
      startedAt,
      activityRoot: activity,
      messages: this.#options.messages,
      activity: this.#options.activity,
      appendAssistant: this.#options.appendAssistant,
      appendAssistantDelta: this.#options.appendAssistantDelta,
      replaceAssistant: this.#options.replaceAssistant,
      ...(this.#options.loadFinalAssistant ? { loadFinalAssistant: this.#options.loadFinalAssistant } : {}),
      appendSystem: this.#options.appendSystem,
      appendChangeSummary: this.#options.appendChangeSummary,
      ...(this.#options.registerGeneratedFile ? { registerGeneratedFile: this.#options.registerGeneratedFile } : {}),
      addTokenEstimate: this.#options.addTokenEstimate,
      setStatus: this.#options.setStatus,
      setEngineState: this.#options.setEngineState,
      updatePlan: this.#options.updatePlan,
      clearPlan: this.#options.clearPlan,
      findApproval: (approvalId) => this.#options.messages.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(approvalId)}"]`) ?? undefined,
      findTool: (toolCallId) => {
        const row = this.#options.messages.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
        return row ? { row, toolName: row.dataset.toolName ?? "tool", input: undefined } : undefined;
      },
      ...(this.#options.onMediaJobSubmitted ? { onMediaJobSubmitted: this.#options.onMediaJobSubmitted } : {}),
      yieldToPaint: () => this.#yieldToPaint(),
      isCurrent: () => this.#runId === runId && this.#generation === generation,
    });
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
      while (!projector.done && this.#runId === runId && this.#generation === generation) {
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
            if (this.#runId !== runId || this.#generation !== generation) break;
            connectEventStream();
            continue;
          }
        } else {
          try {
            replay = await this.#options.api(`/api/v1/agent/runs/${runId}/events?after=${this.#lastSequence}`);
            reconnectAttempt = 0;
          } catch (error) {
            if (this.#runId !== runId || this.#generation !== generation) break;
            if (this.#options.terminalReplayError(error) || reconnectAttempt >= 12) throw error;
            this.#options.setStatus(`Reconnecting ${reconnectAttempt + 1}`, "loading");
            await this.#delay(reconnectDelay(reconnectAttempt++));
            continue;
          }
        }
        if (this.#runId !== runId || this.#generation !== generation) break;
        for (const event of replay.events ?? []) {
          if (this.#runId !== runId || this.#generation !== generation) break;
          this.#lastSequence = Number(event.sequence ?? this.#lastSequence);
          await projector.apply(event);
          if (this.#runId !== runId || this.#generation !== generation) break;
          if (event.type === "run.queue.updated" && this.#options.queueVisible()) void this.#options.refreshQueue();
        }
        if (!projector.done && !projector.queued && !projector.hasOpenOutput && (!eventStream || (replay.events?.length ?? 0) === 0) && Date.now() >= nextEnginePoll) {
          nextEnginePoll = Date.now() + 1_000;
          try {
            const management = await this.#options.api("/api/v1/management/status");
            if (this.#runId !== runId || this.#generation !== generation) break;
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
          } catch {
            if (this.#runId !== runId || this.#generation !== generation) break;
            this.#options.activity.setRun(activity, "Working", startedAt);
          }
        }
        if (!projector.done && !eventStream) await this.#delay(350);
      }
    } finally {
      unsubscribeEventStream?.();
    }
    if (projector.done && this.#runId === runId && this.#generation === generation) {
      await this.#options.onRunSettled?.();
      if (this.#runId !== runId || this.#generation !== generation) return;
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
