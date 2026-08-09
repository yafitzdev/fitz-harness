import type { AgentEventEnvelope, AgentEventType, AgentQueueItem, AgentRunRecord, AgentRunRequest } from "@fitz/protocol";
import { AGENT_PROTOCOL_VERSION } from "@fitz/protocol";
import { OwnerFairQueue, type InferenceScheduler, type ScheduledStream } from "@fitz/inference-core";
import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun } from "@fitz/agent-core";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "@fitz/storage";

interface AgentQueueJob {
  id: string;
  request: AgentRunRequest;
  ownerUserId?: string;
  stream: AgentRuntimeRun | ScheduledStream | undefined;
  cancelRequested: boolean;
  shutdownRequested: boolean;
}

export class AgentQueueCapacityError extends Error {
  constructor() { super("The agent request queue is at capacity"); this.name = "AgentQueueCapacityError"; }
}

export class AgentCoordinatorClosedError extends Error {
  constructor() { super("The agent runtime is shutting down"); this.name = "AgentCoordinatorClosedError"; }
}

export class AgentRunCoordinator {
  readonly #queue = new OwnerFairQueue<AgentQueueJob>((job) => job.ownerUserId ?? "local");
  readonly #listeners = new Map<string, Set<(event: AgentEventEnvelope) => void>>();
  readonly #active = new Map<string, AgentQueueJob>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #completionTasks = new Set<Promise<void>>();
  #accepting = true;
  /** Fired once per run after it reaches a terminal state, so the safety layer can sweep retention. */
  constructor(private readonly store: SqliteStore, private readonly scheduler: InferenceScheduler, private readonly runtime?: AgentRuntime, private readonly onRunCompleted?: (runId: string) => void | Promise<void>, private readonly maxDepth = 256, private readonly maxConcurrent = 4, private readonly maxConcurrentPerOwner = 1) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new TypeError("Agent queue capacity must be a positive integer");
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError("Agent concurrency must be a positive integer");
    if (!Number.isInteger(maxConcurrentPerOwner) || maxConcurrentPerOwner < 1) throw new TypeError("Per-owner agent concurrency must be a positive integer");
  }

  start(request: AgentRunRequest, ownerUserId?: string, canonicalMessages = request.messages, durableRequest = request, resumeOfRunId?: string): AgentRunRecord {
    if (!this.#accepting) throw new AgentCoordinatorClosedError();
    if (this.#queue.length + this.#active.size >= this.maxDepth) throw new AgentQueueCapacityError();
    const id = randomUUID(); const now = new Date().toISOString();
    const run: AgentRunRecord = { id, routeId: request.model, status: "queued", createdAt: now, updatedAt: now, lastSequence: 0, ...(ownerUserId ? { ownerUserId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}) };
    // Claim the client request identity before adding canonical messages. A
    // concurrent retry then fails at the unique run-state boundary and cannot
    // duplicate the user's prompt in the transcript.
    this.store.createAgentRun(run, durableRequest, resumeOfRunId);
    try {
      if (request.sessionId) for (const message of canonicalMessages) this.store.appendTranscriptEntry({ id: randomUUID(), sessionId: request.sessionId, kind: "message", role: message.role, content: { text: message.content, ...(message.name ? { name: message.name } : {}) }, createdAt: now });
      this.#emit(id, "run.created", { routeId: request.model, ...(resumeOfRunId ? { resumeOfRunId } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { this.#emit(id, "run.failed", { error: message }); }
      catch { this.store.updateAgentRun(id, "failed", message); /* the original storage failure remains primary */ }
      throw error;
    }
    this.#queue.enqueue({ id, request, stream: undefined, cancelRequested: false, shutdownRequested: false, ...(ownerUserId ? { ownerUserId } : {}) }); this.#publishQueue(); this.#pump();
    return this.store.getAgentRun(id)!;
  }

  get(id: string): AgentRunRecord | undefined { return this.store.getAgentRun(id); }
  getSessionRecovery(sessionId: string): AgentRunRecord | undefined { return this.store.latestSessionAgentRun(sessionId); }
  list(ownerUserId?: string, limit = 100): AgentRunRecord[] { return this.store.listAgentRuns(ownerUserId, limit); }
  queue(ownerUserId?: string): AgentQueueItem[] {
    const active = [...this.#active.values()]; const queued = this.#queue.values(); const jobs = [...active, ...queued]; const depth = jobs.length;
    return jobs.map((job, index) => {
      const run = this.store.getAgentRun(job.id)!; const session = run.sessionId ? this.store.getSession(run.sessionId) : undefined; const project = session?.projectId ? this.store.getProject(session.projectId) : undefined;
      const status: AgentQueueItem["status"] = this.#active.has(job.id) ? "running" : "queued";
      return { runId: job.id, routeId: run.routeId, status, position: status === "running" ? 0 : index - active.length + 1, depth, createdAt: run.createdAt, ...(run.ownerUserId ? { ownerUserId: run.ownerUserId } : {}), ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(session ? { sessionTitle: session.title } : {}), ...(project ? { projectName: project.name } : {}) };
    }).filter((item) => !ownerUserId || item.ownerUserId === ownerUserId);
  }
  eventsAfter(id: string, after: number): AgentEventEnvelope[] { return this.store.agentEventsAfter(id, after); }
  subscribe(id: string, listener: (event: AgentEventEnvelope) => void): () => void { const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(listener); this.#listeners.set(id, listeners); return () => { listeners.delete(listener); if (listeners.size === 0) this.#listeners.delete(id); }; }
  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (active) {
      active.cancelRequested = true;
      active.stream?.cancel();
      return true;
    }
    const job = this.#queue.values().find((candidate) => candidate.id === id); if (!job || !this.#queue.remove(job)) return false;
    this.#emit(id, "run.cancelled", { queued: true }); this.#publishQueue(); this.#notifyCompletion(id); return true;
  }
  /** Queue a steering message into the currently running stream. The run must be actively streaming and its runtime must support steering. */
  async steer(runId: string, text: string): Promise<boolean> {
    const job = this.#active.get(runId);
    if (!job) return false;
    const stream = job.stream;
    if (!stream || typeof (stream as AgentRuntimeRun).steer !== "function") return false;
    await (stream as AgentRuntimeRun).steer!(text);
    return true;
  }

  /** Stop admission, mark queued work resumable, cancel active state machines,
   * and wait until no run can write to storage anymore. */
  async shutdown(): Promise<void> {
    if (!this.#accepting) {
      await Promise.allSettled([...this.#tasks]);
      await Promise.allSettled([...this.#completionTasks]);
      return;
    }
    this.#accepting = false;
    for (let job = this.#queue.dequeue(); job; job = this.#queue.dequeue()) {
      job.shutdownRequested = true;
      this.#emit(job.id, "run.interrupted", { error: "host_shutdown", resumable: true, queued: true });
      this.#notifyCompletion(job.id);
    }
    for (const job of this.#active.values()) {
      job.shutdownRequested = true;
      job.stream?.cancel();
    }
    this.#publishQueue();
    await Promise.allSettled([...this.#tasks]);
    await Promise.allSettled([...this.#completionTasks]);
  }

  #pump(): void {
    while (this.#accepting && this.#active.size < this.maxConcurrent) {
      const job = this.#queue.dequeueWhere((candidate) => this.#activeForOwner(candidate.ownerUserId) < this.maxConcurrentPerOwner);
      if (!job) break;
      this.#active.set(job.id, job);
      this.#publishQueue();
      const task = this.#runJob(job);
      this.#tasks.add(task);
      const settled = () => {
        this.#tasks.delete(task);
        this.#active.delete(job.id);
        job.stream = undefined;
        this.#publishQueue();
        this.#pump();
      };
      void task.then(settled, settled);
    }
  }

  async #runJob(job: AgentQueueJob): Promise<void> {
    try {
      job.stream = this.#createStream(job.request, job.ownerUserId, job.id);
      if (job.cancelRequested || job.shutdownRequested) job.stream.cancel();
      await this.#consume(job, job.stream);
      this.#notifyCompletion(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#emit(job.id, job.shutdownRequested ? "run.interrupted" : "run.failed", { error: job.shutdownRequested ? "host_shutdown" : message, ...(job.shutdownRequested ? { resumable: true } : {}) });
      this.#notifyCompletion(job.id);
    }
  }

  #createStream(request: AgentRunRequest, ownerUserId: string | undefined, runId: string): AgentRuntimeRun | ScheduledStream {
    // The runId is threaded into the runtime so the safety layer can scope its trash,
    // snapshots and action log to this exact run.
    return this.runtime
      ? this.runtime.run(request, undefined, { runId, ...(ownerUserId ? { ownerUserId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}) })
      : this.scheduler.enqueue(request.model, { messages: request.messages, ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(ownerUserId ? { userId: ownerUserId } : {}) }, undefined, { ...(ownerUserId ? { ownerUserId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}), runId, label: "Agent response" });
  }
  async #consume(job: AgentQueueJob, stream: AgentRuntimeRun | ScheduledStream): Promise<void> {
    const id = job.id;
    this.#emit(id, "run.started", {});
    let assistantText = ""; let reasoningText = "";
    let assistantFrom = 0; let assistantThrough = 0; let reasoningFrom = 0; let reasoningThrough = 0;
    const flushAssistant = (phase: "commentary" | "final") => { if (assistantText) this.#appendAssistantTranscript(id, assistantText, phase, assistantFrom, assistantThrough); assistantText = ""; assistantFrom = 0; assistantThrough = 0; };
    const flushReasoning = () => { if (reasoningText) this.#appendReasoningTranscript(id, reasoningText, reasoningFrom, reasoningThrough); reasoningText = ""; reasoningFrom = 0; reasoningThrough = 0; };
    try {
      for await (const delta of stream) {
        const normalized = normalizeRuntimeEvent(delta);
        const event = this.#emit(id, normalized.type, normalized.data);
        if (event.type === "assistant.delta") { if (!assistantFrom) assistantFrom = event.sequence; assistantThrough = event.sequence; assistantText += String(event.data.text ?? ""); }
        if (event.type === "reasoning.delta") { if (!reasoningFrom) reasoningFrom = event.sequence; reasoningThrough = event.sequence; reasoningText += String(event.data.text ?? ""); }
        if (event.type === "tool.started" || event.type === "tool.approval.requested" || event.type === "user.steer") { flushAssistant("commentary"); flushReasoning(); }
        if (event.type === "reasoning.completed") flushReasoning();
        if (event.type === "user.steer") { const text = String(event.data.text ?? ""); const sessionId = this.store.getAgentRun(id)?.sessionId; if (sessionId && text) this.store.appendTranscriptEntry({ id: `agent-event:${id}:user-steer:${event.sequence}`, sessionId, kind: "message", role: "user", content: { text, runId: id, eventSequence: event.sequence }, createdAt: event.timestamp }); }
        this.#appendToolTranscript(id, event);
      }
      flushAssistant("final"); flushReasoning();
      if (job.shutdownRequested) this.#emit(id, "run.interrupted", { error: "host_shutdown", resumable: true });
      else if (job.cancelRequested) this.#emit(id, "run.cancelled", {});
      else this.#emit(id, "run.completed", {});
    } catch (error) {
      flushAssistant("final"); flushReasoning(); const cancelled = error instanceof Error && error.name === "AbortError"; const message = error instanceof Error ? error.message : String(error);
      if (job.shutdownRequested) this.#emit(id, "run.interrupted", { error: "host_shutdown", resumable: true });
      else this.#emit(id, cancelled || job.cancelRequested ? "run.cancelled" : "run.failed", { error: message });
    }
  }
  #activeForOwner(ownerUserId: string | undefined): number { const owner = ownerUserId ?? "local"; return [...this.#active.values()].filter((job) => (job.ownerUserId ?? "local") === owner).length; }
  #notifyCompletion(runId: string): void {
    if (!this.onRunCompleted) return;
    let task: Promise<void>;
    try { task = Promise.resolve(this.onRunCompleted(runId)); }
    catch { return; /* retention cleanup must never corrupt run state */ }
    const guarded = task.catch(() => undefined);
    this.#completionTasks.add(guarded);
    void guarded.then(() => this.#completionTasks.delete(guarded));
  }
  #publishQueue(): void { const depth = this.#queue.length + this.#active.size; for (const job of this.#active.values()) this.#emit(job.id, "run.queue.updated", { status: "running", position: 0, depth }); this.#queue.values().forEach((job, index) => this.#emit(job.id, "run.queue.updated", { status: "queued", position: index + 1, depth })); }
  #emit(runId: string, type: AgentEventType, data: Record<string, unknown>): AgentEventEnvelope { const run = this.store.getAgentRun(runId); if (!run) throw new Error(`Agent run ${runId} disappeared`); const event: AgentEventEnvelope = { protocolVersion: AGENT_PROTOCOL_VERSION, runId, sequence: run.lastSequence + 1, timestamp: new Date().toISOString(), type, data }; this.store.appendAgentEvent(event); for (const listener of this.#listeners.get(runId) ?? []) listener(event); return event; }
  #appendAssistantTranscript(runId: string, text: string, phase: "commentary" | "final", fromSequence: number, eventSequence: number): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (sessionId && text) this.store.appendTranscriptEntry({ id: `agent-event:${runId}:message:${fromSequence}-${eventSequence}`, sessionId, kind: "message", role: "assistant", content: { text, runId, phase, eventSequence }, createdAt: new Date().toISOString() }); }
  /** Reasoning is stored under its own transcript kind so it never round-trips into model context or renders as a chat message. */
  #appendReasoningTranscript(runId: string, text: string, fromSequence: number, eventSequence: number): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (sessionId && text) this.store.appendTranscriptEntry({ id: `agent-event:${runId}:reasoning:${fromSequence}-${eventSequence}`, sessionId, kind: "reasoning", role: "assistant", content: { text, runId, eventSequence }, createdAt: new Date().toISOString() }); }
  #appendToolTranscript(runId: string, event: AgentEventEnvelope): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (!sessionId || (event.type !== "tool.started" && event.type !== "tool.completed")) return; this.store.appendTranscriptEntry({ id: `agent-event:${runId}:${event.type}:${event.sequence}`, sessionId, kind: event.type === "tool.started" ? "tool-call" : "tool-result", role: "tool", content: { ...event.data, runId, eventSequence: event.sequence }, createdAt: event.timestamp }); }
}

function normalizeRuntimeEvent(event: AgentRuntimeEvent | { text: string; finishReason?: string; promptTokens?: number; completionTokens?: number }): { type: AgentEventType; data: Record<string, unknown> } {
  if ("type" in event) { if (event.type === "assistant.delta") return { type: event.type, data: { text: event.text } }; if (event.type === "reasoning.delta") return { type: event.type, data: { text: event.text } }; if (event.type === "reasoning.completed") return { type: event.type, data: {} }; if (event.type === "user.steer") return { type: event.type, data: { text: event.text } }; return { type: event.type, data: { toolCallId: event.toolCallId, toolName: event.toolName, ...((event.type === "tool.started" || event.type === "tool.approval.requested") && event.input !== undefined ? { input: event.input } : {}), ...((event.type === "tool.approval.requested" || event.type === "tool.approval.resolved") ? { approvalId: event.approvalId } : {}), ...(event.type === "tool.approval.resolved" ? { decision: event.decision } : {}), ...(event.type === "tool.completed" ? { result: event.result, ...(event.isError !== undefined ? { isError: event.isError } : {}) } : {}) } }; }
  return { type: "assistant.delta", data: { text: event.text, ...(event.finishReason ? { finishReason: event.finishReason } : {}), ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}), ...(event.completionTokens !== undefined ? { completionTokens: event.completionTokens } : {}) } };
}
