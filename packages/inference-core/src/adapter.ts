import type {
  InferenceDelta,
  InferenceRequest,
  LaunchSpec,
  MediaGenerationRequest,
  MediaGenerationResult,
  Recipe,
  ResourceEstimate,
  ValidationReport,
} from "@fitz/protocol";

export interface PortAllocation {
  host: string;
  port: number;
}

export interface EngineInstanceHandle {
  id: string;
  recipeId: string;
  baseUrl: string;
  startedAt: Date;
}

export interface ReadyInfo {
  modelId: string;
  baseUrl: string;
}

export interface InstanceInspection {
  healthy: boolean;
  modelId?: string;
  detail?: string;
}

export type StopMode = "graceful" | "force";

export interface StopReport {
  stopped: boolean;
  detail?: string;
}

/** A request was rejected without making the backing engine unhealthy.
 *  Lifecycle management must surface the error to the caller while keeping
 *  the loaded instance resident and available for subsequent requests. */
export class InferenceRequestRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InferenceRequestRejectedError";
  }
}

export interface EngineAdapter<THandle extends EngineInstanceHandle = EngineInstanceHandle> {
  readonly id: string;
  /** Prepare host/runtime state without starting a model-bearing process or occupying model VRAM. */
  prepare?(recipe: Recipe, signal: AbortSignal): Promise<void>;
  validateRecipe(recipe: Recipe): Promise<ValidationReport>;
  estimateResources(recipe: Recipe): Promise<ResourceEstimate>;
  buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec>;
  start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<THandle>;
  waitUntilReady(instance: THandle, signal: AbortSignal): Promise<ReadyInfo>;
  streamChat(
    instance: THandle,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta>;
  stop(instance: THandle, mode: StopMode): Promise<StopReport>;
  inspect(instance: THandle): Promise<InstanceInspection>;
}

export interface MediaJobHandle {
  id: string; // engine/provider-side job id
  modality: "image" | "video" | "audio";
}

export interface MediaJobPoll {
  status: "queued" | "started" | "progressing" | "completed" | "failed" | "cancelled";
  progress?: number; // 0..1
  result?: MediaGenerationResult; // present only when status === "completed"
  error?: string;
}

/** Job-oriented generation adapter (submit/poll/cancel) shared by local media
 *  engines (ComfyUI/H3) and cloud providers (fal, Replicate, OpenAI-media):
 *  only the HTTP payloads differ. */
export interface MediaEngineAdapter<THandle extends EngineInstanceHandle = EngineInstanceHandle> {
  readonly id: string;
  readonly modalities: Array<"image" | "video" | "audio">;
  /** Recommended poll interval for this engine/provider (default 1000 ms). */
  readonly defaultPollIntervalMs?: number;
  /** Where generation compute runs. Local is the safe default so newly added
   *  media engines automatically inherit host GPU thermal protection. */
  executionLocation?(recipe: Recipe): "local" | "remote";
  /** Resolve adapter/recipe defaults before durable admission so the job and
   * UI record the exact parameters that will reach the engine. */
  resolveParams?(recipe: Recipe, params: MediaGenerationRequest["params"]): MediaGenerationRequest["params"];
  prepare?(recipe: Recipe, signal: AbortSignal): Promise<void>;
  validateRecipe(recipe: Recipe): Promise<ValidationReport>;
  estimateResources(recipe: Recipe): Promise<ResourceEstimate>;
  buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec>;
  start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<THandle>;
  waitUntilReady(instance: THandle, signal: AbortSignal): Promise<ReadyInfo>;
  submit(instance: THandle, request: MediaGenerationRequest, signal: AbortSignal): Promise<MediaJobHandle>;
  poll(instance: THandle, job: MediaJobHandle, signal: AbortSignal): Promise<MediaJobPoll>;
  cancel(instance: THandle, job: MediaJobHandle): Promise<void>;
  stop(instance: THandle, mode: StopMode): Promise<StopReport>;
  inspect(instance: THandle): Promise<InstanceInspection>;
}

export function isMediaEngineAdapter(adapter: EngineAdapter | MediaEngineAdapter): adapter is MediaEngineAdapter {
  return typeof (adapter as MediaEngineAdapter).submit === "function";
}

export class EngineAdapterRegistry {
  /** One id-keyed map for both chat and media adapters; `get(id)` remains the
   *  chat path, `getMedia(id)` narrows via `isMediaEngineAdapter`. */
  readonly #adapters = new Map<string, EngineAdapter | MediaEngineAdapter>();

  constructor(adapters: Array<EngineAdapter | MediaEngineAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: EngineAdapter | MediaEngineAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Engine adapter already registered: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): EngineAdapter | MediaEngineAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`Unknown engine adapter: ${id}`);
    return adapter;
  }

  /** Media recipes resolve through here (throws for chat-only adapters). */
  getMedia(id: string): MediaEngineAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter || !isMediaEngineAdapter(adapter)) throw new Error(`Unknown media adapter: ${id}`);
    return adapter;
  }

  list(): Array<EngineAdapter | MediaEngineAdapter> {
    return [...this.#adapters.values()];
  }
}
