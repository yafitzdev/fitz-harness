import { describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { FakeMediaEngineAdapter, deterministicMediaBytes } from "@fitz/engine-media-fake";
import type { MediaModality, Recipe } from "@fitz/protocol";
import { DEFAULT_QUOTAS, SecurityService } from "@fitz/security";
import { SqliteStore } from "@fitz/storage";
import { createHost, type HostRuntime } from "./create-app.js";

describe("Fitz OpenAI-shaped media gateway", () => {
  it("serves a completed image synchronously as base64", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const response = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image", prompt: "a cat", response_format: "b64_json" } });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.created).toEqual(expect.any(Number));
      expect([...Buffer.from(body.data[0].b64_json, "base64")]).toEqual([...deterministicMediaBytes("image")]);

      // The synchronous gateway still ran a durable media job to completion.
      const latest = runtime.store.listMediaJobs({ limit: 1 })[0];
      expect(latest).toEqual(expect.objectContaining({ routeId: "image", modality: "image", status: "completed" }));
      expect(latest?.artifactId).toEqual(expect.any(String));
    } finally {
      await runtime.app.close();
    }
  });

  it("serves a completed image synchronously as a Fitz artifact URL", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const response = await runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        headers: { host: "127.0.0.1:4567" },
        payload: { model: "image", prompt: "a dog" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const url = response.json().data[0].url as string;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:4567\/api\/v1\/artifacts\/[^/]+\/content$/);

      // Provider URLs are never handed out: the URL is a Fitz artifact content URL.
      const content = await runtime.app.inject({ method: "GET", url: new URL(url).pathname });
      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toBe("image/png");
      expect([...content.rawPayload]).toEqual([...deterministicMediaBytes("image")]);
    } finally {
      await runtime.app.close();
    }
  });

  it("rejects malformed or unroutable image requests", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await registerMediaRecipe(runtime, "h3-video", ["video"]);
      await assignRoute(runtime, "video", "h3-video");

      const missingPrompt = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image" } });
      expect(missingPrompt.statusCode).toBe(400);

      const tooMany = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image", prompt: "a cat", n: 2 } });
      expect(tooMany.statusCode).toBe(400);
      expect(String(tooMany.json().error.message)).toContain("n must be 1");

      // The image route exists but is unassigned → inert.
      const unassigned = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image", prompt: "a cat" } });
      expect(unassigned.statusCode).toBe(404);

      // The video route cannot generate images.
      const wrongKind = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "video", prompt: "a cat" } });
      expect(wrongKind.statusCode).toBe(400);
      expect(String(wrongKind.json().error.message)).toContain("cannot generate image");
    } finally {
      await runtime.app.close();
    }
  });

  it("returns 504 with the job id when an image exceeds the bounded await", async () => {
    const mediaFake = new FakeMediaEngineAdapter({ progressPerPoll: 0.005 });
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake], mediaImageTimeoutMs: 40 });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const response = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image", prompt: "slow render" } });
      expect(response.statusCode, response.body).toBe(504);
      const error = response.json().error;
      expect(error).toEqual(expect.objectContaining({ type: "media_generation_timeout", code: "media_generation_timeout", param: expect.any(String) }));

      // The job keeps running under the native API: the 504 param is the mediaJobId.
      const jobId = error.param as string;
      const native = await runtime.app.inject({ method: "GET", url: `/api/v1/media/jobs/${jobId}` });
      expect(native.statusCode).toBe(200);
      await runtime.app.inject({ method: "POST", url: `/api/v1/media/jobs/${jobId}/cancel` });
      await waitForJobStatus(runtime, jobId, "cancelled");
    } finally {
      await runtime.app.close();
    }
  });

  it("returns 502 when an image job fails", async () => {
    const mediaFake = new FakeMediaEngineAdapter({ failWhenPromptIncludes: "explode" });
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const response = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image", prompt: "please explode now" } });
      expect(response.statusCode, response.body).toBe(502);
      const error = response.json().error;
      expect(error).toEqual(expect.objectContaining({ type: "media_generation_failed", param: expect.any(String) }));
      expect(String(error.message)).toContain("Fake media engine configured request failure");
    } finally {
      await runtime.app.close();
    }
  });

  it("starts video generation as a job and reports progress through the native API", async () => {
    const mediaFake = new FakeMediaEngineAdapter();
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), mediaFake] });
    try {
      await registerMediaRecipe(runtime, "h3-video", ["video"]);
      await assignRoute(runtime, "video", "h3-video");

      const response = await runtime.app.inject({ method: "POST", url: "/v1/videos/generations", payload: { model: "video", prompt: "a dog running", duration: 5, resolution: "1280x720" } });
      expect(response.statusCode, response.body).toBe(202);
      const body = response.json();
      expect(body).toEqual(expect.objectContaining({ object: "video.generation", status: "queued", id: expect.any(String) }));
      expect(body.createdAt).toEqual(expect.any(String));

      // The request reached the engine with the gateway params mapped through
      // (the 202 returns before the async pump submits to the engine).
      await waitFor(() => mediaFake.submitted.length === 1);
      expect(mediaFake.submitted[0]?.params).toEqual(expect.objectContaining({ prompt: "a dog running", durationSeconds: 5, size: "1280x720" }));

      // The gateway id IS the mediaJobId: resume through the native API.
      const job = await waitForJobStatus(runtime, body.id, "completed");
      expect(job.artifactId).toEqual(expect.any(String));
      const content = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${job.artifactId}/content` });
      expect(content.headers["content-type"]).toBe("video/mp4");
      expect([...content.rawPayload]).toEqual([...deterministicMediaBytes("video")]);
    } finally {
      await runtime.app.close();
    }
  });

  it("rejects a video request whose route does not generate video", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const response = await runtime.app.inject({ method: "POST", url: "/v1/videos/generations", payload: { model: "image", prompt: "a cat" } });
      expect(response.statusCode, response.body).toBe(400);
      expect(String(response.json().error.message)).toContain("cannot generate video");
    } finally {
      await runtime.app.close();
    }
  });

  it("reserves audio generation with 501", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      const response = await runtime.app.inject({ method: "POST", url: "/v1/audio/generations", payload: { model: "audio", prompt: "a song" } });
      expect(response.statusCode).toBe(501);
      expect(response.json().error.type).toBe("not_implemented");
    } finally {
      await runtime.app.close();
    }
  });

  it("enforces device auth, route grants, and media quota on the gateway", async () => {
    const store = SqliteStore.memory();
    const security = new SecurityService(store, "pepper");
    const admin = security.createUser("Admin", "administrator");
    const { token: adminToken } = security.issueDevice(admin.id, "Admin Browser");
    security.setQuota(admin.id, { ...DEFAULT_QUOTAS.administrator, media: { maxJobsPerWindow: 20, windowHours: 24, maxConcurrentJobs: 1 } });
    const consumer = security.createUser("Consumer");
    security.setRouteGrants(consumer.id, ["image"]); // granted the route, but has no media quota (fail closed)
    const { token: consumerToken } = security.issueDevice(consumer.id, "Browser");

    const runtime = createHost({ store, security, authMode: "required", adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      const adminHeaders = { authorization: `Bearer ${adminToken}` };
      await registerMediaRecipeAs(runtime, adminHeaders, "h3-img", ["image"]);
      await assignRouteAs(runtime, adminHeaders, "image", "h3-img");

      const anonymous = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "image", prompt: "a cat" } });
      expect(anonymous.statusCode).toBe(401);

      const noQuota = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", headers: { authorization: `Bearer ${consumerToken}` }, payload: { model: "image", prompt: "a cat" } });
      expect(noQuota.statusCode).toBe(429);
      expect(String(noQuota.json().error.message)).toContain("Media quota is not configured");

      const granted = await runtime.app.inject({ method: "POST", url: "/v1/images/generations", headers: adminHeaders, payload: { model: "image", prompt: "a cat" } });
      expect(granted.statusCode, granted.body).toBe(200);
      expect(granted.json().data[0].url).toContain("/api/v1/artifacts/");
    } finally {
      await runtime.app.close();
    }
  });
});

async function registerMediaRecipe(runtime: HostRuntime, recipeId: string, modalities: MediaModality[]): Promise<void> {
  await registerMediaRecipeAs(runtime, {}, recipeId, modalities);
}

async function registerMediaRecipeAs(runtime: HostRuntime, headers: Record<string, string>, recipeId: string, modalities: MediaModality[]): Promise<void> {
  const response = await runtime.app.inject({ method: "PUT", url: `/api/v1/management/recipes/${recipeId}`, headers, payload: mediaRecipe(recipeId, modalities) });
  expect(response.statusCode, response.body).toBe(200);
}

async function assignRoute(runtime: HostRuntime, routeId: string, recipeId: string): Promise<void> {
  await assignRouteAs(runtime, {}, routeId, recipeId);
}

async function assignRouteAs(runtime: HostRuntime, headers: Record<string, string>, routeId: string, recipeId: string): Promise<void> {
  const response = await runtime.app.inject({ method: "PUT", url: `/api/v1/management/routes/${routeId}`, headers, payload: { displayName: routeId, recipeId, enabled: true } });
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mediaRecipe(id: string, modalities: MediaModality[]): Recipe {
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
    configuration: {},
  };
}
