import type { AgentEventEnvelope, AgentEventType, AgentRunRecord, AgentRunRequest } from "@fitz/protocol";
import { AGENT_PROTOCOL_VERSION } from "@fitz/protocol";
import type { InferenceScheduler, ScheduledStream } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";

export class AgentRunCoordinator {
  readonly #active = new Map<string, ScheduledStream>();
  readonly #listeners = new Map<string, Set<(event: AgentEventEnvelope) => void>>();
  constructor(private readonly store: SqliteStore, private readonly scheduler: InferenceScheduler) {}
  start(request: AgentRunRequest, ownerUserId?: string): AgentRunRecord {
    const stream = this.scheduler.enqueue(request.model, { messages: request.messages, ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(ownerUserId ? { userId: ownerUserId } : {}) });
    const now = new Date().toISOString(); const run: AgentRunRecord = { id: stream.requestId, routeId: request.model, status: "queued", createdAt: now, updatedAt: now, lastSequence: 0, ...(ownerUserId ? { ownerUserId } : {}) };
    this.store.createAgentRun(run); this.#active.set(run.id, stream); this.#emit(run.id, "run.created", { routeId: request.model }); void this.#consume(run.id, stream); return this.store.getAgentRun(run.id)!;
  }
  get(id: string): AgentRunRecord | undefined { return this.store.getAgentRun(id); }
  list(ownerUserId?: string, limit = 100): AgentRunRecord[] { return this.store.listAgentRuns(ownerUserId, limit); }
  eventsAfter(id: string, after: number): AgentEventEnvelope[] { return this.store.agentEventsAfter(id, after); }
  subscribe(id: string, listener: (event: AgentEventEnvelope) => void): () => void { const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(listener); this.#listeners.set(id, listeners); return () => { listeners.delete(listener); if (listeners.size === 0) this.#listeners.delete(id); }; }
  cancel(id: string): boolean { const stream = this.#active.get(id); if (!stream) return false; stream.cancel(); return true; }
  async #consume(id: string, stream: ScheduledStream): Promise<void> {
    this.store.updateAgentRun(id, "running"); this.#emit(id, "run.started", {});
    try { for await (const delta of stream) this.#emit(id, "assistant.delta", { text: delta.text, ...(delta.finishReason ? { finishReason: delta.finishReason } : {}), ...(delta.promptTokens !== undefined ? { promptTokens: delta.promptTokens } : {}), ...(delta.completionTokens !== undefined ? { completionTokens: delta.completionTokens } : {}) }); this.store.updateAgentRun(id, "completed"); this.#emit(id, "run.completed", {}); }
    catch (error) { const cancelled = error instanceof Error && error.name === "AbortError"; const status = cancelled ? "cancelled" : "failed"; const message = error instanceof Error ? error.message : String(error); this.store.updateAgentRun(id, status, message); this.#emit(id, cancelled ? "run.cancelled" : "run.failed", { error: message }); }
    finally { this.#active.delete(id); }
  }
  #emit(runId: string, type: AgentEventType, data: Record<string, unknown>): void { const run = this.store.getAgentRun(runId); if (!run) return; const event: AgentEventEnvelope = { protocolVersion: AGENT_PROTOCOL_VERSION, runId, sequence: run.lastSequence + 1, timestamp: new Date().toISOString(), type, data }; this.store.appendAgentEvent(event); for (const listener of this.#listeners.get(runId) ?? []) listener(event); }
}
