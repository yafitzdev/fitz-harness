/**
 * Engine-neutral background work contract.
 *
 * Agent runs and media generations keep their specialized records because
 * their payloads and controls differ, but both publish their lifecycle into
 * this small common envelope. Consumers can reason about work without knowing
 * which execution engine produced it.
 */
export type JobKind = "agent" | "media" | "maintenance";
export type JobStatus = "queued" | "running" | "progressing" | "completed" | "failed" | "cancelled" | "interrupted";

export const JOB_KINDS: readonly JobKind[] = ["agent", "media", "maintenance"];
export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "progressing", "completed", "failed", "cancelled", "interrupted"];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalJobStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

export interface JobRecord {
  /** Same stable id as the specialized source record (agent run or media job). */
  id: string;
  kind: JobKind;
  status: JobStatus;
  ownerUserId?: string;
  sessionId?: string;
  parentJobId?: string;
  routeId?: string;
  progress?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

/** A compact lifecycle event. Detailed agent tokens/tool events remain in the
 * agent event log; this stream is deliberately bounded to control-plane state
 * and selected source metadata. */
export interface JobEvent {
  type: "created" | "started" | "updated" | "progress" | "completed" | "failed" | "cancelled" | "interrupted";
  status?: JobStatus;
  progress?: number;
  sourceType?: string;
  data?: Readonly<Record<string, unknown>>;
}

export interface JobEventEnvelope {
  jobId: string;
  sequence: number;
  timestamp: string;
  event: JobEvent;
}

export interface ListJobsOptions {
  ownerUserId?: string;
  sessionId?: string;
  kind?: JobKind;
  status?: JobStatus;
  limit?: number;
}
