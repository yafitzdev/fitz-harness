import type { AgentRunRequest } from "@fitz/protocol";

export type AgentRuntimeEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "tool.started"; toolCallId: string; toolName: string; input?: unknown }
  | { type: "tool.completed"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean };
export interface AgentRuntimeRun extends AsyncIterable<AgentRuntimeEvent> { cancel(): void }
export interface AgentRuntime { readonly id: string; run(request: AgentRunRequest, signal?: AbortSignal): AgentRuntimeRun }
