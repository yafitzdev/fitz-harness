import type { AgentRunRequest } from "@fitz/protocol";

export type AgentRuntimeEvent = { type: "assistant.delta"; text: string } | { type: "tool.started" | "tool.completed"; toolCallId: string; toolName: string; result?: unknown };
export interface AgentRuntimeRun extends AsyncIterable<AgentRuntimeEvent> { cancel(): void }
export interface AgentRuntime { readonly id: string; run(request: AgentRunRequest, signal?: AbortSignal): AgentRuntimeRun }
