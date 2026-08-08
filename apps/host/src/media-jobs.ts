import { createHash, randomUUID } from "node:crypto";
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
import type { MediaJobEventEnvelope, SqliteStore } from "@fitz/storage";
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
const MAX_ERROR_CODE_LENGTH = 400;

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
  readonly #scheduler: InferenceScheduler;
  readonly #routes: RouteResolver;
  readonly #security: SecurityService | undefined;
  readonly #active = new Map<string, ScheduledMediaJob>();
  readonly #listeners = new Map<string, Set<(event: MediaJobEventEnvelope) => void>>();

  constructor(options: MediaJobCoordinatorOptions) {
    this.#store = options.store;
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

    const scheduled = this.#scheduler.enqueueMedia(route.id, {
      modality: input.modality,
      params: input.params,
      ...(principal ? { userId: principal.user.id } : input.userId ? { userId: input.userId } : {}),
    });
    const id = scheduled.jobId;
    const now = new Date().toISOString();
    const record: MediaJobRecord = {
      id,
      routeId: route.id,
      modality: input.modality,
      status: "queued",
      params: input.params,
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

  list(options: { ownerUserId?: string; status?: MediaJobStatus; limit?: number } = {}): MediaJobRecord[] {
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
        if (event.type === "progress") {
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
            this.#appendEvent(id, event);
            this.#credit(id);
          } catch (error) {
            this.#fail(id, errorMessage(error), error instanceof ArtifactTooLargeError ? "artifact_too_large" : undefined);
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
      const bytes = await resolveResultBytes(result);
      const limit = this.#artifactLimit(job.modality);
      if (bytes.byteLength > limit) throw new ArtifactTooLargeError(job.modality, bytes.byteLength, limit);
      const mimeType = normalizeMimeType(result.mimeType);
      const extension = extensionFor(mimeType);
      const name = `${id}${extension}`;
      const artifact: ArtifactRecord = {
        id: randomUUID(),
        sessionId: job.sessionId ?? this.#syntheticSession(job),
        name,
        mimeType,
        kind: classifyArtifact(mimeType, name),
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
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
      };
      this.#store.createArtifact(artifact, bytes);
      return artifact;
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

  #fail(id: string, message: string, errorCode = "generation_failed"): void {
    const now = new Date().toISOString();
    this.#store.updateMediaJob(id, { status: "failed", errorCode: message.slice(0, MAX_ERROR_CODE_LENGTH), completedAt: now });
    this.#appendEvent(id, { type: "failed", error: message });
  }

  #appendEvent(id: string, event: MediaJobEvent): void {
    const envelope = this.#store.appendMediaJobEvent(id, event, new Date().toISOString());
    for (const listener of this.#listeners.get(id) ?? []) listener(envelope);
  }
}

function creditCostCentsFor(recipe: Recipe): number | undefined {
  const value = recipe.configuration.costCentsPerJob;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function resolveResultBytes(result: MediaGenerationResult): Promise<Uint8Array> {
  if (result.data instanceof Uint8Array) return result.data;
  const response = await fetch(result.data.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Failed to download media result (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
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
