import type { MediaModality } from "./domain.js";

export type MediaJobStatus =
  | "queued"
  | "started"
  | "progressing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface MediaGenerationParams {
  prompt: string;
  negativePrompt?: string;
  /** image-to-video / reference editing. `url` may be a provider URL or a Fitz artifact download URL. */
  refs?: Array<{ artifactId: string } | { url: string }>;
  size?: string; // "1024x1024", "768x768", "1280x720", ...
  durationSeconds?: number;
  fps?: number;
  seed?: number;
  sampler?: string;
  steps?: number;
  guidance?: number;
  // Provider-specific extras ride in `configuration`-validated keys.
}

export interface MediaGenerationRequest {
  id: string;
  routeId: string;
  modality: MediaModality;
  params: MediaGenerationParams;
  userId?: string;
}

export interface MediaGenerationResult {
  /** Content bytes or a provider download URL; the coordinator resolves to bytes. */
  data: Uint8Array | { url: string };
  mimeType: string;
  byteSize: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface MediaJobRecord {
  id: string;
  sessionId?: string;
  routeId: string;
  modality: MediaModality;
  status: MediaJobStatus;
  params: MediaGenerationParams;
  progress?: number; // 0..1
  artifactId?: string; // set on completion, via SqliteStore.createArtifact
  providerJobId?: string; // opaque engine/provider job ref (polling/cancel across processes)
  errorCode?: string;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  createdByUserId?: string;
  creditCostCents?: number; // recipe.configuration.costCentsPerJob at submit time
}

/** One row of the `media_quota_ledger` table: a completed job's credit cost,
 *  appended so `sumMediaLedgerForUser` can enforce `MediaQuota.creditBudgetCents`. */
export interface MediaCreditRecord {
  id: string;
  userId: string;
  jobId: string;
  modality: MediaModality;
  costCents: number;
  createdAt: string;
}

/** Events yielded by the queue slot and persisted by the coordinator.
 *  Sequence numbers live in the `media_job_events` table (PK `(job_id, sequence)`),
 *  mirroring `agent_events` — the event DTOs carry no sequence field. SSE replay
 *  reads rows in sequence order, exactly like agent-run events. */
export type MediaJobEvent =
  | { type: "progress"; progress: number }
  | { type: "completed"; result: MediaGenerationResult }
  | { type: "failed"; error: string }
  | { type: "cancelled" };
