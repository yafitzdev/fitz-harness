import type { ChatMessage } from "./openai.js";

export const AGENT_PROTOCOL_VERSION = "1" as const;
export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ToolAccessMode = "full" | "ask" | "read-only";

export type AgentResumeSafety = "safe" | "review-required";
export interface AgentCheckpointTool {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  isError?: boolean;
}
export interface AgentRunCheckpoint {
  sequence: number;
  phase: "queued" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled" | "interrupted";
  completedTools: AgentCheckpointTool[];
  inFlightTools: AgentCheckpointTool[];
  pendingApprovalIds: string[];
  resumeSafety: AgentResumeSafety;
  updatedAt: string;
}

export interface AgentRunRequest { model: string; messages: ChatMessage[]; maxTokens?: number; temperature?: number; sessionId?: string; accessMode?: ToolAccessMode; clientRequestId?: string }
export interface AgentRunRecord { id: string; routeId: string; status: AgentRunStatus; createdAt: string; updatedAt: string; lastSequence: number; ownerUserId?: string; sessionId?: string; error?: string; resumeOfRunId?: string; resumable?: boolean; checkpoint?: AgentRunCheckpoint }
export interface AgentQueueItem { runId: string; routeId: string; status: "running" | "queued"; position: number; depth: number; createdAt: string; ownerUserId?: string; sessionId?: string; sessionTitle?: string; projectName?: string }
export type AgentEventType = "run.created" | "run.queue.updated" | "run.started" | "assistant.delta" | "reasoning.delta" | "reasoning.completed" | "user.steer" | "tool.approval.requested" | "tool.approval.resolved" | "tool.started" | "tool.completed" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted";
export interface AgentEventEnvelope { protocolVersion: typeof AGENT_PROTOCOL_VERSION; runId: string; sequence: number; timestamp: string; type: AgentEventType; data: Readonly<Record<string, unknown>> }
