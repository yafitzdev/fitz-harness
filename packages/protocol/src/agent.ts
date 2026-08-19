import type { ChatMessage } from "./openai.js";

export const AGENT_PROTOCOL_VERSION = "1" as const;
export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ToolAccessMode = "full" | "ask" | "read-only";
/** User-selected work depth. `normal` is retained as the wire value for the
 * user-facing Medium tier so existing sessions and clients remain compatible. */
export type AgentEffort = "light" | "normal" | "high";

/** System-owned, versioned dispatch behavior. Recipes configure anonymous
 * worker capacity; the orchestrator selects one of these roles per dispatch. */
export interface SubagentRoleDefinition {
  id: string;
  version: number;
  displayName: string;
  dispatchDescription: string;
  systemInstructions: string;
  accessMode: Exclude<ToolAccessMode, "ask">;
  toolCallBudget: number;
  maxOutputTokens: number;
  outputContract: string;
  enabled: boolean;
}

export type SubagentRoleSnapshot = Omit<SubagentRoleDefinition, "enabled">;

/** Internal correlation for a delegated run. Child runs are deliberately
 * isolated from the parent conversation and cannot delegate recursively. */
export interface AgentDelegation {
  role: SubagentRoleSnapshot;
  parentRunId: string;
  planItemId?: string;
}

export type AgentPlanStatus = "active" | "ready_for_answer" | "completed";
export type AgentPlanItemStatus = "pending" | "running" | "completed" | "failed";
export type AgentPlanItemOwner = "main" | "worker";
export interface AgentPlanItem {
  id: string;
  task: string;
  dependencies: string[];
  owner: AgentPlanItemOwner;
  workerEligible: boolean;
  required: boolean;
  status: AgentPlanItemStatus;
  attempts: number;
  workerRunId?: string;
  result?: string;
  error?: string;
}
/** Durable, revisable execution gameplan owned by one root agent run. */
export interface AgentRunPlan {
  runId: string;
  revision: number;
  status: AgentPlanStatus;
  items: AgentPlanItem[];
  /** Explicit user-requested/system-required worker launches that must be
   * durably assigned before the plan may complete. */
  requiredWorkerRoutes?: Array<"default" | "fast" | "smart">;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

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

export interface AgentAttachmentReference { artifactId: string }
export interface AgentRunRequest { model: string; messages: ChatMessage[]; attachments?: AgentAttachmentReference[]; effort?: AgentEffort; maxTokens?: number; temperature?: number; sessionId?: string; accessMode?: ToolAccessMode; clientRequestId?: string; delegation?: AgentDelegation }
export interface AgentRunRecord { id: string; routeId: string; status: AgentRunStatus; createdAt: string; updatedAt: string; lastSequence: number; ownerUserId?: string; sessionId?: string; error?: string; resumeOfRunId?: string; resumable?: boolean; checkpoint?: AgentRunCheckpoint }
export interface AgentQueueItem { runId: string; routeId: string; status: "running" | "queued"; position: number; depth: number; createdAt: string; ownerUserId?: string; sessionId?: string; sessionTitle?: string; projectName?: string }
export type AgentEventType = "run.created" | "run.queue.updated" | "run.started" | "assistant.delta" | "reasoning.delta" | "reasoning.completed" | "user.steer" | "tool.approval.requested" | "tool.approval.resolved" | "tool.started" | "tool.completed" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted";
export interface AgentEventEnvelope { protocolVersion: typeof AGENT_PROTOCOL_VERSION; runId: string; sequence: number; timestamp: string; type: AgentEventType; data: Readonly<Record<string, unknown>> }
