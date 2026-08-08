import { describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { FakeMediaEngineAdapter } from "@fitz/engine-media-fake";
import type { MediaModality, Recipe, Route, UserRecord, UserQuota } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { SecurityService } from "@fitz/security";
import { createHost, type HostRuntime } from "./create-app.js";
import { createMediaTools } from "./media-tools.js";

const NOW = new Date(0).toISOString();
const MEDIA_QUOTA: UserQuota = {
  maxRequestsPerMinute: 60,
  maxPromptChars: 100_000,
  maxOutputTokens: 32_768,
  maxQueueDepth: 20,
  media: { maxJobsPerWindow: 3, windowHours: 24, maxConcurrentJobs: 1 },
};

interface MediaToolsHarness {
  runtime: HostRuntime;
  store: SqliteStore;
  security: SecurityService;
  user: UserRecord;
}

async function makeHarness(): Promise<MediaToolsHarness> {
  const store = SqliteStore.memory();
  const security = new SecurityService(store, "test-pepper");
  const runtime = createHost({ store, authMode: "disabled", security, adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
  const user = security.createUser("Creator", "agent");
  await registerMediaRecipe(runtime, "h3-img", ["image"]);
  await registerMediaRecipe(runtime, "h3-vid", ["video"]);
  await assignRoute(runtime, "image", "h3-img");
  await assignRoute(runtime, "video", "h3-vid");
  return { runtime, store, security, user };
}

/** A session plus an owned run; the tools resolve owner + session from the runId. */
function createRun(store: SqliteStore, ownerUserId: string | undefined): void {
  store.createSession({ id: "session-1", title: "Task", status: "active", connectionId: "hosted--local", routeId: "default", createdAt: NOW, updatedAt: NOW });
  store.createAgentRun({ id: "run-1", routeId: "fast", sessionId: "session-1", status: "queued", createdAt: NOW, updatedAt: NOW, lastSequence: 0, ...(ownerUserId ? { ownerUserId } : {}) });
}

function mediaTools(harness: MediaToolsHarness) {
  const tools = createMediaTools({ mediaJobs: harness.runtime.mediaJobs, store: harness.store, security: harness.security })({ cwd: "C:/project", runId: "run-1" });
  return {
    generateImage: tools.find((tool) => tool.name === "generate_image")!,
    generateVideo: tools.find((tool) => tool.name === "generate_video")!,
    generateAudio: tools.find((tool) => tool.name === "generate_audio")!,
  };
}

describe("agent media tools (§5.9)", () => {
  it("submits a job in-process with the run owner's principal and returns non-blocking", async () => {
    const harness = await makeHarness();
    try {
      harness.security.setRouteGrants(harness.user.id, ["image"]);
      harness.security.setQuota(harness.user.id, MEDIA_QUOTA);
      createRun(harness.store, harness.user.id);
      const result = await mediaTools(harness).generateImage.execute("call-1", { prompt: "a red cube", size: "1024x1024" });
      // Non-blocking by construction (KD-12): the result is the job handle, not the media.
      expect(result.details).toMatchObject({ status: "queued" });
      expect(JSON.stringify(result.content)).toContain("asynchronously");
      const job = harness.store.getMediaJob((result.details as { mediaJobId: string }).mediaJobId);
      expect(job).toMatchObject({ routeId: "image", modality: "image", createdByUserId: harness.user.id, sessionId: "session-1", params: { prompt: "a red cube", size: "1024x1024" } });
    } finally {
      await harness.runtime.app.close();
    }
  });

  it("maps the video tool's resolution field to the protocol size parameter", async () => {
    const harness = await makeHarness();
    try {
      harness.security.setRouteGrants(harness.user.id, ["video"]);
      harness.security.setQuota(harness.user.id, MEDIA_QUOTA);
      createRun(harness.store, harness.user.id);
      const result = await mediaTools(harness).generateVideo.execute("call-video", {
        prompt: "a camera circles a red cube",
        resolution: "1344x768",
        duration_seconds: 2,
        fps: 24,
      });
      const job = harness.store.getMediaJob((result.details as { mediaJobId: string }).mediaJobId);
      expect(job?.params).toMatchObject({ prompt: "a camera circles a red cube", size: "1344x768", durationSeconds: 2, fps: 24 });
      expect(job?.params).not.toHaveProperty("resolution");
    } finally {
      await harness.runtime.app.close();
    }
  });

  it("fails closed when the run owner has no media quota, even with a route grant", async () => {
    const harness = await makeHarness();
    try {
      harness.security.setRouteGrants(harness.user.id, ["image"]); // granted, but quota.media is unset
      createRun(harness.store, harness.user.id);
      const result = await mediaTools(harness).generateImage.execute("call-1", { prompt: "a cat" });
      expect(JSON.stringify(result.content)).toContain("Media quota is not configured");
    } finally {
      await harness.runtime.app.close();
    }
  });

  it("enforces route grants: the well-known route needs a grant, route_id can pick a granted route", async () => {
    const harness = await makeHarness();
    try {
      await registerMediaRecipe(harness.runtime, "custom-img", ["image"]);
      await assignRoute(harness.runtime, "custom-img-route", "custom-img", "image");
      harness.security.setRouteGrants(harness.user.id, ["custom-img-route"]); // not the well-known image route
      harness.security.setQuota(harness.user.id, MEDIA_QUOTA);
      createRun(harness.store, harness.user.id);
      const generateImage = mediaTools(harness).generateImage;
      const denied = await generateImage.execute("call-1", { prompt: "a cat" });
      expect(JSON.stringify(denied.content)).toContain("Route access denied");
      const accepted = await generateImage.execute("call-2", { prompt: "a cat", route_id: "custom-img-route" });
      expect(harness.store.getMediaJob((accepted.details as { mediaJobId: string }).mediaJobId)).toMatchObject({ routeId: "custom-img-route" });
    } finally {
      await harness.runtime.app.close();
    }
  });

  it("surfaces an unknown or unassigned route as a readable error", async () => {
    const harness = await makeHarness();
    try {
      harness.security.setRouteGrants(harness.user.id, ["image"]);
      harness.security.setQuota(harness.user.id, MEDIA_QUOTA);
      createRun(harness.store, harness.user.id);
      const tools = mediaTools(harness);
      const missing = await tools.generateImage.execute("call-1", { prompt: "a cat", route_id: "nonexistent" });
      expect(JSON.stringify(missing.content)).toContain("Unknown or disabled route: nonexistent");
      // The audio route exists but is disabled/unassigned by default (§5.2): registered
      // now, errors until an admin assigns a recipe (§5.9).
      const audio = await tools.generateAudio.execute("call-2", { prompt: "a scale" });
      expect(JSON.stringify(audio.content)).toContain("Unknown or disabled route: audio");
    } finally {
      await harness.runtime.app.close();
    }
  });

  it("submits without a principal for ownerless runs (admin-diagnostic path)", async () => {
    const harness = await makeHarness();
    try {
      createRun(harness.store, undefined);
      const result = await mediaTools(harness).generateImage.execute("call-1", { prompt: "a cat" });
      expect(result.details).toMatchObject({ status: "queued" });
      expect(harness.store.getMediaJob((result.details as { mediaJobId: string }).mediaJobId)?.createdByUserId).toBeUndefined();
    } finally {
      await harness.runtime.app.close();
    }
  });

  it("registers and submits media tools in explicit local auth-disabled mode", async () => {
    const harness = await makeHarness();
    try {
      createRun(harness.store, undefined);
      const tools = createMediaTools({ mediaJobs: harness.runtime.mediaJobs, store: harness.store })({ cwd: "C:/project", runId: "run-1" });
      const result = await tools.find((tool) => tool.name === "generate_video")!.execute("call-local-video", { prompt: "a red cube rotates" });
      expect(result.details).toMatchObject({ status: "queued" });
      const job = harness.store.getMediaJob((result.details as { mediaJobId: string }).mediaJobId);
      expect(job).toMatchObject({ modality: "video" });
      expect(job?.createdByUserId).toBeUndefined();
    } finally {
      await harness.runtime.app.close();
    }
  });
});

async function registerMediaRecipe(runtime: HostRuntime, recipeId: string, modalities: MediaModality[]): Promise<void> {
  const response = await runtime.app.inject({ method: "PUT", url: `/api/v1/management/recipes/${recipeId}`, payload: mediaRecipe(recipeId, modalities) });
  expect(response.statusCode, response.body).toBe(200);
}

async function assignRoute(runtime: HostRuntime, routeId: string, recipeId: string, kind?: Route["kind"]): Promise<void> {
  const response = await runtime.app.inject({ method: "PUT", url: `/api/v1/management/routes/${routeId}`, payload: { displayName: routeId, recipeId, enabled: true, ...(kind ? { kind } : {}) } });
  expect(response.statusCode, response.body).toBe(200);
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
