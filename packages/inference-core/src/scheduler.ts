import { randomUUID } from "node:crypto";
import type { InferenceDelta, InferenceLane, InferenceRequest, InstanceSnapshot, MediaGenerationRequest, MediaJobEvent, Recipe, RequestUsageRecord } from "@fitz/protocol";
import { AsyncChannel } from "./async-channel.js";
import { BoundedWorkLane, type WorkLaneStatus } from "./bounded-work-lane.js";
import { LifecycleEventBus } from "./event-bus.js";
import { LifecycleManager } from "./lifecycle-manager.js";
import { RemoteMediaExecutor } from "./remote-media-executor.js";
import { RouteResolver } from "./route-resolver.js";

export interface WorkContext {
  ownerUserId?: string;
  sessionId?: string;
  runId?: string;
  label?: string;
}

interface JobBase {
  id: string;
  routeId: string;
  lane: InferenceLane;
  enqueuedAt: string;
  context: WorkContext;
  controller: AbortController;
  detachExternalAbort?: () => void;
}

interface LocalChatTelemetry {
  inferenceStarted?: Date;
  generatedText: string;
  outputChunks: number;
}

type QueueJob =
  | (JobBase & { kind: "chat"; recipeId?: string; unloadAfterCompletion?: boolean; request: InferenceRequest; output: AsyncChannel<InferenceDelta> })
  | (JobBase & { kind: "media"; recipeId?: string; mediaRequest: MediaGenerationRequest; output: AsyncChannel<MediaJobEvent> })
  | (JobBase & { kind: "warm"; result: Deferred<InstanceSnapshot> });

export interface ScheduledStream extends AsyncIterable<InferenceDelta> { requestId: string; cancel(): void }
export interface ScheduledMediaJob { jobId: string; lane: InferenceLane; events: AsyncIterable<MediaJobEvent>; cancel(): void }
export interface ScheduledWarmup { requestId: string; result: Promise<InstanceSnapshot>; cancel(): void }
export interface RecipeEnqueueOptions { unloadAfterCompletion?: boolean; context?: WorkContext }
export interface MediaEnqueueOptions { jobId: string; recipeId?: string; context?: WorkContext }

export interface InferenceQueueItem {
  id: string;
  routeId: string;
  kind: QueueJob["kind"];
  lane: InferenceLane;
  status: "running" | "queued";
  position: number;
  enqueuedAt: string;
  context: WorkContext;
}

export interface InferenceSchedulerOptions {
  /** Maximum local requests admitted concurrently. LifecycleManager still
   * enforces each active recipe's maxConcurrentGenerations and exclusive
   * recipe switching. */
  gpuConcurrency?: number;
  cloudConcurrency?: number;
  gpuQueueCapacity?: number;
  cloudQueueCapacity?: number;
  remoteMedia?: RemoteMediaExecutor;
  streamBufferItems?: number;
  streamBufferBytes?: number;
  /** Durable accounting sink. Failures in analytics must never fail inference. */
  recordUsage?: (record: RequestUsageRecord) => void | Promise<void>;
}

export type InferenceAdmissionReason = "queue_capacity" | "scheduler_closed";

/** A request that could not enter a bounded execution lane. Callers can map
 * this stable machine contract to an immediate retryable HTTP response. */
export class InferenceAdmissionError extends Error {
  readonly retryable = true;

  constructor(readonly lane: InferenceLane, readonly reason: InferenceAdmissionReason) {
    super(reason === "queue_capacity"
      ? `The ${lane} inference queue is at capacity`
      : "Inference scheduler is shutting down");
    this.name = "InferenceAdmissionError";
  }
}

/** Coordinates all inference work through explicit resource lanes. Local
 * concurrency is bounded here and again by the active recipe; cloud media uses
 * its own independent bounded lane. */
export class InferenceScheduler {
  readonly #gpuLane: BoundedWorkLane<QueueJob>;
  readonly #cloudLane: BoundedWorkLane<QueueJob>;
  readonly #remoteMedia: RemoteMediaExecutor;
  readonly #streamBufferItems: number;
  readonly #streamBufferBytes: number;
  readonly #recordUsage: InferenceSchedulerOptions["recordUsage"];

  constructor(
    readonly routes: RouteResolver,
    readonly lifecycle: LifecycleManager,
    readonly events: LifecycleEventBus = lifecycle.events,
    options: InferenceSchedulerOptions = {},
  ) {
    this.#remoteMedia = options.remoteMedia ?? new RemoteMediaExecutor(lifecycle.adapters);
    this.#streamBufferItems = options.streamBufferItems ?? 64;
    this.#streamBufferBytes = options.streamBufferBytes ?? 1024 * 1024;
    this.#recordUsage = options.recordUsage;
    this.#gpuLane = this.#createLane(options.gpuConcurrency ?? 1, options.gpuQueueCapacity ?? 256);
    this.#cloudLane = this.#createLane(options.cloudConcurrency ?? 4, options.cloudQueueCapacity ?? 64);
  }

  get queueDepth(): number { return this.#gpuLane.depth + this.#cloudLane.depth }

  resolveMediaParams(routeId: string, params: MediaGenerationRequest["params"], recipeId?: string): MediaGenerationRequest["params"] {
    const recipe = recipeId ? this.routes.resolveRecipe(recipeId) : this.routes.resolve(routeId).recipe;
    const adapter = this.lifecycle.adapters.getMedia(recipe.adapter);
    return adapter.resolveParams(recipe, params);
  }

  enqueue(routeId: string, input: Omit<InferenceRequest, "id" | "routeId">, externalSignal?: AbortSignal, context: WorkContext = {}): ScheduledStream {
    return this.#enqueue(routeId, input, externalSignal, undefined, undefined, context);
  }

  enqueueRecipe(recipeId: string, input: Omit<InferenceRequest, "id" | "routeId">, externalSignal?: AbortSignal, options: RecipeEnqueueOptions = {}): ScheduledStream {
    this.routes.resolveRecipe(recipeId);
    return this.#enqueue(`recipe:${recipeId}`, input, externalSignal, recipeId, options.unloadAfterCompletion, options.context ?? {});
  }

  enqueueMedia(routeId: string, input: Omit<MediaGenerationRequest, "id" | "routeId">, externalSignal: AbortSignal | undefined, options: MediaEnqueueOptions): ScheduledMediaJob {
    let lane: InferenceLane = "gpu";
    try {
      const recipe = options.recipeId ? this.routes.resolveRecipe(options.recipeId) : this.routes.resolve(routeId).recipe;
      const adapter = this.lifecycle.adapters.getMedia(recipe.adapter);
      lane = (adapter.executionLocation?.(recipe) ?? "local") === "remote" ? "cloud" : "gpu";
    } catch {
      // Resolution is repeated inside the lane so invalid requests fail through
      // the scheduled stream instead of escaping enqueue synchronously.
    }
    const id = options.jobId;
    if (!id.trim()) throw new TypeError("Media scheduler jobId must not be empty");
    // A completed local-media event can contain one artifact-sized atomic
    // payload before MediaJobService streams it into blob storage. It may cross
    // the ordinary event high-water mark, but it is the only buffered value;
    // progress events cannot accumulate behind it.
    const output = this.#outputChannel<MediaJobEvent>(true);
    const job: QueueJob = { kind: "media", id, routeId, ...(options.recipeId ? { recipeId: options.recipeId } : {}), lane, enqueuedAt: new Date().toISOString(), context: options.context ?? {}, mediaRequest: { ...input, id, routeId }, output, controller: new AbortController() };
    this.#attachAbort(job, externalSignal);
    this.#submit(job);
    return { jobId: id, lane, events: output, cancel: () => this.#lane(lane).cancel(job) };
  }

  enqueueWarm(routeId: string, externalSignal?: AbortSignal, context: WorkContext = {}): ScheduledWarmup {
    const id = randomUUID();
    const result = deferred<InstanceSnapshot>();
    const job: QueueJob = { kind: "warm", id, routeId, lane: "gpu", enqueuedAt: new Date().toISOString(), context, result, controller: new AbortController() };
    this.#attachAbort(job, externalSignal);
    this.#submit(job);
    return { requestId: id, result: result.promise, cancel: () => this.#gpuLane.cancel(job) };
  }

  snapshot(): InferenceQueueItem[] {
    return ([...this.#snapshotLane(this.#gpuLane), ...this.#snapshotLane(this.#cloudLane)])
      .sort((left, right) => left.status === right.status ? left.position - right.position : left.status === "running" ? -1 : 1);
  }

  cancel(requestId: string): boolean {
    for (const lane of [this.#gpuLane, this.#cloudLane]) {
      const item = [...lane.snapshot().active, ...lane.snapshot().queued].find((candidate) => candidate.id === requestId);
      if (item) return lane.cancel(item);
    }
    return false;
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.#gpuLane.shutdown(), this.#cloudLane.shutdown()]);
    await this.lifecycle.stop("host-shutdown", "force");
  }

  #enqueue(routeId: string, input: Omit<InferenceRequest, "id" | "routeId">, externalSignal: AbortSignal | undefined, recipeId: string | undefined, unloadAfterCompletion: boolean | undefined, context: WorkContext): ScheduledStream {
    const id = randomUUID();
    const output = this.#outputChannel<InferenceDelta>();
    const job: QueueJob = { kind: "chat", id, routeId, lane: "gpu", enqueuedAt: new Date().toISOString(), context, request: { ...input, id, routeId }, output, controller: new AbortController(), ...(recipeId ? { recipeId } : {}), ...(unloadAfterCompletion ? { unloadAfterCompletion: true } : {}) };
    this.#attachAbort(job, externalSignal);
    this.#submit(job);
    return Object.assign(output, { requestId: id, cancel: () => this.#gpuLane.cancel(job) });
  }

  #createLane(concurrency: number, maxQueued: number): BoundedWorkLane<QueueJob> {
    return new BoundedWorkLane({
      concurrency,
      maxQueued,
      execute: (job) => this.#execute(job),
      settleQueuedCancellation: (job) => {
        failJob(job, abortError());
        if (job.kind === "chat") {
          let recipe: Recipe | undefined;
          try { recipe = job.recipeId ? this.routes.resolveRecipe(job.recipeId) : this.routes.resolve(job.routeId).recipe; } catch { /* preserve cancellation when configuration changed */ }
          void this.#safeRecordUsage(this.#chatUsage(job, recipe, "cancelled", new Date(), undefined));
        }
        job.detachExternalAbort?.();
      },
      onStateChange: (job, status, position, depth) => this.#publishQueue(job, status, position, depth),
      ownerOf: (job) => job.context.ownerUserId ?? "local",
    });
  }

  #submit(job: QueueJob): void {
    if (job.controller.signal.aborted) {
      failJob(job, abortError());
      job.detachExternalAbort?.();
      return;
    }
    const result = this.#lane(job.lane).enqueue(job);
    if (result === "accepted") return;
    job.detachExternalAbort?.();
    throw new InferenceAdmissionError(job.lane, result === "full" ? "queue_capacity" : "scheduler_closed");
  }

  async #execute(job: QueueJob): Promise<void> {
    const started = new Date();
    let chatRecipe: Recipe | undefined;
    let firstOutput: Date | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const localTelemetry: LocalChatTelemetry = { generatedText: "", outputChunks: 0 };
    try {
      if (job.kind === "chat") {
        chatRecipe = job.recipeId ? this.routes.resolveRecipe(job.recipeId) : this.routes.resolve(job.routeId).recipe;
        for await (const delta of this.lifecycle.run(chatRecipe, job.request, job.controller.signal, {
          onInferenceStarted: () => { localTelemetry.inferenceStarted = new Date(); },
        })) {
          if (!firstOutput && (delta.text || delta.reasoning || delta.toolCalls?.length)) firstOutput = new Date();
          const generated = generatedDeltaText(delta);
          if (generated) {
            localTelemetry.generatedText += generated;
            localTelemetry.outputChunks += 1;
          }
          if (delta.promptTokens !== undefined) promptTokens = delta.promptTokens;
          if (delta.completionTokens !== undefined) completionTokens = delta.completionTokens;
          await job.output.push(delta, job.controller.signal);
        }
        if (job.unloadAfterCompletion) await this.lifecycle.stop(`recipe-test:${chatRecipe.id}`, "graceful");
      } else if (job.kind === "media") {
        const recipe = job.recipeId ? this.routes.resolveRecipe(job.recipeId) : this.routes.resolve(job.routeId).recipe;
        const events = job.lane === "cloud"
          ? this.#remoteMedia.run(recipe, job.mediaRequest, job.controller.signal)
          : this.lifecycle.runMedia(recipe, job.mediaRequest, job.controller.signal);
        for await (const event of events) await job.output.push(event, job.controller.signal);
      } else {
        const recipe = this.routes.resolve(job.routeId).recipe;
        job.result.resolve(await this.lifecycle.warm(recipe, job.controller.signal));
      }
      closeJob(job);
      if (job.kind === "chat") await this.#safeRecordUsage(this.#chatUsage(job, chatRecipe, "completed", started, firstOutput, promptTokens, completionTokens, undefined, localTelemetry));
    } catch (error) {
      failJob(job, error);
      if (job.kind === "chat") await this.#safeRecordUsage(this.#chatUsage(job, chatRecipe, isAbort(error) ? "cancelled" : "failed", started, firstOutput, promptTokens, completionTokens, error, localTelemetry));
      throw error;
    } finally {
      job.detachExternalAbort?.();
    }
  }

  #chatUsage(job: Extract<QueueJob, { kind: "chat" }>, recipe: Recipe | undefined, status: RequestUsageRecord["status"], started: Date, firstOutput?: Date, promptTokens?: number, completionTokens?: number, error?: unknown, localTelemetry?: LocalChatTelemetry): RequestUsageRecord {
    const completed = new Date();
    const enqueued = new Date(job.enqueuedAt);
    const inferenceStarted = localTelemetry?.inferenceStarted;
    const responseDurationMs = inferenceStarted ? Math.max(0, completed.getTime() - inferenceStarted.getTime()) : undefined;
    const outputDelivery = localTelemetry?.outputChunks === 1 ? "atomic" : localTelemetry?.outputChunks && localTelemetry.outputChunks > 1 ? "streamed" : undefined;
    const estimatedCompletionTokens = completionTokens === undefined && localTelemetry?.generatedText
      ? estimateTokens(localTelemetry.generatedText)
      : undefined;
    const metadata = {
      ...(responseDurationMs !== undefined ? { responseDurationMs } : {}),
      ...(inferenceStarted ? { modelLoadMs: Math.max(0, inferenceStarted.getTime() - started.getTime()) } : {}),
      ...(localTelemetry?.outputChunks ? { observedOutputChunks: localTelemetry.outputChunks } : {}),
      ...(outputDelivery ? { outputDelivery } : {}),
      ...(estimatedCompletionTokens !== undefined ? { estimatedCompletionTokens, tokenEstimateMethod: "utf8-bytes-per-four" } : {}),
    };
    const ttftOrigin = inferenceStarted ?? started;
    return {
      id: job.id, kind: "chat", status, routeId: job.routeId,
      ...(recipe ? { recipeId: recipe.id, playbookId: recipe.playbookId, adapter: recipe.adapter, modelId: recipe.modelId } : {}),
      ...job.context, executionLane: job.lane, enqueuedAt: job.enqueuedAt,
      startedAt: started.toISOString(), ...(firstOutput ? { firstOutputAt: firstOutput.toISOString() } : {}),
      completedAt: completed.toISOString(), queueWaitMs: Math.max(0, started.getTime() - enqueued.getTime()),
      ...(firstOutput ? { ttftMs: Math.max(0, firstOutput.getTime() - ttftOrigin.getTime()), generationMs: Math.max(0, completed.getTime() - firstOutput.getTime()) } : {}),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      ...(promptTokens !== undefined ? { promptTokens } : {}), ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...(error ? { errorCode: error instanceof Error ? error.name : "inference_failed" } : {}),
    };
  }

  async #safeRecordUsage(record: RequestUsageRecord): Promise<void> {
    try { await this.#recordUsage?.(record); } catch { /* accounting is fail-open */ }
  }

  #attachAbort(job: QueueJob, externalSignal?: AbortSignal): void {
    if (!externalSignal) return;
    const abort = () => this.#lane(job.lane).cancel(job);
    if (externalSignal.aborted) abort();
    else {
      externalSignal.addEventListener("abort", abort, { once: true });
      job.detachExternalAbort = () => externalSignal.removeEventListener("abort", abort);
    }
  }

  #lane(lane: InferenceLane): BoundedWorkLane<QueueJob> { return lane === "gpu" ? this.#gpuLane : this.#cloudLane }

  #outputChannel<T>(allowSingleOversizedItem = false): AsyncChannel<T> {
    return new AsyncChannel<T>({
      capacity: this.#streamBufferItems,
      maxBufferedSize: this.#streamBufferBytes,
      sizeOf: serializedSize,
      allowSingleOversizedItem,
    });
  }

  #snapshotLane(lane: BoundedWorkLane<QueueJob>): InferenceQueueItem[] {
    const snapshot = lane.snapshot();
    return [
      ...snapshot.active.map((job) => queueItem(job, "running", 0)),
      ...snapshot.queued.map((job, index) => queueItem(job, "queued", index + 1)),
    ];
  }

  #publishQueue(job: QueueJob, status: WorkLaneStatus, position: number, depth: number): void {
    this.events.queueUpdated({ requestId: job.id, routeId: job.routeId, kind: job.kind, lane: job.lane, position, depth, status, ...job.context });
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject } }
function failJob(job: QueueJob, error: unknown): void { if (job.kind === "warm") job.result.reject(error); else job.output.fail(error) }
function closeJob(job: QueueJob): void { if (job.kind !== "warm") job.output.close() }
function abortError(): Error { const error = new Error("Inference request was cancelled"); error.name = "AbortError"; return error }
function queueItem(job: QueueJob, status: "running" | "queued", position: number): InferenceQueueItem { return { id: job.id, routeId: job.routeId, kind: job.kind, lane: job.lane, status, position, enqueuedAt: job.enqueuedAt, context: job.context } }
function serializedSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8") }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError" }
function estimateTokens(text: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4)) }
function generatedDeltaText(delta: InferenceDelta): string {
  const toolText = delta.toolCalls?.flatMap((call) => [call.id, call.function?.name, call.function?.arguments]).filter((value): value is string => Boolean(value)).join("") ?? "";
  return `${delta.text}${delta.reasoning ?? ""}${toolText}`;
}
