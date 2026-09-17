import { randomUUID } from "node:crypto";
import { FakeEngineAdapter, type FakeInstanceHandle } from "./testing.js";
import type {
  InferenceDelta,
  InferenceLifecycleEvent,
  LaunchSpec,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaJobEvent,
  MediaModality,
  Recipe,
  ResourceEstimate,
  Route,
  RouteKind,
  ValidationReport,
} from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import type {
  InstanceInspection,
  MediaEngineAdapter,
  MediaJobHandle,
  MediaJobPoll,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "./adapter.js";
import { EngineAdapterRegistry, isMediaEngineAdapter } from "./adapter.js";
import { ManualClock } from "./clock.js";
import { LifecycleEventBus } from "./event-bus.js";
import { LifecycleManager } from "./lifecycle-manager.js";
import { RouteNotFoundError, RouteResolver } from "./route-resolver.js";
import { InferenceScheduler } from "./scheduler.js";
import { GpuThermalGuard } from "./thermal.js";

type QueueUpdatedEvent = Extract<InferenceLifecycleEvent, { type: "queue.updated" }>;

interface MediaFakeEngineOptions {
  /** How much progress each poll advances (default 0.25 ⇒ 4 polls per job). */
  progressPerPoll?: number;
  failStart?: boolean;
  failWhenPromptIncludes?: string;
  remote?: boolean;
}

/** Test double implementing `MediaEngineAdapter`: deterministic submit/poll/cancel
 *  plus the shared lifecycle (start/stop/inspect), mirroring `FakeEngineAdapter`. */
class MediaFakeEngineAdapter implements MediaEngineAdapter<FakeInstanceHandle> {
  readonly id = "media-fake";
  readonly modalities: MediaModality[] = ["image", "video", "audio"];
  readonly defaultPollIntervalMs = 1;
  readonly starts: FakeInstanceHandle[] = [];
  readonly preparations: string[] = [];
  readonly stops: Array<{ instanceId: string; mode: StopMode }> = [];
  readonly submitted: MediaGenerationRequest[] = [];
  readonly cancelled: Array<{ instanceId: string; jobId: string }> = [];
  maximumActiveJobs = 0;
  readonly #options: { progressPerPoll: number; failStart?: boolean; failWhenPromptIncludes?: string; remote?: boolean };
  readonly #jobs = new Map<
    string,
    { instance: FakeInstanceHandle; request: MediaGenerationRequest; progress: number }
  >();

  constructor(options: MediaFakeEngineOptions = {}) {
    this.#options = {
      progressPerPoll: options.progressPerPoll ?? 0.25,
      ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
      ...(options.failWhenPromptIncludes
        ? { failWhenPromptIncludes: options.failWhenPromptIncludes }
        : {}),
      ...(options.remote !== undefined ? { remote: options.remote } : {}),
    };
  }

  executionLocation(): "local" | "remote" { return this.#options.remote ? "remote" : "local"; }

  resolveParams(_recipe: Recipe, params: MediaGenerationRequest["params"]): MediaGenerationRequest["params"] { return { ...params }; }

  async prepare(recipe: Recipe, _signal: AbortSignal): Promise<void> {
    this.preparations.push(recipe.id);
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = [];
    if (recipe.adapter !== this.id) {
      issues.push({
        level: "error" as const,
        code: "adapter_mismatch",
        message: `Recipe adapter must be ${this.id}`,
      });
    }
    if (!recipe.capabilities.modalities) {
      issues.push({
        level: "error" as const,
        code: "missing_modalities",
        message: "Media recipe must declare modalities",
      });
    }
    return { valid: issues.length === 0, issues };
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
    if (this.#options.failStart) throw new Error("Fake media engine configured to fail startup");
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

  async waitUntilReady(instance: FakeInstanceHandle, signal: AbortSignal): Promise<ReadyInfo> {
    if (signal.aborted) throw abortError();
    return { modelId: instance.modelId, baseUrl: instance.baseUrl };
  }

  async submit(
    instance: FakeInstanceHandle,
    request: MediaGenerationRequest,
    signal: AbortSignal,
  ): Promise<MediaJobHandle> {
    if (signal.aborted) throw abortError();
    this.submitted.push(structuredClone(request));
    const jobId = `provider-${this.submitted.length}`;
    this.#jobs.set(jobId, { instance, request, progress: 0 });
    this.maximumActiveJobs = Math.max(this.maximumActiveJobs, this.#jobs.size);
    return { id: jobId, modality: request.modality };
  }

  async poll(
    _instance: FakeInstanceHandle,
    job: MediaJobHandle,
    signal: AbortSignal,
  ): Promise<MediaJobPoll> {
    if (signal.aborted) throw abortError();
    const record = this.#jobs.get(job.id);
    if (!record) return { status: "cancelled" };
    if (
      this.#options.failWhenPromptIncludes &&
      record.request.params.prompt.includes(this.#options.failWhenPromptIncludes)
    ) {
      this.#jobs.delete(job.id);
      return { status: "failed", error: "Fake media engine configured request failure" };
    }
    record.progress = Math.min(1, record.progress + this.#options.progressPerPoll);
    if (record.progress >= 1) {
      this.#jobs.delete(job.id);
      return { status: "completed", progress: 1, result: mediaResult(record.request.modality) };
    }
    return { status: "progressing", progress: record.progress };
  }

  async cancel(instance: FakeInstanceHandle, job: MediaJobHandle): Promise<void> {
    this.cancelled.push({ instanceId: instance.id, jobId: job.id });
    this.#jobs.delete(job.id);
  }

  async stop(instance: FakeInstanceHandle, mode: StopMode): Promise<StopReport> {
    instance.stopped = true;
    this.stops.push({ instanceId: instance.id, mode });
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

describe("MediaEngineAdapter registry", () => {
  it("distinguishes media adapters and resolves them through the registry", () => {
    const mediaAdapter = new MediaFakeEngineAdapter();
    const chatAdapter = new FakeEngineAdapter();
    expect(isMediaEngineAdapter(mediaAdapter)).toBe(true);
    expect(isMediaEngineAdapter(chatAdapter)).toBe(false);

    const registry = new EngineAdapterRegistry([chatAdapter, mediaAdapter]);
    expect(registry.getMedia("media-fake")).toBe(mediaAdapter);
    expect(registry.get("media-fake")).toBe(mediaAdapter);
    expect(registry.list()).toHaveLength(2);
    expect(() => registry.getMedia("fake")).toThrow("Unknown media adapter: fake");
    expect(() => registry.get("missing")).toThrow("Unknown engine adapter: missing");
  });
});

describe("InferenceScheduler media jobs", () => {
  it("temporarily displaces local Default for media and restores it before releasing the GPU lane", async () => {
    const chatAdapter = new FakeEngineAdapter();
    const mediaAdapter = new MediaFakeEngineAdapter();
    const defaultRecipe = recipe("local-default", 1);
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([chatAdapter, mediaAdapter]),
      thermalGuard: safeThermalGuard(),
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("default", defaultRecipe.id), route("image", "image-recipe", "image")],
        [defaultRecipe, mediaRecipe("image-recipe", 60, "image")],
      ),
      lifecycle,
    );
    lifecycle.pin(defaultRecipe);
    await scheduler.enqueueWarm("default").result;

    expect(lifecycle.snapshot()).toMatchObject({ state: "READY", recipeId: defaultRecipe.id });
    await collectMedia(scheduler.enqueueMedia(
      "image",
      mediaInput("image", "a lighthouse"),
      undefined,
      mediaOptions(),
    ).events);

    expect(mediaAdapter.starts).toHaveLength(1);
    expect(mediaAdapter.stops).toEqual([expect.objectContaining({ mode: "graceful" })]);
    expect(chatAdapter.starts).toHaveLength(2);
    expect(lifecycle.snapshot()).toMatchObject({ state: "READY", recipeId: defaultRecipe.id, activeLeases: 0 });
    expect(lifecycle.residencySnapshot()).toEqual(expect.objectContaining({
      algorithm: "single-local-default-v1",
      pinned: expect.objectContaining({ recipeId: defaultRecipe.id, state: "ready" }),
    }));
  });

  it("uses an explicitly pinned media recipe instead of a reassigned route recipe", async () => {
    const mediaAdapter = new MediaFakeEngineAdapter();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([mediaAdapter]) });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("image", "replacement", "image")],
        [mediaRecipe("original", 60), mediaRecipe("replacement", 60)],
      ),
      lifecycle,
    );

    await collectMedia(scheduler.enqueueMedia(
      "image",
      mediaInput("image", "edit the original"),
      undefined,
      { ...mediaOptions(), recipeId: "original" },
    ).events);

    expect(mediaAdapter.starts).toEqual([expect.objectContaining({ recipeId: "original", modelId: "original-model" })]);
    expect(mediaAdapter.preparations).toEqual(["original"]);
  });

  it("lists routes with includeDisabled and keeps disabled media routes inert", async () => {
    const routes = new RouteResolver(
      [route("video", "media-recipe", "video"), route("off", "media-recipe", "video", false)],
      [mediaRecipe("media-recipe", 60, "video")],
    );
    expect(routes.listRoutes().map((entry) => entry.id)).toEqual(["video"]);
    expect(routes.listRoutes(true).map((entry) => entry.id)).toEqual(["video", "off"]);

    const mediaAdapter = new MediaFakeEngineAdapter();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([mediaAdapter]) });
    const scheduler = new InferenceScheduler(routes, lifecycle);

    await expect(
      collectMedia(scheduler.enqueueMedia("off", mediaInput("video", "nope"), undefined, mediaOptions()).events),
    ).rejects.toBeInstanceOf(RouteNotFoundError);
    expect(mediaAdapter.starts).toHaveLength(0);
    expect(mediaAdapter.submitted).toHaveLength(0);
  });

  it("serializes chat, activation, and media jobs on one kind-tagged FIFO", async () => {
    const chatAdapter = new FakeEngineAdapter();
    const mediaAdapter = new MediaFakeEngineAdapter();
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([chatAdapter, mediaAdapter]),
      events,
      thermalGuard: safeThermalGuard(),
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("chat", "chat-recipe"), route("video", "media-recipe", "video")],
        [recipe("chat-recipe", 60), mediaRecipe("media-recipe", 60, "video")],
      ),
      lifecycle,
      events,
    );

    const chat1 = scheduler.enqueue("chat", { messages: [{ role: "user", content: "one" }] });
    const warm = scheduler.enqueueWarm("chat");
    const media = scheduler.enqueueMedia("video", mediaInput("video", "a cat"), undefined, mediaOptions());
    const chat2 = scheduler.enqueue("chat", { messages: [{ role: "user", content: "two" }] });

    const [chat1Text, warmed, mediaEvents, chat2Text] = await Promise.all([
      collect(chat1),
      warm.result,
      collectMedia(media.events),
      collect(chat2),
    ]);

    expect(chat1Text).toContain("one");
    expect(warmed.recipeId).toBe("chat-recipe");
    expect(chat2Text).toContain("two");
    expect(mediaEvents.some((event) => event.type === "progress")).toBe(true);
    expect(mediaEvents.find((event) => event.type === "completed")).toMatchObject({
      type: "completed",
      result: { mimeType: "video/mp4", byteSize: 3 },
    });

    // FIFO order: chat instance, then the media instance, then a fresh chat instance.
    expect(mediaAdapter.starts).toHaveLength(1);
    expect(chatAdapter.starts).toHaveLength(2);

    // queue.updated events carry the kind discriminator per job.
    const queueUpdated = events.after(0).filter(
      (event): event is QueueUpdatedEvent => event.type === "queue.updated",
    );
    for (const requestId of [chat1.requestId, chat2.requestId]) {
      const chatJobEvents = queueUpdated.filter((event) => event.data.requestId === requestId);
      expect(chatJobEvents.length).toBeGreaterThan(0);
      for (const event of chatJobEvents) expect(event.data.kind).toBe("chat");
    }
    const mediaJobEvents = queueUpdated.filter((event) => event.data.requestId === media.jobId);
    expect(mediaJobEvents.length).toBeGreaterThan(0);
    for (const event of mediaJobEvents) expect(event.data.kind).toBe("media");

    const warmEvents = queueUpdated.filter((event) => event.data.requestId === warm.requestId);
    expect(warmEvents.length).toBeGreaterThan(0);
    for (const event of warmEvents) expect(event.data.kind).toBe("warm");

    // Every VRAM-touching entry point starts in FIFO order, never concurrently.
    const startedKinds = queueUpdated
      .filter((event) => event.data.status === "started")
      .map((event) => event.data.kind);
    expect(startedKinds).toEqual(["chat", "warm", "media", "chat"]);
  });

  it("keeps remote media off the GPU lane and bounds cloud concurrency", async () => {
    const chatAdapter = new FakeEngineAdapter({ tokenDelayMs: 40 });
    const mediaAdapter = new MediaFakeEngineAdapter({ remote: true, progressPerPoll: 0.1 });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([chatAdapter, mediaAdapter]), events });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("chat", "chat-recipe"), route("video", "media-recipe", "video")],
        [recipe("chat-recipe", 60), mediaRecipe("media-recipe", 60, "video")],
      ),
      lifecycle,
      events,
      { cloudConcurrency: 2 },
    );

    const chat = scheduler.enqueue("chat", { messages: [{ role: "user", content: "keep the GPU occupied" }] });
    await waitFor(() => lifecycle.snapshot().state === "BUSY");
    const media = ["one", "two", "three"].map((prompt) => scheduler.enqueueMedia("video", mediaInput("video", prompt), undefined, mediaOptions()));
    await Promise.all(media.map((job) => collectMedia(job.events)));

    expect(lifecycle.snapshot().state).toBe("BUSY");
    expect(mediaAdapter.maximumActiveJobs).toBe(2);
    expect(events.after(0).filter((event): event is QueueUpdatedEvent => event.type === "queue.updated" && event.data.kind === "media").every((event) => event.data.lane === "cloud")).toBe(true);
    expect(await collect(chat)).toContain("keep the GPU occupied");
    expect(chatAdapter.starts).toHaveLength(1);
  });

  it("cancels accepted remote work when provider polling fails", async () => {
    const mediaAdapter = new MediaFakeEngineAdapter({
      remote: true,
      failWhenPromptIncludes: "explode",
    });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([mediaAdapter]),
      events,
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("video", "media-recipe", "video")],
        [mediaRecipe("media-recipe", 60, "video")],
      ),
      lifecycle,
      events,
    );

    const job = scheduler.enqueueMedia(
      "video",
      mediaInput("video", "please explode"),
      undefined,
      mediaOptions(),
    );

    await expect(collectMedia(job.events)).rejects.toThrow(
      "Fake media engine configured request failure",
    );
    expect(mediaAdapter.cancelled).toEqual([
      { instanceId: expect.any(String), jobId: "provider-1" },
    ]);
    expect(mediaAdapter.stops).toEqual([
      { instanceId: expect.any(String), mode: "graceful" },
    ]);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
  });

  it("cancels a queued media job before it is submitted", async () => {
    const chatAdapter = new FakeEngineAdapter({ tokenDelayMs: 40 });
    const mediaAdapter = new MediaFakeEngineAdapter();
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([chatAdapter, mediaAdapter]),
      events,
      thermalGuard: safeThermalGuard(),
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("chat", "chat-recipe"), route("video", "media-recipe", "video")],
        [recipe("chat-recipe", 60), mediaRecipe("media-recipe", 60, "video")],
      ),
      lifecycle,
      events,
    );

    const chat = scheduler.enqueue("chat", { messages: [{ role: "user", content: "hold" }] });
    await waitFor(() => lifecycle.snapshot().state === "BUSY");
    const media = scheduler.enqueueMedia("video", mediaInput("video", "never"), undefined, mediaOptions());
    media.cancel();

    await expect(collectMedia(media.events)).rejects.toMatchObject({ name: "AbortError" });
    await expect(collect(chat)).resolves.toContain("hold");

    expect(mediaAdapter.submitted).toHaveLength(0);
    expect(mediaAdapter.starts).toHaveLength(0);
    const cancelled = events
      .after(0)
      .filter((event): event is QueueUpdatedEvent => event.type === "queue.updated")
      .find(
        (event) =>
          event.data.requestId === media.jobId && event.data.status === "cancelled",
      );
    expect(cancelled?.data.kind).toBe("media");
  });

  it("cancels an in-flight media job with a best-effort provider cancel", async () => {
    const mediaAdapter = new MediaFakeEngineAdapter({ progressPerPoll: 0.02 });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([mediaAdapter]),
      events,
      thermalGuard: safeThermalGuard(),
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("video", "media-recipe", "video")], [mediaRecipe("media-recipe", 60, "video")]),
      lifecycle,
      events,
    );

    const media = scheduler.enqueueMedia("video", mediaInput("video", "long render"), undefined, mediaOptions());
    await waitFor(() => lifecycle.snapshot().state === "BUSY" && mediaAdapter.submitted.length === 1);
    media.cancel();

    await expect(collectMedia(media.events)).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => lifecycle.snapshot().state === "UNLOADED");

    expect(mediaAdapter.cancelled).toEqual([{ instanceId: expect.any(String), jobId: "provider-1" }]);
    expect(lifecycle.snapshot()).toMatchObject({ state: "UNLOADED", activeLeases: 0 });
  });

  it("marks the lifecycle FAILED on media failure and recovers on the next job", async () => {
    const mediaAdapter = new MediaFakeEngineAdapter({ failWhenPromptIncludes: "explode" });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([mediaAdapter]),
      events,
      thermalGuard: safeThermalGuard(),
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("video", "media-recipe", "video")], [mediaRecipe("media-recipe", 60, "video")]),
      lifecycle,
      events,
    );

    await expect(
      collectMedia(
        scheduler.enqueueMedia("video", mediaInput("video", "please explode now"), undefined, mediaOptions()).events,
      ),
    ).rejects.toThrow("Fake media engine configured request failure");
    expect(lifecycle.snapshot().state).toBe("FAILED");

    const recovered = await collectMedia(
      scheduler.enqueueMedia("video", mediaInput("video", "recover"), undefined, mediaOptions()).events,
    );
    expect(recovered.some((event) => event.type === "completed")).toBe(true);
    await waitFor(() => lifecycle.snapshot().state === "UNLOADED");
    expect(mediaAdapter.starts).toHaveLength(2);
    expect(mediaAdapter.stops).toEqual([
      expect.objectContaining({ mode: "force" }),
      expect.objectContaining({ mode: "graceful" }),
    ]);
  });

  it("cancels and unloads a local media engine after a thermal safety failure", async () => {
    const mediaAdapter = new MediaFakeEngineAdapter({ progressPerPoll: 0.02 });
    let sample = 0;
    const thermalGuard = new GpuThermalGuard(
      {
        snapshot: async () => ({
          capturedAt: new Date(0).toISOString(),
          totalRamMiB: 64_000,
          freeRamMiB: 32_000,
          totalVramMiB: 32_000,
          usedVramMiB: 30_000,
          freeVramMiB: 2_000,
          gpuTemperatureC: sample++ === 0 ? 74 : 92,
          gpuPowerLimitW: 450,
          gpuMinPowerLimitW: 400,
          gpuMaxPowerLimitW: 450,
          gpuTelemetryAvailable: true,
        }),
      },
    );
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([mediaAdapter]),
      thermalGuard,
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("video", "media-recipe", "video")], [mediaRecipe("media-recipe", 600, "video")]),
      lifecycle,
    );

    await expect(
      collectMedia(scheduler.enqueueMedia("video", mediaInput("video", "hot render"), undefined, mediaOptions()).events),
    ).rejects.toThrow("emergency limit");

    expect(mediaAdapter.cancelled).toEqual([{ instanceId: expect.any(String), jobId: "provider-1" }]);
    expect(mediaAdapter.stops).toEqual([{ instanceId: expect.any(String), mode: "force" }]);
    expect(lifecycle.snapshot()).toMatchObject({ state: "UNLOADED", activeLeases: 0 });
  });

  it("evicts media immediately even when the recipe declares an idle TTL", async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 31));
    const mediaAdapter = new MediaFakeEngineAdapter();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([mediaAdapter]),
      clock,
      thermalGuard: safeThermalGuard(),
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("video", "media-recipe", "video")], [mediaRecipe("media-recipe", 5, "video")]),
      lifecycle,
    );

    const events = await collectMedia(
      scheduler.enqueueMedia("video", mediaInput("video", "steady"), undefined, mediaOptions()).events,
    );
    expect(events.some((event) => event.type === "completed")).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({ state: "READY", activeLeases: 0 });
    expect(mediaAdapter.starts).toHaveLength(1);

    await clock.advanceBy(0);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
    expect(mediaAdapter.stops).toHaveLength(1);
  });
});

function mediaResult(modality: MediaModality): MediaGenerationResult {
  const data = new Uint8Array([1, 2, 3]);
  const mimeType =
    modality === "image" ? "image/png" : modality === "video" ? "video/mp4" : "audio/wav";
  return { data, mimeType, byteSize: data.byteLength };
}

function safeThermalGuard(): GpuThermalGuard {
  return new GpuThermalGuard({
    snapshot: async () => ({
      capturedAt: new Date(0).toISOString(),
      totalRamMiB: 64_000,
      freeRamMiB: 32_000,
      totalVramMiB: 32_000,
      usedVramMiB: 1_000,
      freeVramMiB: 31_000,
      gpuTemperatureC: 74,
      gpuPowerLimitW: 400,
      gpuMinPowerLimitW: 400,
      gpuMaxPowerLimitW: 450,
      gpuTelemetryAvailable: true,
    }),
  });
}

function mediaInput(modality: MediaModality, prompt: string): Omit<MediaGenerationRequest, "id" | "routeId"> {
  return { modality, params: { prompt } };
}

function mediaOptions(): { jobId: string } {
  return { jobId: randomUUID() };
}

async function collect(stream: AsyncIterable<InferenceDelta>): Promise<string> {
  let text = "";
  for await (const delta of stream) text += delta.text;
  return text;
}

async function collectMedia(stream: AsyncIterable<MediaJobEvent>): Promise<MediaJobEvent[]> {
  const events: MediaJobEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function route(id: string, recipeId: string, kind: RouteKind = "chat", enabled = true): Route {
  return { id, displayName: id, recipeId, kind, enabled };
}

function recipe(id: string, ttlSeconds: number): Recipe {
  return {
    id,
    playbookId: "fake",
    displayName: id,
    adapter: "fake",
    modelId: `${id}-model`,
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: ttlSeconds,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}

function mediaRecipe(id: string, ttlSeconds: number, modality: MediaModality = "image"): Recipe {
  return {
    id,
    playbookId: "fake",
    displayName: id,
    adapter: "media-fake",
    modelId: `${id}-model`,
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: false,
      streaming: true,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
      modalities: { input: ["text"], output: [modality] },
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: ttlSeconds,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for test condition");
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
