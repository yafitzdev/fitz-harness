import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun } from "@fitz/agent-core";
import type { AgentRunRequest } from "@fitz/protocol";

type PiEvent =
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown };
export interface PiSession { subscribe(listener: (event: PiEvent) => void): () => void; prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): void }
export type PiSessionFactory = (options: { cwd: string; tools: readonly string[] }) => Promise<PiSession>;
export interface PiAgentRuntimeOptions { cwd?: string; tools?: readonly string[]; createSession?: PiSessionFactory }

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly #cwd: string; readonly #tools: readonly string[]; readonly #createSession: PiSessionFactory;
  constructor(options: PiAgentRuntimeOptions = {}) { this.#cwd = options.cwd ?? process.cwd(); this.#tools = options.tools ?? []; this.#createSession = options.createSession ?? createSdkSession; }
  run(request: AgentRunRequest, signal?: AbortSignal): AgentRuntimeRun {
    const channel = new EventChannel(); let session: PiSession | undefined; const controller = new AbortController();
    const cancel = () => { controller.abort(); void session?.abort(); }; if (signal) { if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true }); }
    void (async () => { try { session = await this.#createSession({ cwd: this.#cwd, tools: this.#tools }); if (controller.signal.aborted) { await session.abort(); throw abortError(); }
      const unsubscribe = session.subscribe((event) => { const translated = translateEvent(event); if (translated) channel.push(translated); }); try { await session.prompt(formatPrompt(request)); if (controller.signal.aborted) throw abortError(); channel.close(); } finally { unsubscribe(); session.dispose(); }
    } catch (error) { channel.fail(error); } })(); return Object.assign(channel, { cancel });
  }
}

async function createSdkSession(options: { cwd: string; tools: readonly string[] }): Promise<PiSession> { const sdk = await import("@earendil-works/pi-coding-agent"); const result = await sdk.createAgentSession({ cwd: options.cwd, tools: [...options.tools], sessionManager: sdk.SessionManager.inMemory(options.cwd) }); return result.session as PiSession; }
function translateEvent(event: PiEvent): AgentRuntimeEvent | undefined { if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta) return { type: "assistant.delta", text: event.assistantMessageEvent.delta }; if (event.type === "tool_execution_start") return { type: "tool.started", toolCallId: event.toolCallId, toolName: event.toolName }; if (event.type === "tool_execution_end") return { type: "tool.completed", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result }; return undefined; }
function formatPrompt(request: AgentRunRequest): string { return request.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n"); }
function abortError(): Error { const error = new Error("Pi agent run was cancelled"); error.name = "AbortError"; return error; }

class EventChannel implements AsyncIterable<AgentRuntimeEvent> { readonly #values: AgentRuntimeEvent[] = []; readonly #waiters: Array<{ resolve: (result: IteratorResult<AgentRuntimeEvent>) => void; reject: (error: unknown) => void }> = []; #closed = false; #error: unknown;
  push(value: AgentRuntimeEvent): void { const waiter = this.#waiters.shift(); if (waiter) waiter.resolve({ value, done: false }); else this.#values.push(value); }
  close(): void { this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true }); }
  fail(error: unknown): void { this.#error = error; this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> { return { next: async () => { const value = this.#values.shift(); if (value) return { value, done: false }; if (this.#error) throw this.#error; if (this.#closed) return { value: undefined, done: true }; return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject })); } }; }
}
