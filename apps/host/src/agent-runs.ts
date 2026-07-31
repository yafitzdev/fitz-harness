import type { AgentEventEnvelope, AgentEventType, AgentRunRecord, AgentRunRequest } from "@fitz/protocol";
import { AGENT_PROTOCOL_VERSION } from "@fitz/protocol";
import type { InferenceScheduler, ScheduledStream } from "@fitz/inference-core";
import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun } from "@fitz/agent-core";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "@fitz/storage";

export class AgentRunCoordinator {
  readonly #active = new Map<string, AgentRuntimeRun | ScheduledStream>();
  readonly #listeners = new Map<string, Set<(event: AgentEventEnvelope) => void>>();
  constructor(private readonly store: SqliteStore, private readonly scheduler: InferenceScheduler, private readonly runtime?: AgentRuntime) {}
  start(request: AgentRunRequest, ownerUserId?: string, canonicalMessages = request.messages): AgentRunRecord {
    const stream = this.runtime ? this.runtime.run(request) : this.scheduler.enqueue(request.model, { messages: request.messages, ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...(ownerUserId ? { userId: ownerUserId } : {}) });
    const id = "requestId" in stream ? stream.requestId : randomUUID();
    const now = new Date().toISOString(); const run: AgentRunRecord = { id, routeId: request.model, status: "queued", createdAt: now, updatedAt: now, lastSequence: 0, ...(ownerUserId ? { ownerUserId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}) };
    if (request.sessionId) for (const message of canonicalMessages) this.store.appendTranscriptEntry({ id: randomUUID(), sessionId: request.sessionId, kind: "message", role: message.role, content: { text: message.content, ...(message.name ? { name: message.name } : {}) }, createdAt: now });
    this.store.createAgentRun(run); this.#active.set(run.id, stream); this.#emit(run.id, "run.created", { routeId: request.model }); void this.#consume(run.id, stream); return this.store.getAgentRun(run.id)!;
  }
  get(id: string): AgentRunRecord | undefined { return this.store.getAgentRun(id); }
  list(ownerUserId?: string, limit = 100): AgentRunRecord[] { return this.store.listAgentRuns(ownerUserId, limit); }
  eventsAfter(id: string, after: number): AgentEventEnvelope[] { return this.store.agentEventsAfter(id, after); }
  subscribe(id: string, listener: (event: AgentEventEnvelope) => void): () => void { const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(listener); this.#listeners.set(id, listeners); return () => { listeners.delete(listener); if (listeners.size === 0) this.#listeners.delete(id); }; }
  cancel(id: string): boolean { const stream = this.#active.get(id); if (!stream) return false; stream.cancel(); return true; }
  async #consume(id: string, stream: AgentRuntimeRun | ScheduledStream): Promise<void> {
    this.store.updateAgentRun(id, "running"); this.#emit(id, "run.started", {});
    let assistantText = "";
    try { for await (const delta of stream) { const event = normalizeRuntimeEvent(delta); if (event.type === "assistant.delta") assistantText += String(event.data.text ?? ""); this.#emit(id, event.type, event.data); this.#appendToolTranscript(id, event.type, event.data); } this.#appendAssistantTranscript(id, assistantText); this.store.updateAgentRun(id, "completed"); this.#emit(id, "run.completed", {}); }
    catch (error) { this.#appendAssistantTranscript(id, assistantText); const cancelled = error instanceof Error && error.name === "AbortError"; const status = cancelled ? "cancelled" : "failed"; const message = error instanceof Error ? error.message : String(error); this.store.updateAgentRun(id, status, message); this.#emit(id, cancelled ? "run.cancelled" : "run.failed", { error: message }); }
    finally { this.#active.delete(id); }
  }
  #emit(runId: string, type: AgentEventType, data: Record<string, unknown>): void { const run = this.store.getAgentRun(runId); if (!run) return; const event: AgentEventEnvelope = { protocolVersion: AGENT_PROTOCOL_VERSION, runId, sequence: run.lastSequence + 1, timestamp: new Date().toISOString(), type, data }; this.store.appendAgentEvent(event); for (const listener of this.#listeners.get(runId) ?? []) listener(event); }
  #appendAssistantTranscript(runId: string, text: string): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (sessionId && text) this.store.appendTranscriptEntry({ id: randomUUID(), sessionId, kind: "message", role: "assistant", content: { text, runId }, createdAt: new Date().toISOString() }); }
  #appendToolTranscript(runId: string, type: AgentEventType, data: Record<string, unknown>): void { const sessionId = this.store.getAgentRun(runId)?.sessionId; if (!sessionId || (type !== "tool.started" && type !== "tool.completed")) return; this.store.appendTranscriptEntry({ id: randomUUID(), sessionId, kind: type === "tool.started" ? "tool-call" : "tool-result", role: "tool", content: { ...data, runId }, createdAt: new Date().toISOString() }); }
}

function normalizeRuntimeEvent(event: AgentRuntimeEvent | { text: string; finishReason?: string; promptTokens?: number; completionTokens?: number }): { type: AgentEventType; data: Record<string, unknown> } {
  if ("type" in event) { if (event.type === "assistant.delta") return { type: event.type, data: { text: event.text } }; return { type: event.type, data: { toolCallId: event.toolCallId, toolName: event.toolName, ...(event.type === "tool.completed" ? { result: event.result } : {}) } }; }
  return { type: "assistant.delta", data: { text: event.text, ...(event.finishReason ? { finishReason: event.finishReason } : {}), ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}), ...(event.completionTokens !== undefined ? { completionTokens: event.completionTokens } : {}) } };
}
