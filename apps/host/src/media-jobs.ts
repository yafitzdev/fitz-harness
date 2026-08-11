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
  RequestUsageRecord,
} from "@fitz/protocol";
import { validateMediaGenerationParams } from "@fitz/media";
import { InferenceAdmissionError, type InferenceScheduler, type RouteResolver, type ScheduledMediaJob } from "@fitz/inference-core";
import { SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import { ArtifactQuotaExceededError, BlobSizeLimitError, type ArtifactRepository, type BlobSource, type MediaJobEventEnvelope, type SqliteStore } from "@fitz/storage";
import { classifyArtifact, normalizeMimeType } from "@fitz/media";

export interface MediaSubmitInput {
  routeId: string;
  recipeId?: string;
  sourceJobId?: string;
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

/** The durable media record was created, but its bounded execution lane could
 * not admit it. The job id lets clients inspect or retry the recorded failure. */
export class MediaJobAdmissionError extends Error {
  constructor(readonly jobId: string, readonly admission: InferenceAdmissionError) {
    super(admission.message, { cause: admission });
    this.name = "MediaJobAdmissionError";
  }
}

export class MediaCoordinatorClosedError extends Error {
  constructor() {
    super("Media generation is shutting down");
    this.name = "MediaCoordinatorClosedError";
  }
}

/** Durable media job service (§5.6): submit/poll/cancel over bounded resource lanes,
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
  readonly #consumers = new Map<string, Promise<void>>();
  readonly #listeners = new Map<string, Set<(event: MediaJobEventEnvelope) => void>>();
  #accepting = true;

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
  async submit(input: MediaSubmitInput, principal?: AuthenticatedPrincipal): Promise<MediaJobRecord> {
    if (!this.#accepting) throw new MediaCoordinatorClosedError();
    const resolved = this.#routes.resolve(input.routeId); // route still owns authorization and modality
    const route = resolved.route;
    const recipe = input.recipeId ? this.#routes.resolveRecipe(input.recipeId) : resolved.recipe;
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

    const requestedParams = constrainMediaParams(validateMediaGenerationParams(input.params), recipe);
    const params = this.#scheduler.resolveMediaParams(route.id, requestedParams, input.recipeId);
    const executionParams = await this.#materializeReferences(params);
    const id = randomUUID();
    const now = new Date().toISOString();
    const record: MediaJobRecord = {
      id,
      ...(input.sourceJobId ? { sourceJobId: input.sourceJobId } : {}),
      routeId: route.id,
      modality: input.modality,
      status: "queued",
      execution: {
        recipeId: recipe.id,
        recipeDisplayName: recipe.displayName,
        modelId: recipe.modelId,
        adapter: recipe.adapter,
      },
      params,
      enqueuedAt: now,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(principal ? { createdByUserId: principal.user.id } : input.userId ? { createdByUserId: input.userId } : {}),
      ...(creditCostCents !== undefined ? { creditCostCents } : {}),
    };
    this.#store.createMediaJob(record);
    let scheduled: ScheduledMediaJob;
    try {
      scheduled = this.#scheduler.enqueueMedia(route.id, {
        modality: input.modality,
        params: executionParams,
        ...(principal ? { userId: principal.user.id } : input.userId ? { userId: input.userId } : {}),
      }, undefined, {
        jobId: id,
        ...(input.recipeId ? { recipeId: input.recipeId } : {}),
        context: { ...(principal ? { ownerUserId: principal.user.id } : input.userId ? { ownerUserId: input.userId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), label: `${input.modality} generation` },
      });
    } catch (error) {
      if (error instanceof InferenceAdmissionError) {
        this.#fail(id, error.message, error.reason);
        throw new MediaJobAdmissionError(id, error);
      }
      this.#fail(id, errorMessage(error), "scheduler_admission_failed");
      throw error;
    }
    this.#active.set(id, scheduled);
    // The channel buffers everything pushed before this consumer attaches, so the
    // durable record always exists before any of its events are persisted.
    const consumer = this.#consume(id, scheduled);
    this.#consumers.set(id, consumer);
    void consumer.then(
      () => this.#consumers.delete(id),
      () => this.#consumers.delete(id),
    );
    return this.#store.getMediaJob(id)!;
  }

  /** Provider adapters receive self-contained data URLs while the durable job
   * record keeps compact artifact ids. This keeps blob payloads out of SQLite
   * and lets local/remote media engines consume the same reference contract. */
  async #materializeReferences(params: MediaGenerationParams): Promise<MediaGenerationParams> {
    if (!params.refs?.length) return params;
    const refs: Array<{ url: string }> = [];
    for (const ref of params.refs) {
      if ("url" in ref) {
        refs.push(ref);
        continue;
      }
      const artifact = this.#store.getArtifact(ref.artifactId);
      if (!artifact) throw new TypeError(`Reference artifact not found: ${ref.artifactId}`);
      if (!artifact.mimeType.startsWith("image/")) throw new TypeError(`Reference artifact is not an image: ${ref.artifactId}`);
      const bytes = await this.#artifacts.read(ref.artifactId);
      if (!bytes) throw new TypeError(`Reference artifact content is unavailable: ${ref.artifactId}`);
      refs.push({ url: `data:${artifact.mimeType};base64,${Buffer.from(bytes).toString("base64")}` });
    }
    return { ...params, refs };
  }

  get(id: string): MediaJobRecord | undefined {
    return this.#store.getMediaJob(id);
  }

  list(options: { ownerUserId?: string; sessionId?: string; status?: MediaJobStatus; limit?: number } = {}): MediaJobRecord[] {
    return this.#store.listMediaJobs(options);
  }

  listWithLineage(options: { ownerUserId?: string; sessionId?: string; status?: MediaJobStatus; limit?: number } = {}): MediaJobRecord[] {
    const selected = this.list(options);
    const jobs = new Map(selected.map((job) => [job.id, job]));
    for (const job of selected) {
      for (const ancestor of this.lineage(job.id)) {
        if (options.ownerUserId !== undefined && ancestor.createdByUserId !== options.ownerUserId) continue;
        if (options.sessionId !== undefined && ancestor.sessionId !== options.sessionId) continue;
        jobs.set(ancestor.id, ancestor);
      }
    }
    return [...jobs.values()].sort((left, right) => right.enqueuedAt.localeCompare(left.enqueuedAt));
  }

  lineage(id: string): MediaJobRecord[] {
    const lineage: MediaJobRecord[] = [];
    const seen = new Set<string>();
    let current = this.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      lineage.unshift(current);
      current = current.sourceJobId ? this.get(current.sourceJobId) : undefined;
    }
    return lineage;
  }

  submitEdit(source: MediaJobRecord, prompt: string, principal?: AuthenticatedPrincipal): Promise<MediaJobRecord> {
    if (source.modality !== "image" || source.status !== "completed" || !source.artifactId) {
      throw new TypeError("Only completed image jobs can be edited");
    }
    const inherited = inheritedImageEditParams(source.params);
    return this.submit({
      routeId: source.routeId,
      ...(source.execution?.recipeId ? { recipeId: source.execution.recipeId } : {}),
      sourceJobId: source.id,
      modality: "image",
      params: { ...inherited, operation: "edit", prompt, refs: [{ artifactId: source.artifactId }] },
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      ...(!principal && source.createdByUserId ? { userId: source.createdByUserId } : {}),
    }, principal);
  }

  retry(original: MediaJobRecord, principal?: AuthenticatedPrincipal): Promise<MediaJobRecord> {
    return this.submit({
      routeId: original.routeId,
      ...(original.execution?.recipeId ? { recipeId: original.execution.recipeId } : {}),
      ...(original.sourceJobId ? { sourceJobId: original.sourceJobId } : {}),
      modality: original.modality,
      params: original.params,
      ...(original.sessionId ? { sessionId: original.sessionId } : {}),
      ...(!principal && original.createdByUserId ? { userId: original.createdByUserId } : {}),
    }, principal);
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

  /** Stop admission, cancel provider work, and wait for every terminal event and
   * artifact finalizer before the database or blob repository may close. */
  async shutdown(): Promise<void> {
    if (!this.#accepting) {
      await Promise.allSettled([...this.#consumers.values()]);
      return;
    }
    this.#accepting = false;
    for (const scheduled of this.#active.values()) scheduled.cancel();
    await Promise.allSettled([...this.#consumers.values()]);
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
            this.#recordUsage(id, "completed", scheduled.lane);
          } catch (error) {
            this.#fail(id, errorMessage(error), error instanceof ArtifactTooLargeError ? "artifact_too_large" : error instanceof ArtifactQuotaExceededError ? "artifact_quota_exceeded" : undefined, scheduled.lane);
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
        this.#recordUsage(id, "cancelled", scheduled.lane);
      } else {
        this.#fail(id, errorMessage(error), "generation_failed", scheduled.lane);
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
      const artifactId = randomUUID();
      const name = `${artifactTimestamp(new Date())}_${artifactId}${extension}`;
      try {
        return await this.#artifacts.create({
          id: artifactId,
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
            operation: job.params.operation ?? "generate",
            ...(job.execution ? {
              recipeId: job.execution.recipeId,
              modelId: job.execution.modelId,
              adapter: job.execution.adapter,
            } : {}),
            ...(job.params.operation === "edit" && job.params.refs?.[0] && "artifactId" in job.params.refs[0]
              ? { sourceArtifactId: job.params.refs[0].artifactId }
              : {}),
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
  #fail(id: string, message: string, errorCode = "generation_failed", lane?: ScheduledMediaJob["lane"]): void {
    const now = new Date().toISOString();
    this.#store.updateMediaJob(id, { status: "failed", errorCode, completedAt: now });
    this.#appendEvent(id, { type: "failed", error: message });
    this.#recordUsage(id, "failed", lane, errorCode);
  }

  #recordUsage(id: string, status: RequestUsageRecord["status"], lane?: ScheduledMediaJob["lane"], errorCode?: string): void {
    const job = this.#store.getMediaJob(id);
    if (!job) return;
    let recipe: Recipe | undefined;
    try {
      recipe = job.execution?.recipeId
        ? this.#routes.resolveRecipe(job.execution.recipeId)
        : this.#routes.resolve(job.routeId).recipe;
    } catch { /* A removed route or recipe must not erase terminal accounting. */ }
    const finishedAt = job.completedAt ?? job.cancelledAt ?? new Date().toISOString();
    const enqueued = Date.parse(job.enqueuedAt);
    const started = job.startedAt ? Date.parse(job.startedAt) : undefined;
    const finished = Date.parse(finishedAt);
    try { this.#store.recordRequestUsage({
      id: job.id,
      kind: job.modality,
      status,
      routeId: job.routeId,
      ...(recipe ? { recipeId: recipe.id, playbookId: recipe.playbookId, adapter: recipe.adapter, modelId: recipe.modelId } : {}),
      ...(job.createdByUserId ? { ownerUserId: job.createdByUserId } : {}),
      ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      executionLane: lane ?? "gpu",
      enqueuedAt: job.enqueuedAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      completedAt: finishedAt,
      ...(started === undefined ? {} : { queueWaitMs: Math.max(0, started - enqueued) }),
      ...(Number.isFinite(finished) ? { durationMs: Math.max(0, finished - (started ?? enqueued)) } : {}),
      ...(job.creditCostCents !== undefined ? { creditCostCents: job.creditCostCents } : {}),
      ...(errorCode ? { errorCode } : {}),
      metadata: { ...job.params },
    }); } catch { /* Usage accounting is fail-open and never changes job outcome. */ }
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
  if (typeof limits.maxFps === "number" && typeof next.fps === "number") {
    next.fps = Math.min(next.fps, limits.maxFps);
  }
  if (typeof next.size === "string") {
    const grid = typeof recipe.configuration.sizeGrid === "number" ? recipe.configuration.sizeGrid : undefined;
    const constrained = constrainResolution(next.size, parseResolution(limits.maxResolution), grid);
    if (constrained !== undefined) next.size = constrained;
  }
  if (typeof limits.maxRefs === "number" && next.refs && next.refs.length > limits.maxRefs) {
    next.refs = next.refs.slice(0, limits.maxRefs);
  }
  return next;
}

/**
 * Fits a requested resolution inside the recipe's maximum box, then snaps it
 * to the model's spatial grid. The box is orientation-agnostic — the two
 * numbers are the longest and shortest allowed side — so landscape AND
 * portrait 720p both fit "1280x720". The grid (H3's latent needs multiples
 * of 16) keeps latent dims integral: without it a request like "1920x1080"
 * would reach the model off-grid and fail mid-job.
 */
function constrainResolution(
  size: string,
  maximum: { width: number; height: number } | undefined,
  grid: number | undefined,
): string | undefined {
  const requested = parseResolution(size);
  if (!requested || !maximum) return size;
  const maxLong = Math.max(maximum.width, maximum.height);
  const maxShort = Math.min(maximum.width, maximum.height);
  let { width, height } = requested;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long > maxLong || short > maxShort) {
    const scale = Math.min(maxLong / long, maxShort / short);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  if (grid && grid > 0) {
    width = Math.max(grid, Math.round(width / grid) * grid);
    height = Math.max(grid, Math.round(height / grid) * grid);
    const snappedLong = Math.max(width, height);
    const snappedShort = Math.min(width, height);
    if (snappedLong > maxLong || snappedShort > maxShort) {
      const scale = Math.min(maxLong / snappedLong, maxShort / snappedShort);
      width = Math.max(grid, Math.floor((width * scale) / grid) * grid);
      height = Math.max(grid, Math.floor((height * scale) / grid) * grid);
    }
  }
  return `${width}x${height}`;
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

function artifactTimestamp(value: Date): string {
  return value.toISOString().replace("T", "_").replaceAll(":", "-").replace(".", "-");
}

function inheritedImageEditParams(params: MediaGenerationParams): Omit<MediaGenerationParams, "prompt" | "operation" | "refs"> {
  return {
    ...(params.negativePrompt !== undefined ? { negativePrompt: params.negativePrompt } : {}),
    ...(params.size !== undefined ? { size: params.size } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.sampler !== undefined ? { sampler: params.sampler } : {}),
    ...(params.steps !== undefined ? { steps: params.steps } : {}),
    ...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
