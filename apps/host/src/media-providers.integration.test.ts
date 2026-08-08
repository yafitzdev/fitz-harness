import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { FakeMediaEngineAdapter, deterministicMediaBytes } from "@fitz/engine-media-fake";
import { SqliteStore } from "@fitz/storage";
import type { Recipe } from "@fitz/protocol";
import { createHost, type HostRuntime } from "./create-app.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/media/${name}`, import.meta.url));

/** PR 4 end-to-end for provider templates (§5.7): connection save runs media
 *  discovery and writes per-model recipes + per-modality consumer routes;
 *  generation flows through the same queue/lease pipeline as local engines with
 *  URL results downloaded host-side; re-saves revalidate well-known media route
 *  assignments; deletes clean up recipes/routes; and boot recovery cancels
 *  provider-side jobs orphaned by a crash (§5.3). */
describe("Fitz media provider templates", () => {
  it("saves an openai-media connection, discovers media models, and generates image + video", async () => {
    const fixture = await startFixture("fake-openai-media-server.mjs", ["--api-key", "test-openai-key"]);
    // Production server modes always supply explicit engine adapters. Provider
    // templates must be composed with (not replaced by) that local adapter set.
    const runtime = createHost({ adapters: [new FakeEngineAdapter()] });
    try {
      const put = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/connections/openai-mixed",
        payload: {
          displayName: "OpenAI Media",
          template: "openai-media",
          baseUrl: fixture.baseUrl,
          authType: "bearer",
          apiKey: "test-openai-key",
          costCentsPerJob: 5,
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      const saved = put.json().data;
      expect(saved).toMatchObject({ template: "openai-media", authType: "bearer", hasCredential: true });
      // Mixed connection: the chat model lands in `models`, generation models in `mediaModels`.
      expect(saved.models.map((model: { id: string }) => model.id)).toEqual(["gpt-4o-mini"]);
      expect(saved.mediaModels.map((model: { id: string; modality: string }) => `${model.id}:${model.modality}`)).toEqual([
        "dall-e-3:image",
        "sora-video:video",
        "tts-1:audio",
      ]);

      // Sync image through the consumer route: URL result downloaded host-side.
      const imageModel = saved.mediaModels.find((model: { modality: string }) => model.modality === "image");
      const imageResponse = await runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        payload: { model: imageModel.routeId, prompt: "an openai-media cat" },
      });
      expect(imageResponse.statusCode, imageResponse.body).toBe(200);
      const imageArtifactId = artifactIdFrom(imageResponse.json().data[0].url);
      const imageArtifact = runtime.store.getArtifact(imageArtifactId);
      expect(imageArtifact).toMatchObject({ kind: "image", mimeType: "image/png" });
      expect([...runtime.store.getArtifactContent(imageArtifactId)!]).toEqual([...deterministicMediaBytes("image")]);

      // Async video: 202 + job id, then the provider poll machine drives it to completed.
      const videoModel = saved.mediaModels.find((model: { modality: string }) => model.modality === "video");
      const videoResponse = await runtime.app.inject({
        method: "POST",
        url: "/v1/videos/generations",
        payload: { model: videoModel.routeId, prompt: "a sora boat" },
      });
      expect(videoResponse.statusCode, videoResponse.body).toBe(202);
      const videoJob = await waitForJobStatus(runtime, videoResponse.json().id, "completed", 10_000);
      expect(videoJob.providerJobId).toMatch(/^video-job-/);
      expect(videoJob.creditCostCents).toBe(5);
      const videoArtifact = runtime.store.getArtifact(videoJob.artifactId);
      expect(videoArtifact).toMatchObject({ kind: "video", mimeType: "video/mp4" });

      // Durable events carry the provider job id: started → completed.
      const persisted = runtime.store.mediaJobEventsAfter(videoJob.id, 0);
      expect(persisted[0]?.event.type).toBe("started");
      expect((persisted[0]?.event as { providerJobId: string }).providerJobId).toMatch(/^video-job-/);
      expect(persisted.at(-1)?.event.type).toBe("completed");

      // The fixture saw the generation submits and the artifact downloads.
      await waitFor(async () => {
        const requests = await fixture.requests();
        return requests.some((entry) => entry.method === "POST" && entry.url === "/v1/images/generations")
          && requests.some((entry) => entry.method === "POST" && entry.url === "/v1/videos/generations")
          && requests.some((entry) => entry.method === "GET" && entry.url === "/media/image")
          && requests.some((entry) => entry.method === "GET" && entry.url === "/media/video");
      });

      // Delete cleanup: connection gone, consumer recipes/routes removed.
      const del = await runtime.app.inject({ method: "DELETE", url: "/api/v1/management/connections/openai-mixed" });
      expect(del.statusCode).toBe(204);
      const list = await runtime.app.inject({ method: "GET", url: "/api/v1/management/connections" });
      expect(list.json().data).toHaveLength(0);
      const routes = await runtime.app.inject({ method: "GET", url: "/api/v1/management/routes" });
      const routeIds = routes.json().data.map((route: { id: string }) => route.id);
      for (const model of saved.mediaModels) expect(routeIds).not.toContain(model.routeId);
      expect(runtime.store.listRecipes().some((recipe) => recipe.id === imageModel.recipeId)).toBe(false);
    } finally {
      await runtime.app.close();
      await fixture.stop();
    }
  });

  it("re-saves a fal connection, de-assigning a stale well-known image route", async () => {
    const fixture = await startFixture("fake-fal-server.mjs");
    const runtime = createHost({});
    try {
      const put = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/connections/fal-conn",
        payload: {
          displayName: "Fal",
          template: "fal",
          baseUrl: fixture.baseUrl,
          authType: "none",
          modelIds: ["fal-ai/minimax-video", "fal-ai/flux/dev"],
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      const saved = put.json().data;
      expect(saved.template).toBe("fal");
      expect(saved.mediaModels.map((model: { id: string }) => model.id)).toEqual(["fal-ai/minimax-video", "fal-ai/flux/dev"]);
      const imageModel = saved.mediaModels.find((model: { modality: string }) => model.modality === "image");

      // Point the well-known "image" route at the fal image recipe and generate.
      const assign = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/routes/image",
        payload: { displayName: "Image", recipeId: imageModel.recipeId, enabled: true },
      });
      expect(assign.statusCode, assign.body).toBe(200);
      const imageResponse = await runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        payload: { model: "image", prompt: "a fal cat" },
      });
      expect(imageResponse.statusCode, imageResponse.body).toBe(200);
      const artifactId = artifactIdFrom(imageResponse.json().data[0].url);
      expect([...runtime.store.getArtifactContent(artifactId)!]).toEqual([...deterministicMediaBytes("image")]);

      // Re-save with only the video model: the image recipe disappears and the
      // well-known route is de-assigned (never left dangling, §5.7).
      const resave = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/connections/fal-conn",
        payload: {
          displayName: "Fal",
          template: "fal",
          baseUrl: fixture.baseUrl,
          authType: "none",
          modelIds: ["fal-ai/minimax-video"],
        },
      });
      expect(resave.statusCode, resave.body).toBe(200);
      expect(resave.json().data.mediaModels).toHaveLength(1);
      expect(resave.json().data.mediaModels[0]).toMatchObject({ id: "fal-ai/minimax-video", modality: "video" });

      const routes = await runtime.app.inject({ method: "GET", url: "/api/v1/management/routes" });
      const imageRoute = routes.json().data.find((route: { id: string }) => route.id === "image");
      expect(imageRoute).toMatchObject({ recipeId: "", enabled: false });
    } finally {
      await runtime.app.close();
      await fixture.stop();
    }
  });

  it("generates through a replicate connection via its consumer route", async () => {
    const fixture = await startFixture("fake-replicate-server.mjs");
    const runtime = createHost({});
    try {
      const put = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/connections/rep-conn",
        payload: {
          displayName: "Replicate",
          template: "replicate",
          baseUrl: fixture.baseUrl,
          authType: "none",
          modelIds: ["stability-ai/sdxl"],
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      const saved = put.json().data;
      expect(saved.template).toBe("replicate");
      expect(saved.mediaModels).toHaveLength(1);
      expect(saved.mediaModels[0]).toMatchObject({ id: "stability-ai/sdxl", modality: "image" });

      const response = await runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        payload: { model: saved.mediaModels[0].routeId, prompt: "a replicate cat" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const artifactId = artifactIdFrom(response.json().data[0].url);
      const artifact = runtime.store.getArtifact(artifactId);
      expect(artifact).toMatchObject({ kind: "image", mimeType: "image/png" });
      expect([...runtime.store.getArtifactContent(artifactId)!]).toEqual([...deterministicMediaBytes("image")]);
    } finally {
      await runtime.app.close();
      await fixture.stop();
    }
  });

  it("media-tests a recipe via the management diagnostic endpoint", async () => {
    const fixture = await startFixture("fake-openai-media-server.mjs", ["--api-key", "test-openai-key"]);
    const runtime = createHost({});
    try {
      const put = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/connections/openai-mixed",
        payload: {
          displayName: "OpenAI Media",
          template: "openai-media",
          baseUrl: fixture.baseUrl,
          authType: "bearer",
          apiKey: "test-openai-key",
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      const saved = put.json().data;
      const imageModel = saved.mediaModels.find((model: { modality: string }) => model.modality === "image");

      // Assign the well-known "image" route so the probe exercises the standard
      // single-assignment path (§5.2/§5.10).
      const assign = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/routes/image",
        payload: { displayName: "Image", recipeId: imageModel.recipeId, enabled: true },
      });
      expect(assign.statusCode, assign.body).toBe(200);

      const test = await runtime.app.inject({
        method: "POST",
        url: `/api/v1/management/recipes/${imageModel.recipeId}/media-test`,
      });
      expect(test.statusCode, test.body).toBe(200);
      const data = test.json().data;
      expect(data).toMatchObject({
        recipeId: imageModel.recipeId,
        modality: "image",
        status: "completed",
        working: true,
        unloaded: true,
      });
      expect(data.jobId).toBeTruthy();
      expect(data.artifactId).toBeTruthy();
      expect(data.artifactUrl).toMatch(/\/api\/v1\/artifacts\/.+\/content$/);
      const artifact = runtime.store.getArtifact(data.artifactId);
      expect(artifact).toMatchObject({ kind: "image", mimeType: "image/png" });
      expect([...runtime.store.getArtifactContent(data.artifactId)!]).toEqual([...deterministicMediaBytes("image")]);

      // A chat-only recipe is rejected: 400, not a probe.
      const chatModel = saved.models[0];
      const chatTest = await runtime.app.inject({
        method: "POST",
        url: `/api/v1/management/recipes/${chatModel.recipeId}/media-test`,
      });
      expect(chatTest.statusCode, chatTest.body).toBe(400);
      expect(chatTest.json().error).toContain("does not generate media");

      // A media recipe with no enabled route is rejected with a readable error.
      const raw = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/recipes/unassigned-media",
        payload: {
          playbookId: "test",
          displayName: "Unassigned",
          adapter: "openai-media",
          modelId: "dall-e-3",
          contextTokens: 131_072,
          capabilities: {
            chatCompletions: false,
            streaming: true,
            toolCalls: false,
            responseFormat: false,
            minP: false,
            maxConcurrentGenerations: 1,
            modalities: { input: ["text"], output: ["image"] },
          },
          lifecycle: { loadPolicy: "onDemand", evictionPolicy: "immediate", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
          configuration: { baseUrl: fixture.baseUrl, modelId: "dall-e-3", healthPath: "/health" },
        },
      });
      expect(raw.statusCode, raw.body).toBe(200);
      const unassigned = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/management/recipes/unassigned-media/media-test",
      });
      expect(unassigned.statusCode, unassigned.body).toBe(400);
      expect(unassigned.json().error).toContain("not assigned to an enabled media route");
    } finally {
      await runtime.app.close();
      await fixture.stop();
    }
  });

  it("cancels provider-side jobs orphaned by a crash on boot", async () => {
    const fixture = await startFixture("fake-fal-server.mjs");
    const store = SqliteStore.memory();
    const now = new Date().toISOString();
    // A pre-crash world: a fal video recipe, the well-known video route assigned
    // to it, and a media job that was mid-flight when the host died.
    const recipe: Recipe = {
      id: "fal-recipe",
      playbookId: "test",
      displayName: "Fal Video",
      adapter: "fal",
      modelId: "fal-ai/minimax-video",
      contextTokens: 131_072,
      capabilities: {
        chatCompletions: false,
        streaming: true,
        toolCalls: false,
        responseFormat: false,
        minP: false,
        maxConcurrentGenerations: 1,
        modalities: { input: ["text"], output: ["video"] },
      },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "immediate", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: { baseUrl: fixture.baseUrl, modelId: "fal-ai/minimax-video", healthPath: "/health" },
    };
    store.upsertRecipe(recipe);
    store.upsertRoute({ id: "video", displayName: "Video", recipeId: "fal-recipe", kind: "video", enabled: true });
    store.createMediaJob({
      id: "orphan-1",
      routeId: "video",
      modality: "video",
      status: "started",
      params: { prompt: "stale" },
      enqueuedAt: now,
      startedAt: now,
      providerJobId: "fal-req-77",
    });

    const runtime = createHost({ store });
    try {
      // Boot recovery marked the job interrupted; the fire-and-forget cancel
      // POSTs to the provider's cancel endpoint so billing stops (§5.3).
      await waitFor(async () =>
        (await fixture.requests()).some((entry) => entry.method === "POST" && entry.url === "/requests/fal-req-77/cancel"),
      );
      expect(store.getMediaJob("orphan-1")).toMatchObject({ status: "interrupted", providerJobId: "fal-req-77" });
    } finally {
      await runtime.app.close();
      await fixture.stop();
    }
  });
});

function artifactIdFrom(url: string): string {
  const match = /\/api\/v1\/artifacts\/([^/]+)\/content$/.exec(url);
  expect(match).toBeTruthy();
  return match![1]!;
}

interface FixtureHandle {
  baseUrl: string;
  requests: () => Promise<Array<{ method: string; url: string }>>;
  stop: () => Promise<void>;
}

async function startFixture(name: string, extraArgs: string[] = []): Promise<FixtureHandle> {
  const readyName = name.replace(/-server\.mjs$/, "");
  const ready = new RegExp(`${readyName} ready on ([^:]+):(\\d+)`);
  const child = spawn(process.execPath, [fixturePath(name), "--host", "127.0.0.1", "--port", "0", ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const fail = (reason: string): void => {
      child.kill("SIGTERM");
      reject(new Error(reason));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      const match = ready.exec(output);
      if (match) resolve(`http://${match[1]}:${match[2]}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.once("exit", (code) => fail(`${name} exited early (code ${code})`));
    const timer = setTimeout(() => fail(`${name} did not become ready`), 5_000);
    timer.unref();
  });
  return {
    baseUrl,
    requests: async () => {
      const response = await fetch(`${baseUrl}/__requests`);
      const payload = (await response.json()) as { requests: Array<{ method: string; url: string }> };
      return payload.requests;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

async function waitForJobStatus(runtime: HostRuntime, jobId: string, status: string, timeoutMs = 5_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await runtime.app.inject({ method: "GET", url: `/api/v1/media/jobs/${jobId}` });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data;
    if (data.status === status) return data;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for media job ${jobId} to reach ${status}; last status: ${data.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
