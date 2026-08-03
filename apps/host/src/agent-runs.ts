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
  constructor(private readonly store: SqliteStore, private readonly scheduler: InferenceScheduler, private readonly runtime?: AgentRuntime) {}

  start(request: AgentRunRequest, ownerUserId?: string, canonicalMessages = request.messages): AgentRunRecord {
    const id = randomUUID(); const now = new Date().toISOString();
    const run: AgentRunRecord = { id, routeId: request.model, status: "queued", createdAt: now, updatedAt: now, lastSequence: 0, ...(ownerUserId ? { ownerUserId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}) };
    if (request.sessionId) for (const message of canonicalMessages) this.store.appendTranscriptEntry({ id: randomUUID(), sessionId: request.sessionId, kind: "message", role: message.role, content: { text: message.content, ...(message.name ? { name: message.name } : {}) }, createdAt: now });
    this.store.createAgentRun(run); this.#emit(id, "run.created", { routeId: request.model });
    this.#queue.push({ id, request, stream: undefined, ...(ownerUserId ? { ownerUserId } : {}) }); this.#publishQueue(); void this.#pump();
    return this.store.getAgentRun(id)!;
  }

  get(id: string): AgentRunRecord | undefined { return this.store.getAgentRun(id); }
  list(ownerUserId?: string, limit = 100): AgentRunRecord[] { return this.store.listAgentRuns(ownerUserId, limit); }
  queue(ownerUserId?: string): AgentQueueItem[] {
    const jobs = [...(this.#current ? [this.#current] : []), ...this.#queue]; const depth = jobs.length;
    return jobs.map((job, index) => {
      const run = this.store.getAgentRun(job.id)!; const session = run.sessionId ? this.store.getSession(run.sessionId) : undefined; const project = session ? this.store.getProject(session.projectId) : undefined;
      const status: AgentQueueItem["status"] = job === this.#current ? "running" : "queued";
      return { runId: job.id, routeId: run.routeId, status, position: job === this.#current ? 0 : index, depth, createdAt: run.createdAt, ...(run.ownerUserId ? { ownerUserId: run.ownerUserId } : {}), ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(session ? { sessionTitle: session.title } : {}), ...(project ? { projectName: project.name } : {}) };
    }).filter((item) => !ownerUserId || item.ownerUserId === ownerUserId);
  }
  eventsAfter(id: string, after: number): AgentEventEnvelope[] { return this.store.agentEventsAfter(id, after); }
  subscribe(id: string, listener: (event: AgentEventEnvelope) => void): () => void { const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(listener); this.#listeners.set(id, listeners); return () => { listeners.delete(listener); if (listeners.size === 0) this.#listeners.delete(id); }; }
  cancel(id: string): boolean {
    if (this.#current?.id === id && this.#current.stream) { this.#current.stream.cancel(); return true; }
    const index = this.#queue.findIndex((job) => job.id === id); if (index < 0) return false;
    this.#queue.splice(index, 1); this.store.updateAgentRun(id, "cancelled"); this.#emit(id, "run.cancelled", { queued: true }); this.#publishQueue(); return true;
  }

  async #pump(): Promise<void> {
    if (this.#processing) return; this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift(); if (!job) continue; this.#current = job; this.#publishQueue();
        try { job.stream = this.#createStream(job.request, job.ownerUserId); await this.#consume(job.id, job.stream); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); this.store.updateAgentRun(job.id, "failed", message); this.#emit(job.id, "run.failed", { error: message }); }
        finally { job.stream = undefined; this.#current = undefined; this.#publishQueue(); }
      }
    } finally { this.#processing = false; if (this.#queue.length > 0) void this.#pump(); }
  }

  #createStream(request: AgentRunRequest, ownerUserId?: string): AgentRuntimeRun | ScheduledStream {
    return this.runtime ? this.runtime.run(request) : this.scheduler.enqueue(request.model, { messages: request.messages, ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(ownerUserId ? { userId: ownerUserId } : {}) });
  }
  async #consume(id: string, stream: AgentRuntimeRun | ScheduledStream): Promise<void> {
    this.store.updateAgentRun(id, "running"); this.#emit(id, "run.started", {}); let assistantText = "";
    try { for await (const delta of stream) { const event = normalizeRuntimeEvent(delta); if (event.type === "assistant.delta") assistantText += String(event.data.text ?? ""); if ((event.type === "tool.started" || event.type === "tool.approval.requested") && assistantText) { this.#appendAssistantTranscript(id, assistantText, "commentary"); assistantText = ""; } this.#emit(id, event.type, event.data); this.#appendToolTranscript(id, event.type, event.data); } this.#appendAssistantTranscript(id, assistantText, "final"); this.store.updateAgentRun(id, "completed"); this.#emit(id, "run.completed", {}); }
    catch (error) { this.#appendAssistantTranscript(id, assistantText, "final"); const cancelled = error instanceof Error && error.name === "AbortError"; const status = cancelled ? "cancelled" : "failed"; const message = error instanceof Error ? error.message : String(error); this.store.updateAgentRun(id, status, message); this.#emit(id, cancelled ? "run.cancelled" : "run.failed", { error: message }); }
  }
  #publishQueue(): void { const depth = this.#queue.length + (this.#current ? 1 : 0); if (this.#current) this.#emit(this.#current.id, "run.queue.updated", { status: "running", position: 0, depth }); this.#queue.forEach((job, index) => this.#emit(job.id, "run.queue.updated", { status: "queued", position: index + 1, depth })); }
  #emit(runId: string, type: AgentEventType, data: Record<string, unknown>): void { const run = this.store.getAgentRun(runId); if (!run) return; const event: AgentEventEnvelope = { protocolVersion: AGENT_PROTOCOL_VERSION, runId, sequence: run.lastSequence + 1, timestamp: new Date().toISOString(), type, data }; this.store.appendAgentEvent(event); for (const listener of this.#listeners.get(runId) ?? []) listener(event); }
  #appendAssistantTranscript(runId: string, text: string, phase: "commentary" | "final"): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (sessionId && text) this.store.appendTranscriptEntry({ id: randomUUID(), sessionId, kind: "message", role: "assistant", content: { text, runId, phase }, createdAt: new Date().toISOString() }); }
  #appendToolTranscript(runId: string, type: AgentEventType, data: Record<string, unknown>): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (!sessionId || (type !== "tool.started" && type !== "tool.completed")) return; this.store.appendTranscriptEntry({ id: randomUUID(), sessionId, kind: type === "tool.started" ? "tool-call" : "tool-result", role: "tool", content: { ...data, runId }, createdAt: new Date().toISOString() }); }
}

function normalizeRuntimeEvent(event: AgentRuntimeEvent | { text: string; finishReason?: string; promptTokens?: number; completionTokens?: number }): { type: AgentEventType; data: Record<string, unknown> } {
  if ("type" in event) { if (event.type === "assistant.delta") return { type: event.type, data: { text: event.text } }; return { type: event.type, data: { toolCallId: event.toolCallId, toolName: event.toolName, ...((event.type === "tool.started" || event.type === "tool.approval.requested" || event.type === "tool.completed") && event.input !== undefined ? { input: event.input } : {}), ...((event.type === "tool.approval.requested" || event.type === "tool.approval.resolved") ? { approvalId: event.approvalId } : {}), ...(event.type === "tool.approval.resolved" ? { decision: event.decision } : {}), ...(event.type === "tool.completed" ? { result: event.result, ...(event.isError !== undefined ? { isError: event.isError } : {}) } : {}) } }; }
  return { type: "assistant.delta", data: { text: event.text, ...(event.finishReason ? { finishReason: event.finishReason } : {}), ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}), ...(event.completionTokens !== undefined ? { completionTokens: event.completionTokens } : {}) } };
}
