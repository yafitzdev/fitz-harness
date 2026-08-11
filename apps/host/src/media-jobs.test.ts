import { describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { FakeMediaEngineAdapter, deterministicMediaBytes } from "@fitz/engine-media-fake";
import type { MediaModality, Recipe, Route } from "@fitz/protocol";
import { RouteResolver } from "@fitz/inference-core";
import { ArtifactRepository, MemoryBlobStore, SqliteStore } from "@fitz/storage";
import { createHost, ensureMediaRoutes, type HostRuntime } from "./create-app.js";
import { reconcileNInferConfiguration } from "./ninfer-reconcile.js";

describe("Fitz host media jobs", () => {
  it("creates the well-known media routes disabled and preserves assignments", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      const routes = (await runtime.app.inject({ method: "GET", url: "/api/v1/management/routes" })).json().data as Route[];
      for (const id of ["image", "video", "audio"]) {
        expect(routes).toContainEqual(expect.objectContaining({ id, recipeId: "", enabled: false, kind: id }));
      }

      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      const assigned = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/image", payload: { displayName: "Image generation", recipeId: "h3-img", enabled: true } });
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect(assigned.json().data).toEqual(expect.objectContaining({ recipeId: "h3-img", enabled: true, kind: "image" }));

      // Re-invocation (boot, recipe upsert) is create-only: the assignment survives.
      ensureMediaRoutes(runtime.store, runtime.routes);
      const image = runtime.routes.listRoutes(true).find((route) => route.id === "image");
      expect(image).toMatchObject({ recipeId: "h3-img", enabled: true, kind: "image" });
    } finally {
      await runtime.app.close();
    }
  });

  it("completes a job, writes the artifact, and persists sequenced events", async () => {
    const mediaFake = new FakeMediaEngineAdapter();
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "a cat" } } });
      expect(submitted.statusCode, submitted.body).toBe(202);
      const jobId = submitted.json().data.id as string;
      expect(submitted.json().data).toEqual(expect.objectContaining({ routeId: "image", modality: "image", status: "queued" }));

      const job = await waitForJobStatus(runtime, jobId, "completed");
      expect(job.artifactId).toEqual(expect.any(String));
      expect(job).toEqual(expect.objectContaining({ progress: 1, status: "completed" }));

      // Artifact content matches the fake's bytes, served from the synthetic session.
      const content = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${job.artifactId}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toBe("image/png");
      expect([...content.rawPayload]).toEqual([...deterministicMediaBytes("image")]);

      // Durable event stream: started (with the provider job id) then progress
      // and the completed event, ascending sequences (§5.3).
      const events = runtime.store.mediaJobEventsAfter(jobId, 0);
      expect(events.length).toBeGreaterThan(1);
      expect(events[0]?.event.type).toBe("started");
      expect((events[0]?.event as { providerJobId: string }).providerJobId).toEqual(expect.any(String));
      expect(events.at(-1)?.event.type).toBe("completed");
      expect(events.at(-1)?.event).toEqual(expect.objectContaining({
        result: expect.objectContaining({ data: { url: `artifact:${job.artifactId}` } }),
      }));
      const sequences = events.map((event) => event.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

      // Media jobs never create inference_request rows (kind guard in the persistence subscriber).
      const inferenceRequestIds = runtime.store.listInferenceRequests(100).map((request) => request.id);
      expect(inferenceRequestIds).not.toContain(jobId);
    } finally {
      await runtime.app.close();
    }
  });

  it("rejects saturated media admission immediately while preserving a durable failed job", async () => {
    const runtime = createHost({
      adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter({ progressPerPoll: 0.00001 })],
      schedulerOptions: { cloudConcurrency: 1, cloudQueueCapacity: 1 },
    });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const first = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "first" } } });
      const second = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "second" } } });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);

      const overflow = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "overflow" } } });
      expect(overflow.statusCode, overflow.body).toBe(429);
      expect(overflow.headers["retry-after"]).toBe("2");
      expect(overflow.json().error).toEqual(expect.objectContaining({ code: "resource_busy", retryable: true }));
      const rejectedId = overflow.json().data.jobId as string;
      expect(runtime.store.getMediaJob(rejectedId)).toEqual(expect.objectContaining({ status: "failed", errorCode: "queue_capacity" }));
      expect(runtime.store.mediaJobEventsAfter(rejectedId, 0).at(-1)?.event).toEqual(expect.objectContaining({ type: "failed" }));

      runtime.mediaJobs.cancel(first.json().data.id);
      runtime.mediaJobs.cancel(second.json().data.id);
    } finally {
      await runtime.app.close();
    }
  });

  it("fails a job whose artifact exceeds the kind-aware size cap without writing it", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter({ resultByteLength: 25 * 1024 * 1024 + 1 })] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "oversized render" } } });
      expect(submitted.statusCode).toBe(202);
      const job = await waitForJobStatus(runtime, submitted.json().data.id, "failed");
      // The machine code lands on the job (design doc §5.11) while the
      // human-readable message stays on the failed event.
      expect(job).toEqual(expect.objectContaining({ errorCode: "artifact_too_large" }));
      const events = runtime.store.mediaJobEventsAfter(job.id, 0);
      const failed = [...events].reverse().find((event) => event.event.type === "failed");
      expect(failed?.event).toEqual(expect.objectContaining({ type: "failed" }));
      expect(String((failed?.event as { error: string }).error)).toContain("exceeds the 26214400 byte artifact limit");
    } finally {
      await runtime.app.close();
    }
  });

  it("honors the mediaArtifactLimits store setting per modality", async () => {
    const store = SqliteStore.memory();
    store.setSetting("mediaArtifactLimits", { image: 100 });
    const runtime = createHost({ store, adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter({ resultByteLength: 128 })] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "capped render" } } });
      const job = await waitForJobStatus(runtime, submitted.json().data.id, "failed");
      expect(job).toEqual(expect.objectContaining({ errorCode: "artifact_too_large" }));
      const events = runtime.store.mediaJobEventsAfter(job.id, 0);
      const failed = [...events].reverse().find((event) => event.event.type === "failed");
      expect(String((failed?.event as { error: string }).error)).toContain("100 byte artifact limit");
    } finally {
      await runtime.app.close();
    }
  });

  it("reports the global artifact quota separately from a per-media size limit", async () => {
    const store = SqliteStore.memory();
    store.setSetting("artifactStorageQuotaBytes", 1);
    const artifacts = new ArtifactRepository(store, new MemoryBlobStore(), { quotaBytes: () => store.getSetting<number>("artifactStorageQuotaBytes") });
    const runtime = createHost({ store, artifacts, adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter({ resultByteLength: 128 })] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");
      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "quota constrained" } } });
      const job = await waitForJobStatus(runtime, submitted.json().data.id, "failed");
      expect(job).toEqual(expect.objectContaining({ errorCode: "artifact_quota_exceeded" }));
    } finally { await runtime.app.close(); }
  });

  it("keeps chat persistence working while media jobs stay out of inference_requests", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const before = runtime.store.listInferenceRequests(100).length;
      const chat = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
      expect(chat.statusCode, chat.body).toBe(200);
      expect(runtime.store.listInferenceRequests(100).length).toBe(before + 1);

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "still a cat" } } });
      const jobId = submitted.json().data.id as string;
      await waitForJobStatus(runtime, jobId, "completed");
      expect(runtime.store.listInferenceRequests(100).length).toBe(before + 1);
    } finally {
      await runtime.app.close();
    }
  });

  it("rejects a job whose modality does not match the route kind", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-video", ["video"]);
      await assignRoute(runtime, "video", "h3-video");

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "video", modality: "image", params: { prompt: "wrong modality" } } });
      expect(submitted.statusCode).toBe(400);
      expect(String(submitted.json().error.message)).toContain("cannot generate image");
    } finally {
      await runtime.app.close();
    }
  });

  it("passes the media creation card's duration and fps straight through to the engine", async () => {
    // Mirrors the desktop renderer's submitMedia payload after the param-forwarding
    // fix: { prompt, durationSeconds, fps } must reach the engine untouched, or the
    // H3 recipe falls back to its 2 s / 24 fps defaults.
    const mediaFake = new FakeMediaEngineAdapter();
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      await registerMediaRecipe(runtime, "h3-video", ["video"]);
      await assignRoute(runtime, "video", "h3-video");

      const submitted = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/media/jobs",
        payload: { routeId: "video", modality: "video", params: { prompt: "dog swimming", durationSeconds: 3, fps: 30 } },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      expect(submitted.json().data.params).toEqual({ prompt: "dog swimming", durationSeconds: 3, fps: 30 });

      const job = await waitForJobStatus(runtime, submitted.json().data.id as string, "completed");
      expect(job.params).toEqual({ prompt: "dog swimming", durationSeconds: 3, fps: 30 });
      await waitFor(() => mediaFake.submitted.length === 1);
      expect(mediaFake.submitted[0]?.params).toEqual({ prompt: "dog swimming", durationSeconds: 3, fps: 30 });
    } finally {
      await runtime.app.close();
    }
  });

  it("constrains generic video requests to the selected recipe's declared limits", async () => {
    const mediaFake = new FakeMediaEngineAdapter();
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      const recipe = mediaRecipe("h3-video", ["video"]);
      recipe.capabilities.modalities!.limits = { maxDurationSeconds: 6, maxFps: 30, maxResolution: "1280x720", maxRefs: 1 };
      recipe.configuration = { sizeGrid: 16 };
      const registered = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/recipes/h3-video", payload: recipe });
      expect(registered.statusCode, registered.body).toBe(200);
      await assignRoute(runtime, "video", "h3-video");

      const submitted = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/media/jobs",
        payload: { routeId: "video", modality: "video", params: { prompt: "robot", size: "1920x1080", durationSeconds: 30, fps: 60 } },
      });
      expect(submitted.statusCode, submitted.body).toBe(202);
      expect(submitted.json().data.params).toEqual(expect.objectContaining({ size: "1280x720", durationSeconds: 6, fps: 30 }));
      await waitFor(() => mediaFake.submitted.length === 1);
      expect(mediaFake.submitted[0]?.params).toEqual(expect.objectContaining({ size: "1280x720", durationSeconds: 6, fps: 30 }));
    } finally {
      await runtime.app.close();
    }
  });

  it("retries a terminal job in the same session through current recipe limits", async () => {
    const mediaFake = new FakeMediaEngineAdapter({ failWhenPromptIncludes: "first attempt" });
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      const recipe = mediaRecipe("h3-video", ["video"]);
      recipe.capabilities.modalities!.limits = { maxResolution: "1344x768" };
      const registered = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/recipes/h3-video", payload: recipe });
      expect(registered.statusCode, registered.body).toBe(200);
      await assignRoute(runtime, "video", "h3-video");

      const original = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "video", modality: "video", params: { prompt: "first attempt", size: "1920x1080" } } });
      const failed = await waitForJobStatus(runtime, original.json().data.id, "failed");
      const retry = await runtime.app.inject({ method: "POST", url: `/api/v1/media/jobs/${failed.id}/retry` });

      expect(retry.statusCode, retry.body).toBe(202);
      expect(retry.json().data.id).not.toBe(failed.id);
      expect(retry.json().data.params).toEqual(expect.objectContaining({ prompt: "first attempt", size: "1344x756" }));
    } finally {
      await runtime.app.close();
    }
  });

  it("rejects assigning a chat recipe to a media route", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      const assigned = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/image", payload: { displayName: "Image generation", recipeId: "fake-best", enabled: true } });
      expect(assigned.statusCode, assigned.body).toBe(400);
      expect(String(assigned.json().error.message)).toContain("does not generate image");
    } finally {
      await runtime.app.close();
    }
  });

  it("de-assigns a media route with an empty recipeId and keeps it disabled", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const deassigned = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/image", payload: { displayName: "Image generation", recipeId: "", enabled: false } });
      expect(deassigned.statusCode, deassigned.body).toBe(200);
      expect(deassigned.json().data).toEqual(expect.objectContaining({ recipeId: "", enabled: false, kind: "image" }));

      // Still listed (visible for re-assignment), but resolve() treats it as missing.
      const routes = (await runtime.app.inject({ method: "GET", url: "/api/v1/management/routes" })).json().data as Route[];
      expect(routes).toContainEqual(expect.objectContaining({ id: "image", recipeId: "", enabled: false }));
      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "nope" } } });
      expect(submitted.statusCode).toBe(404);
    } finally {
      await runtime.app.close();
    }
  });

  it("cancels an in-flight job with a best-effort provider cancel", async () => {
    const mediaFake = new FakeMediaEngineAdapter({ progressPerPoll: 0.02 });
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "long render" } } });
      const jobId = submitted.json().data.id as string;
      await waitFor(() => mediaFake.submitted.length === 1);

      const cancelled = await runtime.app.inject({ method: "POST", url: `/api/v1/media/jobs/${jobId}/cancel` });
      expect(cancelled.statusCode, cancelled.body).toBe(202);
      expect(cancelled.json().data).toEqual({ id: jobId, cancellationRequested: true });

      const job = await waitForJobStatus(runtime, jobId, "cancelled");
      expect(job.cancelledAt).toEqual(expect.any(String));
      await waitFor(() => mediaFake.cancelled.length === 1);
      expect(mediaFake.cancelled).toEqual([{ instanceId: expect.any(String), jobId: "provider-1" }]);

      const events = runtime.store.mediaJobEventsAfter(jobId, 0);
      expect(events.at(-1)?.event.type).toBe("cancelled");
    } finally {
      await runtime.app.close();
    }
  });

  it("drains in-flight provider cancellation before the host closes storage", async () => {
    const mediaFake = new FakeMediaEngineAdapter({ progressPerPoll: 0.00001 });
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    await registerMediaRecipe(runtime, "shutdown-img", ["image"]);
    await assignRoute(runtime, "image", "shutdown-img");
    const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "shutdown render" } } });
    expect(submitted.statusCode, submitted.body).toBe(202);
    await waitFor(() => mediaFake.submitted.length === 1);

    await expect(runtime.app.close()).resolves.toBeUndefined();
    expect(mediaFake.cancelled).toEqual([{ instanceId: expect.any(String), jobId: "provider-1" }]);
  });

  it("replays job events as SSE and after a sequence", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const submitted = await runtime.app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { routeId: "image", modality: "image", params: { prompt: "stream me" } } });
      const jobId = submitted.json().data.id as string;
      await waitForJobStatus(runtime, jobId, "completed");

      const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/media/jobs/${jobId}/events?after=0` });
      expect(replay.statusCode).toBe(200);
      const events = replay.json().data as Array<{ sequence: number; event: { type: string } }>;
      expect(events.length).toBeGreaterThan(1);
      expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);

      const sse = await runtime.app.inject({ method: "GET", url: `/api/v1/media/jobs/${jobId}/events`, headers: { accept: "text/event-stream", "last-event-id": "0" } });
      expect(sse.statusCode).toBe(200);
      expect(sse.headers["content-type"]).toContain("text/event-stream");
      expect(sse.body).toContain("event: completed");
      expect(sse.body).toContain("id: 1\n");
    } finally {
      await runtime.app.close();
    }
  });

  it("keeps an assigned media route across a ninfer-mode reconcile", async () => {
    const store = SqliteStore.memory();
    store.upsertRecipe(mediaRecipe("h3-img", ["image"]));
    const routes = new RouteResolver(store.listRoutes(), store.listRecipes());
    ensureMediaRoutes(store, routes);
    store.upsertRoute({ id: "image", displayName: "Image generation", recipeId: "h3-img", enabled: true, kind: "image" });

    reconcileNInferConfiguration(store);

    const image = store.listRoutes().find((route) => route.id === "image");
    expect(image).toMatchObject({ recipeId: "h3-img", enabled: true, kind: "image" });
    // The other media slots still exist too.
    expect(store.listRoutes().filter((route) => route.id === "video" || route.id === "audio")).toHaveLength(2);
  });
});

async function registerMediaRecipe(runtime: HostRuntime, recipeId: string, modalities: MediaModality[]): Promise<void> {
  const response = await runtime.app.inject({
    method: "PUT",
    url: `/api/v1/management/recipes/${recipeId}`,
    payload: mediaRecipe(recipeId, modalities),
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function assignRoute(runtime: HostRuntime, routeId: string, recipeId: string): Promise<void> {
  const response = await runtime.app.inject({ method: "PUT", url: `/api/v1/management/routes/${routeId}`, payload: { displayName: routeId, recipeId, enabled: true } });
  expect(response.statusCode, response.body).toBe(200);
}

async function waitForJobStatus(runtime: HostRuntime, jobId: string, status: string, timeoutMs = 5_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await runtime.app.inject({ method: "GET", url: `/api/v1/media/jobs/${jobId}` });
    if (response.statusCode !== 200) throw new Error(`GET media job failed: ${response.body}`);
    const data = response.json().data;
    if (data.status === status) return data;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for media job ${jobId} to reach ${status}; last status: ${data.status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mediaRecipe(id: string, modalities: MediaModality[], costCentsPerJob?: number): Recipe {
  return {
    id,
    playbookId: "test",
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
      modalities: { input: ["text"], output: modalities },
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 60,
      minimumResidencySeconds: 0,
    },
    configuration: costCentsPerJob === undefined ? {} : { costCentsPerJob },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
