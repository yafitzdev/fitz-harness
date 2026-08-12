import type { MediaModality } from "./domain.js";

export type ActiveMediaJobStatus = "queued" | "started" | "progressing";
export type TerminalMediaJobStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type MediaJobStatus = ActiveMediaJobStatus | TerminalMediaJobStatus;

export const ACTIVE_MEDIA_JOB_STATUSES: readonly ActiveMediaJobStatus[] = ["queued", "started", "progressing"];
export const TERMINAL_MEDIA_JOB_STATUSES: readonly TerminalMediaJobStatus[] = ["completed", "failed", "cancelled", "interrupted"];

export function isTerminalMediaJobStatus(status: string): status is TerminalMediaJobStatus {
  return (TERMINAL_MEDIA_JOB_STATUSES as readonly string[]).includes(status);
}

export function isActiveMediaJobStatus(status: string): status is ActiveMediaJobStatus {
  return (ACTIVE_MEDIA_JOB_STATUSES as readonly string[]).includes(status);
}

export type MediaGenerationOperation = "generate" | "edit" | "animate";

export interface MediaGenerationParams {
  prompt: string;
  /** Explicit intent for unified media routes. Edit and animate jobs must also
   * carry their source artifact in `refs`; adapters do not infer intent from
   * reference presence alone. */
  operation?: MediaGenerationOperation;
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

export interface MediaExecutionMetadata {
  recipeId: string;
  recipeDisplayName: string;
  modelId: string;
  adapter: string;
}

export interface MediaJobRecord {
  id: string;
  /** Direct parent job for edit/revision lineage. */
  sourceJobId?: string;
  sessionId?: string;
  routeId: string;
  modality: MediaModality;
  status: MediaJobStatus;
  /** Immutable engine identity selected when the job was admitted. */
  execution?: MediaExecutionMetadata;
  /** Effective parameters after recipe defaults are resolved. */
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
  | { type: "started"; providerJobId: string }
  | { type: "progress"; progress: number }
  | { type: "completed"; result: MediaGenerationResult }
  | { type: "failed"; error: string }
  | { type: "cancelled" };

// ---------------------------------------------------------------------------
// OpenAI-shaped media gateway (§5.8): the request/response shapes the host
// serves on /v1/.../generations and consumes from openai-media providers.
// "OpenAI-shaped", not wire-compatible: the video shape and the error envelope
// are Fitz contracts, and only Fitz's own clients consume the gateway.
// ---------------------------------------------------------------------------

export interface ImageGenerationRequest {
  model: string; // route id (the well-known "image" route or a granted media route)
  prompt: string;
  n?: number; // only n = 1 is supported in v1
  size?: string; // "1024x1024", "1280x720", ...
  response_format?: "url" | "b64_json"; // default "url"
  user?: string;
}

/** `data[].url` is always a Fitz artifact URL (provider URLs are fetched
 *  host-side, §5.11) — never a provider URL. */
export interface ImageGenerationResponse {
  created: number; // unix seconds
  data: Array<{ b64_json?: string; url?: string }>;
}

export interface VideoGenerationRequest {
  model: string; // route id (the well-known "video" route or a granted media route)
  prompt: string;
  duration?: number; // seconds
  resolution?: string; // "1280x720", ...
  user?: string;
}

/** Job-style response: `id` is the mediaJobId — poll progress via the Fitz-native
 *  `GET /api/v1/media/jobs/:id`; there is no /v1/videos/generations/{id} poll path
 *  in v1 (§5.8). */
export interface VideoGenerationResponse {
  id: string;
  object: "video.generation";
  status: MediaJobStatus;
  progress?: number;
  artifactId?: string;
  error?: string;
  createdAt: string;
}
