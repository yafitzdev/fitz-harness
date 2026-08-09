import type { AgentEventEnvelope, AgentEventType, AgentQueueItem, AgentRunRecord, AgentRunRequest } from "@fitz/protocol";
import { AGENT_PROTOCOL_VERSION } from "@fitz/protocol";
import type { InferenceScheduler, ScheduledStream } from "@fitz/inference-core";
import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun } from "@fitz/agent-core";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "@fitz/storage";

interface AgentQueueJob { id: string; request: AgentRunRequest; ownerUserId?: string; stream: AgentRuntimeRun | ScheduledStream | undefined }

export class AgentRunCoordinator {
  readonly #queue: AgentQueueJob[] = [];
  readonly #listeners = new Map<string, Set<(event: AgentEventEnvelope) => void>>();
  #current: AgentQueueJob | undefined;
  #processing = false;
  /** Fired once per run after it reaches a terminal state, so the safety layer can sweep retention. */
  constructor(private readonly store: SqliteStore, private readonly scheduler: InferenceScheduler, private readonly runtime?: AgentRuntime, private readonly onRunCompleted?: (runId: string) => void) {}

  start(request: AgentRunRequest, ownerUserId?: string, canonicalMessages = request.messages, durableRequest = request, resumeOfRunId?: string): AgentRunRecord {
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
    this.#queue.push({ id, request, stream: undefined, ...(ownerUserId ? { ownerUserId } : {}) }); this.#publishQueue(); void this.#pump();
    return this.store.getAgentRun(id)!;
  }

  get(id: string): AgentRunRecord | undefined { return this.store.getAgentRun(id); }
  getSessionRecovery(sessionId: string): AgentRunRecord | undefined { return this.store.latestSessionAgentRun(sessionId); }
  list(ownerUserId?: string, limit = 100): AgentRunRecord[] { return this.store.listAgentRuns(ownerUserId, limit); }
  queue(ownerUserId?: string): AgentQueueItem[] {
    const jobs = [...(this.#current ? [this.#current] : []), ...this.#queue]; const depth = jobs.length;
    return jobs.map((job, index) => {
      const run = this.store.getAgentRun(job.id)!; const session = run.sessionId ? this.store.getSession(run.sessionId) : undefined; const project = session?.projectId ? this.store.getProject(session.projectId) : undefined;
      const status: AgentQueueItem["status"] = job === this.#current ? "running" : "queued";
      return { runId: job.id, routeId: run.routeId, status, position: job === this.#current ? 0 : index, depth, createdAt: run.createdAt, ...(run.ownerUserId ? { ownerUserId: run.ownerUserId } : {}), ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(session ? { sessionTitle: session.title } : {}), ...(project ? { projectName: project.name } : {}) };
    }).filter((item) => !ownerUserId || item.ownerUserId === ownerUserId);
  }
  eventsAfter(id: string, after: number): AgentEventEnvelope[] { return this.store.agentEventsAfter(id, after); }
  subscribe(id: string, listener: (event: AgentEventEnvelope) => void): () => void { const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(listener); this.#listeners.set(id, listeners); return () => { listeners.delete(listener); if (listeners.size === 0) this.#listeners.delete(id); }; }
  cancel(id: string): boolean {
    if (this.#current?.id === id && this.#current.stream) { this.#current.stream.cancel(); return true; }
    const index = this.#queue.findIndex((job) => job.id === id); if (index < 0) return false;
    this.#queue.splice(index, 1); this.#emit(id, "run.cancelled", { queued: true }); this.#publishQueue(); this.onRunCompleted?.(id); return true;
  }
  /** Queue a steering message into the currently running stream. The run must be actively streaming and its runtime must support steering. */
  async steer(runId: string, text: string): Promise<boolean> {
    const job = this.#current;
    if (!job || job.id !== runId) return false;
    const stream = job.stream;
    if (!stream || typeof (stream as AgentRuntimeRun).steer !== "function") return false;
    await (stream as AgentRuntimeRun).steer!(text);
    return true;
  }

  async #pump(): Promise<void> {
    if (this.#processing) return; this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift(); if (!job) continue; this.#current = job; this.#publishQueue();
        try { job.stream = this.#createStream(job.request, job.ownerUserId, job.id); await this.#consume(job.id, job.stream); this.onRunCompleted?.(job.id); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); this.#emit(job.id, "run.failed", { error: message }); this.onRunCompleted?.(job.id); }
        finally { job.stream = undefined; this.#current = undefined; this.#publishQueue(); }
      }
    } finally { this.#processing = false; if (this.#queue.length > 0) void this.#pump(); }
  }

  #createStream(request: AgentRunRequest, ownerUserId: string | undefined, runId: string): AgentRuntimeRun | ScheduledStream {
    // The runId is threaded into the runtime so the safety layer can scope its trash,
    // snapshots and action log to this exact run.
    return this.runtime ? this.runtime.run(request, undefined, { runId }) : this.scheduler.enqueue(request.model, { messages: request.messages, ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(ownerUserId ? { userId: ownerUserId } : {}) });
  }
  async #consume(id: string, stream: AgentRuntimeRun | ScheduledStream): Promise<void> {
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
      flushAssistant("final"); flushReasoning(); this.#emit(id, "run.completed", {});
    } catch (error) {
      flushAssistant("final"); flushReasoning(); const cancelled = error instanceof Error && error.name === "AbortError"; const message = error instanceof Error ? error.message : String(error); this.#emit(id, cancelled ? "run.cancelled" : "run.failed", { error: message });
    }
  }
  #publishQueue(): void { const depth = this.#queue.length + (this.#current ? 1 : 0); if (this.#current) this.#emit(this.#current.id, "run.queue.updated", { status: "running", position: 0, depth }); this.#queue.forEach((job, index) => this.#emit(job.id, "run.queue.updated", { status: "queued", position: index + 1, depth })); }
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
