import type { AgentEventEnvelope, AgentRunCheckpoint, AgentRunPlan, AgentRunRecord, AgentRunRequest } from "./agent.js";
import type { ArtifactRecord } from "./artifacts.js";
import type { InferenceDelta } from "./openai.js";
import type { MediaJobEvent, MediaJobRecord } from "./media.js";
import type { RequestUsageRecord } from "./usage.js";
import type { AuditEventRecord } from "./security.js";
import type { ProjectRecord, SessionRecord, ToolApprovalRecord, TranscriptEntryRecord } from "./collaboration.js";
import type { SnapshotRecord, ToolActionRecord, TrashEntryRecord } from "./safety.js";

/** A durable request/response envelope captured at the shared inference
 * scheduler boundary. It is deliberately engine-neutral: every adapter gets
 * the same normalized request and delta stream, while provider-specific raw
 * fields may be added by an adapter in metadata without changing this type. */
export type InferenceEvidenceStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface InferenceEvidenceRecord {
  id: string;
  kind: "chat";
  status: InferenceEvidenceStatus;
  routeId: string;
  recipeId?: string;
  adapter?: string;
  modelId?: string;
  ownerUserId?: string;
  sessionId?: string;
  runId?: string;
  executionLane: "gpu" | "cloud";
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Exact normalized request handed to the selected engine adapter. */
  request: Readonly<Record<string, unknown>>;
  /** Normalized deltas observed from the adapter, including reasoning and
   * tool-call deltas. Provider wire fields are intentionally not fabricated. */
  response?: Readonly<Record<string, unknown>>;
  /** Durable timestamped delta stream. This remains available when a request
   * ends as interrupted and has no terminal response snapshot. */
  observedDeltas?: ReadonlyArray<InferenceEvidenceDelta>;
  error?: Readonly<Record<string, unknown>>;
  /** Resource/engine state captured at the adapter boundary. */
  engine?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}

/** A single normalized adapter delta. Kept separate from the terminal
 * response snapshot so an interrupted request retains output observed before
 * the host or provider disappeared. */
export interface InferenceEvidenceDelta {
  evidenceId: string;
  sequence: number;
  timestamp: string;
  delta: InferenceDelta;
}

export interface ForensicsArtifact extends ArtifactRecord {
  /** Included only in an explicitly full export; metadata-only responses omit it. */
  contentBase64?: string;
  contentReadError?: string;
}

export interface SessionForensicsRun {
  run: AgentRunRecord;
  request?: AgentRunRequest;
  checkpoint?: AgentRunCheckpoint;
  plan?: AgentRunPlan;
  events: AgentEventEnvelope[];
  usage: RequestUsageRecord[];
  evidence: InferenceEvidenceRecord[];
  toolActions: ToolActionRecord[];
  snapshot?: SnapshotRecord;
  trashEntries: TrashEntryRecord[];
}

export interface SessionForensicsMediaJob {
  job: MediaJobRecord;
  events: Array<{ jobId: string; sequence: number; timestamp: string; event: MediaJobEvent }>;
  usage: RequestUsageRecord[];
}

/** Versioned, session-rooted evidence document. The session ID is an opaque
 * lookup key; this object is the actual forensic artifact. */
export interface SessionForensicsBundle {
  schemaVersion: 1;
  generatedAt: string;
  session: SessionRecord;
  project?: ProjectRecord;
  transcript: TranscriptEntryRecord[];
  /** Evidence for every session-linked model request, including public
   * OpenAI-compatible calls that do not belong to an AgentRun. */
  evidence: InferenceEvidenceRecord[];
  runs: SessionForensicsRun[];
  approvals: ToolApprovalRecord[];
  artifacts: ForensicsArtifact[];
  mediaJobs: SessionForensicsMediaJob[];
  usage: RequestUsageRecord[];
  auditEvents: AuditEventRecord[];
  lifecycleEvents: ReadonlyArray<Readonly<Record<string, unknown>>>;
  legacyInferenceRequests: ReadonlyArray<Readonly<Record<string, unknown>>>;
  gpuWork: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Explicit coverage notes prevent a caller from mistaking absent data for
   * proof that a subsystem did not run. */
  coverage: {
    normalizedAdapterEvidence: true;
    rawProviderWirePayloads: "not-captured";
    externalProcessLogs: "best-effort" | "not-captured";
    reasoning: "emitted-events-only";
    artifactContent: "included" | "metadata-only";
  };
}

/** Shape used internally by the scheduler before storage adds a generated
 * timestamp and maps it to the durable row. */
export interface InferenceEvidenceResponse {
  deltas: InferenceDelta[];
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
}
