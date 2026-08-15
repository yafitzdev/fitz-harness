export interface ProjectRecord { id: string; ownerUserId?: string; name: string; rootPath?: string; createdAt: string; updatedAt: string }
export type SessionStatus = "active" | "archived";
export type SessionRouteId = "default" | "fast" | "smart";
export interface SessionRecord { id: string; projectId?: string; ownerUserId?: string; title: string; status: SessionStatus; connectionId?: string; routeId?: SessionRouteId; createdAt: string; updatedAt: string }
export type TranscriptEntryKind = "message" | "reasoning" | "tool-call" | "tool-result" | "compaction" | "system";
export interface TranscriptEntryRecord { id: string; sessionId: string; sequence: number; kind: TranscriptEntryKind; role?: "system" | "user" | "assistant" | "tool"; content: Readonly<Record<string, unknown>>; createdAt: string }
export interface RegenerateAssistantTurnRequest { runId: string }
export interface RegeneratedAssistantTurn { prompt: string; removedTranscriptEntries: number; estimatedContextTokens: number }
export type ToolPolicyDecision = "allow" | "deny" | "ask";
export interface ToolPolicyRecord { subjectType: "role" | "user"; subjectId: string; toolName: string; decision: ToolPolicyDecision; updatedAt: string }
export type ToolApprovalStatus = "pending" | "approved" | "denied" | "cancelled";
export interface ToolApprovalRecord { id: string; sessionId: string; runId?: string; toolCallId: string; toolName: string; status: ToolApprovalStatus; request: Readonly<Record<string, unknown>>; requestedAt: string; resolvedAt?: string; decidedByUserId?: string; note?: string }
