import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type {
  ArtifactRecord,
  MediaGenerationParams,
  MediaGenerationResult,
  MediaJobEvent,
  MediaJobRecord,
  MediaJobStatus,
  MediaModality,
  Recipe,
} from "@fitz/protocol";
import type { InferenceScheduler, RouteResolver, ScheduledMediaJob } from "@fitz/inference-core";
import { SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import { ArtifactQuotaExceededError, BlobSizeLimitError, type ArtifactRepository, type BlobSource, type MediaJobEventEnvelope, type SqliteStore } from "@fitz/storage";
import { classifyArtifact, normalizeMimeType } from "@fitz/media";

export interface MediaSubmitInput {
  routeId: string;
  modality: MediaModality;
  params: MediaGenerationParams;
  sessionId?: string;
  userId?: string;
}

export interface MediaJobCoordinatorOptions {
  store: SqliteStore;
  artifacts: ArtifactRepository;
  scheduler: InferenceScheduler;
  routes: RouteResolver;
  security?: SecurityService;
}

/** Kind-aware artifact caps (§5.11): image ≤ 25 MiB, audio ≤ 200 MiB, video ≤ 1 GiB.
 *  Configurable via the `mediaArtifactLimits` store setting. */
const DEFAULT_ARTIFACT_LIMITS: Record<MediaModality, number> = {
  image: 25 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
};

const MAX_ARTIFACT_NAME_LENGTH = 160;

export class ArtifactTooLargeError extends Error {
  constructor(readonly modality: MediaModality, readonly byteSize: number, readonly limit: number) {
    super(`Generated ${modality} exceeds the ${limit} byte artifact limit`);
    this.name = "ArtifactTooLargeError";
  }
}

/** Durable media job service (§5.6): submit/poll/cancel over the shared FIFO,
 *  sequenced event persistence (`media_job_events`), artifact write-back on
 *  completion, credit ledger append, quota enforcement, and restart recovery
 *  (recoverInterruptedMediaJobs runs at host boot, outside this class). */
export class MediaJobCoordinator {
  readonly #store: SqliteStore;
  readonly #artifacts: ArtifactRepository;
  readonly #scheduler: InferenceScheduler;
  readonly #routes: RouteResolver;
  readonly #security: SecurityService | undefined;
  readonly #active = new Map<string, ScheduledMediaJob>();
  readonly #listeners = new Map<string, Set<(event: MediaJobEventEnvelope) => void>>();

  constructor(options: MediaJobCoordinatorOptions) {
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#scheduler = options.scheduler;
    this.#routes = options.routes;
    this.#security = options.security;
  }

  /** Resolve → validate → authorize → quota → durable record → enqueue.
   *  The job's id is the scheduler's job id, so the durable record and the queue
   *  slot always agree. Returns the freshly created queued record. */
  submit(input: MediaSubmitInput, principal?: AuthenticatedPrincipal): MediaJobRecord {
    const { route, recipe } = this.#routes.resolve(input.routeId); // throws RouteNotFoundError when missing or disabled
    const kind = route.kind ?? "chat";
    if (kind !== input.modality) {
      throw new TypeError(`Route ${route.id} is a ${kind} route and cannot generate ${input.modality}`);
    }
    if (!recipe.capabilities.modalities?.output.includes(input.modality)) {
      throw new TypeError(`Recipe ${recipe.id} does not generate ${input.modality}`);
    }
    if (principal && !this.#security?.authorizeRoute(principal, route.id)) {
      throw new SecurityPolicyError("Route access denied");
    }
    const creditCostCents = creditCostCentsFor(recipe);
    if (principal && this.#security) {
      this.#security.enforceMediaQuota(principal, {
        modality: input.modality,
        ...(creditCostCents !== undefined ? { creditCostCents } : {}),
      });
    }

    const params = constrainMediaParams(input.params, recipe);
    const scheduled = this.#scheduler.enqueueMedia(route.id, {
      modality: input.modality,
      params,
      ...(principal ? { userId: principal.user.id } : input.userId ? { userId: input.userId } : {}),
    });
    const id = scheduled.jobId;
    const now = new Date().toISOString();
    const record: MediaJobRecord = {
      id,
      routeId: route.id,
      modality: input.modality,
      status: "queued",
      params,
      enqueuedAt: now,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(principal ? { createdByUserId: principal.user.id } : input.userId ? { createdByUserId: input.userId } : {}),
      ...(creditCostCents !== undefined ? { creditCostCents } : {}),
    };
    this.#store.createMediaJob(record);
    this.#active.set(id, scheduled);
    // The channel buffers everything pushed before this consumer attaches, so the
    // durable record always exists before any of its events are persisted.
    void this.#consume(id, scheduled);
    return this.#store.getMediaJob(id)!;
  }

  get(id: string): MediaJobRecord | undefined {
    return this.#store.getMediaJob(id);
  }

  list(options: { ownerUserId?: string; sessionId?: string; status?: MediaJobStatus; limit?: number } = {}): MediaJobRecord[] {
    return this.#store.listMediaJobs(options);
  }

  eventsAfter(id: string, after: number): MediaJobEventEnvelope[] {
    return this.#store.mediaJobEventsAfter(id, after);
  }

  subscribe(id: string, listener: (event: MediaJobEventEnvelope) => void): () => void {
    const listeners = this.#listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(id);
    };
  }

  /** Cancel at queue position (removes the queued slot) or in-flight (provider cancel);
   *  the event consumer flips the durable record to `cancelled`. */
  cancel(id: string): boolean {
    const scheduled = this.#active.get(id);
    if (!scheduled) return false;
    scheduled.cancel();
    return true;
  }

  async #consume(id: string, scheduled: ScheduledMediaJob): Promise<void> {
    try {
      for await (const event of scheduled.events) {
        if (event.type === "started") {
          // The provider job id is the durable restart link: recoverInterruptedMediaJobs
          // marks active jobs interrupted, and the host cancels orphaned provider jobs
          // whose providerJobId survives (design doc §5.3, PR 4).
          const now = new Date().toISOString();
          this.#store.updateMediaJob(id, {
            status: "started",
            startedAt: now,
            providerJobId: event.providerJobId,
          });
          this.#appendEvent(id, event);
        } else if (event.type === "progress") {
          const now = new Date().toISOString();
          const current = this.#store.getMediaJob(id);
          this.#store.updateMediaJob(id, {
            status: "progressing",
            progress: event.progress,
            ...(!current?.startedAt ? { startedAt: now } : {}),
          });
          this.#appendEvent(id, event);
        } else if (event.type === "completed") {
          try {
            const artifact = await this.#writeArtifact(id, event.result);
            const now = new Date().toISOString();
            this.#store.updateMediaJob(id, {
              status: "completed",
              progress: 1,
              artifactId: artifact.id,
              completedAt: now,
            });
            // Persist completion metadata, not a second JSON expansion of the
            // complete media byte array. The external artifact object is the sole
            // durable content copy; replay only needs terminal state + artifact id.
            this.#appendEvent(id, {
              type: "completed",
              result: {
                ...event.result,
                data: { url: `artifact:${artifact.id}` },
              },
            });
            this.#credit(id);
          } catch (error) {
            this.#fail(id, errorMessage(error), error instanceof ArtifactTooLargeError ? "artifact_too_large" : error instanceof ArtifactQuotaExceededError ? "artifact_quota_exceeded" : undefined);
          }
        }
      }
    } catch (error) {
      // The queue slot rejects on failure/cancellation (runMedia throws on both;
      // cancellation surfaces as AbortError), so terminal states arrive here.
      if (isAbortError(error)) {
        const now = new Date().toISOString();
        this.#store.updateMediaJob(id, { status: "cancelled", cancelledAt: now });
        this.#appendEvent(id, { type: "cancelled" });
      } else {
        this.#fail(id, errorMessage(error));
      }
    } finally {
      this.#active.delete(id);
    }
  }

  #writeArtifact(id: string, result: MediaGenerationResult): Promise<ArtifactRecord> {
    return (async () => {
      const job = this.#store.getMediaJob(id);
      if (!job) throw new Error(`Media job not found: ${id}`);
      const limit = this.#artifactLimit(job.modality);
      const source = await resolveResultSource(result);
      const mimeType = normalizeMimeType(result.mimeType);
      const extension = extensionFor(mimeType);
      const name = `${id}${extension}`;
      try {
      return await this.#artifacts.create({
        id: randomUUID(),
        sessionId: job.sessionId ?? this.#syntheticSession(job),
        name,
        mimeType,
        kind: classifyArtifact(mimeType, name),
        createdAt: new Date().toISOString(),
        ...(job.createdByUserId ? { createdByUserId: job.createdByUserId } : {}),
        metadata: {
          modality: job.modality,
          routeId: job.routeId,
          mediaJobId: id,
          ...(result.width !== undefined ? { width: result.width } : {}),
          ...(result.height !== undefined ? { height: result.height } : {}),
          ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
        },
      }, source, { maxBytes: limit });
      } catch (error) {
        if (error instanceof BlobSizeLimitError) throw new ArtifactTooLargeError(job.modality, error.byteSize, limit);
        throw error;
      }
    })();
  }

  /** Artifacts require a session row (FK). Jobs without one get a dedicated
   *  synthetic session so the artifact stays fetchable and owned by the creator. */
  #syntheticSession(job: MediaJobRecord): string {
    const now = new Date().toISOString();
    this.#store.createSession({
      id: job.id,
      title: `Media generation ${job.modality}`,
      status: "active",
      connectionId: "hosted--local",
      routeId: "default",
      createdAt: now,
      updatedAt: now,
      ...(job.createdByUserId ? { ownerUserId: job.createdByUserId } : {}),
    });
    return job.id;
  }

  #artifactLimit(modality: MediaModality): number {
    const configured = this.#store.getSetting<Partial<Record<MediaModality, number>> | undefined>("mediaArtifactLimits");
    return configured?.[modality] ?? DEFAULT_ARTIFACT_LIMITS[modality];
  }

  #credit(id: string): void {
    const job = this.#store.getMediaJob(id);
    if (!job?.createdByUserId || job.creditCostCents === undefined) return;
    this.#store.appendMediaCredit({
      id: randomUUID(),
      userId: job.createdByUserId,
      jobId: id,
      modality: job.modality,
      costCents: job.creditCostCents,
      createdAt: new Date().toISOString(),
    });
  }

  /** Terminal failure: `errorCode` carries the machine-readable code
   *  (e.g. `artifact_too_large`, design doc §5.11) and the failed event keeps
   *  the human-readable message. */
  #fail(id: string, message: string, errorCode = "generation_failed"): void {
    const now = new Date().toISOString();
    this.#store.updateMediaJob(id, { status: "failed", errorCode, completedAt: now });
    this.#appendEvent(id, { type: "failed", error: message });
  }

  #appendEvent(id: string, event: MediaJobEvent): void {
    const envelope = this.#store.appendMediaJobEvent(id, event, new Date().toISOString());
    for (const listener of this.#listeners.get(id) ?? []) listener(envelope);
  }
}

/** Honor a recipe's advertised generation ceiling at the queue boundary. Agent
 * tools are intentionally provider-agnostic and may request a generic 1080p
 * render; the selected local recipe remains the source of truth. */
function constrainMediaParams(params: MediaGenerationParams, recipe: Recipe): MediaGenerationParams {
  const limits = recipe.capabilities.modalities?.limits;
  if (!limits) return params;
  const next: MediaGenerationParams = { ...params };
  if (typeof limits.maxDurationSeconds === "number" && typeof next.durationSeconds === "number") {
    next.durationSeconds = Math.min(next.durationSeconds, limits.maxDurationSeconds);
  }
  const requested = parseResolution(next.size);
  const maximumResolution = limits.maxResolution;
  const maximum = parseResolution(maximumResolution);
  if (requested && maximum && (requested.width > maximum.width || requested.height > maximum.height)) {
    next.size = maximumResolution!;
  }
  if (typeof limits.maxRefs === "number" && next.refs && next.refs.length > limits.maxRefs) {
    next.refs = next.refs.slice(0, limits.maxRefs);
  }
  return next;
}

function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const match = /^(\d+)[xX](\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The submit-time credit cost for a recipe's job, from `configuration.costCentsPerJob`
 *  (cents). Undefined when the recipe declares no per-job cost (free/local routes). */
export function creditCostCentsFor(recipe: Recipe): number | undefined {
  const value = recipe.configuration.costCentsPerJob;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function resolveResultSource(result: MediaGenerationResult): Promise<BlobSource> {
  if (result.data instanceof Uint8Array) return result.data;
  const response = await fetch(result.data.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Failed to download media result (HTTP ${response.status})`);
  if (!response.body) throw new Error("Media result has no response body");
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
}

function extensionFor(mimeType: string): string {
  const table: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".weba",
  };
  return table[mimeType] ?? `.${mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin"}`.slice(0, MAX_ARTIFACT_NAME_LENGTH);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
