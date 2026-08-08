import { randomUUID } from "node:crypto";
import { type FakeInstanceHandle } from "@fitz/engine-fake";
import type {
  LaunchSpec,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaModality,
  Recipe,
  ResourceEstimate,
  ValidationReport,
} from "@fitz/protocol";
import type {
  InstanceInspection,
  MediaEngineAdapter,
  MediaJobHandle,
  MediaJobPoll,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "@fitz/inference-core";

export interface HostMediaFakeOptions {
  progressPerPoll?: number;
  failWhenPromptIncludes?: string;
}

/** Deterministic MediaEngineAdapter test double for host integration tests
 *  (media-jobs and media-gateway). PR 3 replaces it with the reusable
 *  `engine-media-fake` package. */
export class HostMediaFakeEngineAdapter implements MediaEngineAdapter<FakeInstanceHandle> {
  readonly id = "media-fake";
  readonly modalities: MediaModality[] = ["image", "video", "audio"];
  readonly defaultPollIntervalMs = 1;
  readonly starts: FakeInstanceHandle[] = [];
  readonly submitted: MediaGenerationRequest[] = [];
  readonly cancelled: Array<{ instanceId: string; jobId: string }> = [];
  readonly #progressPerPoll: number;
  readonly #failWhenPromptIncludes: string | undefined;
  readonly #jobs = new Map<string, { request: MediaGenerationRequest; progress: number }>();

  constructor(options: HostMediaFakeOptions = {}) {
    this.#progressPerPoll = options.progressPerPoll ?? 0.25;
    this.#failWhenPromptIncludes = options.failWhenPromptIncludes;
  }

  async prepare(_recipe: Recipe, _signal: AbortSignal): Promise<void> {}

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    return recipe.adapter === this.id
      ? { valid: true, issues: [] }
      : { valid: false, issues: [{ level: "error", code: "adapter_mismatch", message: `Recipe adapter must be ${this.id}` }] };
  }

  async estimateResources(_recipe: Recipe): Promise<ResourceEstimate> {
    return { vramMiB: 0, ramMiB: 16 };
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    return {
      executable: "fitz-fake-media-engine",
      args: ["--model", recipe.modelId, "--port", String(allocation.port)],
      env: {},
      internalHost: allocation.host,
      internalPort: allocation.port,
    };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<FakeInstanceHandle> {
    if (signal.aborted) throw abortError();
    const handle: FakeInstanceHandle = {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: `http://${spec.internalHost}:${spec.internalPort}`,
      startedAt: new Date(),
      stopped: false,
    };
    this.starts.push(handle);
    return handle;
  }

  async waitUntilReady(instance: FakeInstanceHandle, _signal: AbortSignal): Promise<ReadyInfo> {
    return { modelId: instance.modelId, baseUrl: instance.baseUrl };
  }

  async submit(_instance: FakeInstanceHandle, request: MediaGenerationRequest, signal: AbortSignal): Promise<MediaJobHandle> {
    if (signal.aborted) throw abortError();
    this.submitted.push(structuredClone(request));
    const jobId = `provider-${this.submitted.length}`;
    this.#jobs.set(jobId, { request, progress: 0 });
    return { id: jobId, modality: request.modality };
  }

  async poll(_instance: FakeInstanceHandle, job: MediaJobHandle, signal: AbortSignal): Promise<MediaJobPoll> {
    if (signal.aborted) throw abortError();
    const record = this.#jobs.get(job.id);
    if (!record) return { status: "cancelled" };
    if (this.#failWhenPromptIncludes && record.request.params.prompt.includes(this.#failWhenPromptIncludes)) {
      this.#jobs.delete(job.id);
      return { status: "failed", error: "Fake media engine configured request failure" };
    }
    record.progress = Math.min(1, record.progress + this.#progressPerPoll);
    if (record.progress >= 1) {
      this.#jobs.delete(job.id);
      return { status: "completed", progress: 1, result: hostMediaResult(record.request.modality) };
    }
    return { status: "progressing", progress: record.progress };
  }

  async cancel(instance: FakeInstanceHandle, job: MediaJobHandle): Promise<void> {
    this.cancelled.push({ instanceId: instance.id, jobId: job.id });
    this.#jobs.delete(job.id);
  }

  async stop(instance: FakeInstanceHandle, _mode: StopMode): Promise<StopReport> {
    instance.stopped = true;
    return { stopped: true };
  }

  async inspect(instance: FakeInstanceHandle): Promise<InstanceInspection> {
    return {
      healthy: !instance.stopped,
      modelId: instance.modelId,
      ...(instance.stopped ? { detail: "stopped" } : {}),
    };
  }
}

export function hostMediaResult(modality: MediaModality): MediaGenerationResult {
  const data = new Uint8Array([1, 2, 3]);
  const mimeType = modality === "image" ? "image/png" : modality === "video" ? "video/mp4" : "audio/wav";
  return { data, mimeType, byteSize: data.byteLength };
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
