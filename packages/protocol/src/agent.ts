import type { ChatMessage } from "./openai.js";

export const AGENT_PROTOCOL_VERSION = "1" as const;
export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AgentRunRequest { model: string; messages: ChatMessage[]; maxTokens?: number; temperature?: number; sessionId?: string }
export interface AgentRunRecord { id: string; routeId: string; status: AgentRunStatus; createdAt: string; updatedAt: string; lastSequence: number; ownerUserId?: string; sessionId?: string; error?: string }
export type AgentEventType = "run.created" | "run.started" | "assistant.delta" | "tool.started" | "tool.completed" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted";
export interface AgentEventEnvelope { protocolVersion: typeof AGENT_PROTOCOL_VERSION; runId: string; sequence: number; timestamp: string; type: AgentEventType; data: Readonly<Record<string, unknown>> }
