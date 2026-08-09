import type { AgentRunRequest } from "@fitz/protocol";

export type AgentRuntimeEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed" }
  | { type: "user.steer"; text: string }
  | { type: "tool.approval.requested"; approvalId: string; toolCallId: string; toolName: string; input?: unknown }
  | { type: "tool.approval.resolved"; approvalId: string; toolCallId: string; toolName: string; decision: "approved" | "denied" }
  | { type: "tool.started"; toolCallId: string; toolName: string; input?: unknown }
  | { type: "tool.completed"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean };
export interface AgentRuntimeRun extends AsyncIterable<AgentRuntimeEvent> { cancel(): void; steer?(text: string): void | Promise<void> }
/** Optional per-run context the host can hand the runtime (e.g. the durable run id for safety records). */
export interface AgentRuntimeRunOptions { runId?: string; ownerUserId?: string; sessionId?: string }
export interface AgentRuntime { readonly id: string; run(request: AgentRunRequest, signal?: AbortSignal, options?: AgentRuntimeRunOptions): AgentRuntimeRun }
