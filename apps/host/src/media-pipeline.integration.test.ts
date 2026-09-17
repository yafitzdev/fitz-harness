import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/inference-core/testing";
import { FakeMediaEngineAdapter, deterministicMediaBytes } from "./testing/fake-media-adapter.js";
import type { InferenceLifecycleEvent, MediaModality, Recipe } from "@fitz/protocol";
import { createHost, type HostRuntime } from "./create-app.js";

const mediaFixturePath = fileURLToPath(
  new URL("./testing/fixtures/media/fake-media-server.mjs", import.meta.url),
);

/** PR 3 end-to-end: POST /v1/images/generations proves the whole media
 *  pipeline — route → queue → lease → submit/poll → artifact → durable events —
 *  on the GPU-free fake media test double, plus the host-side download of
 *  provider-style URL results from the owned media fixture server (§5.11). */
describe("Fitz media generation pipeline", () => {
  it("runs an image generation through queue, lease, and artifact store", async () => {
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter()] });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const seen: InferenceLifecycleEvent[] = [];
      const unsubscribe = runtime.events.subscribe((event) => seen.push(event));

      const response = await runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        payload: { model: "image", prompt: "a pipeline cat" },
      });
      expect(response.statusCode, response.body).toBe(200);
      unsubscribe();

      const job = runtime.store.listMediaJobs({ limit: 1 })[0];
      expect(job).toBeDefined();
      expect(job).toMatchObject({ routeId: "image", modality: "image", status: "completed" });

      // Queue events carried the media discriminator for this job (§5.5).
      const queueEvents = seen.filter(
        (event) => event.type === "queue.updated" && event.data.requestId === job!.id,
      );
      expect(queueEvents.length).toBeGreaterThanOrEqual(3);
      expect(queueEvents[0]?.data.status).toBe("queued");
      expect(queueEvents.some((event) => event.data.status === "started")).toBe(true);
      expect(queueEvents.at(-1)?.data.status).toBe("completed");
      expect(queueEvents.every((event) => event.data.kind === "media")).toBe(true);
      expect(queueEvents.every((event) => event.data.lane === "cloud")).toBe(true);

      // Remote providers use the independent cloud lane and never occupy the
      // local GPU lifecycle.
      expect(seen.some((event) => event.type === "instance.state.changed")).toBe(false);

      // The artifact is the fake engine's canonical PNG, classified as an image.
      const artifact = runtime.store.getArtifact(job!.artifactId!);
      expect(artifact).toBeDefined();
      expect(artifact).toMatchObject({ kind: "image", mimeType: "image/png" });
      expect([...(await runtime.artifacts.read(artifact!.id))!]).toEqual([
        ...deterministicMediaBytes("image"),
      ]);

      // Durable media_job_events persisted in ascending sequence (§5.3).
      const persisted = runtime.store.mediaJobEventsAfter(job!.id, 0);
      expect(persisted.at(-1)?.event.type).toBe("completed");
      const sequences = persisted.map((event) => event.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    } finally {
      await runtime.app.close();
    }
  });

  it("downloads provider-style URL results from the fixture server into artifacts", async () => {
    const fixture = await startMediaFixture();
    const runtime = createHost({
      adapters: [new FakeEngineAdapter(), new FakeMediaEngineAdapter({ resultUrl: `${fixture.baseUrl}/media` })],
    });
    try {
      await registerMediaRecipe(runtime, "h3-img", ["image"]);
      await assignRoute(runtime, "image", "h3-img");

      const response = await runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        payload: { model: "image", prompt: "fetched over http" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const url = response.json().data[0].url as string;
      const artifactId = /\/api\/v1\/artifacts\/([^/]+)\/content$/.exec(url)?.[1];
      expect(artifactId).toBeTruthy();

      // Provider URLs are never handed out: the gateway URL is a Fitz artifact,
      // and the artifact content came from the host-side fetch of the result.
      const artifact = runtime.store.getArtifact(artifactId!);
      expect(artifact).toMatchObject({ kind: "image", mimeType: "image/png" });
      expect([...(await runtime.artifacts.read(artifactId!))!]).toEqual([
        ...deterministicMediaBytes("image"),
      ]);

      // The provider endpoint serves the canonical bytes — the artifact proves
      // the host downloaded the result rather than receiving it inline.
      const served = await fetch(`${fixture.baseUrl}/media/image`);
      expect(served.status).toBe(200);
      expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([
        ...deterministicMediaBytes("image"),
      ]);
    } finally {
      await runtime.app.close();
      await fixture.stop();
    }
  });
});

async function startMediaFixture(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [mediaFixturePath, "--host", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      const match = /fake-media ready on ([^:]+):(\d+)/.exec(output);
      if (match) resolve(`http://${match[1]}:${match[2]}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.once("exit", (code) => reject(new Error(`media fixture exited early (code ${code})`)));
    const timer = setTimeout(() => reject(new Error("media fixture did not become ready")), 5_000);
    timer.unref();
  });
  return {
    baseUrl,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

async function registerMediaRecipe(runtime: HostRuntime, recipeId: string, modalities: MediaModality[]): Promise<void> {
  const response = await runtime.app.inject({
    method: "PUT",
    url: `/api/v1/management/recipes/${recipeId}`,
    payload: mediaRecipe(recipeId, modalities),
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function assignRoute(runtime: HostRuntime, routeId: string, recipeId: string): Promise<void> {
  const response = await runtime.app.inject({
    method: "PUT",
    url: `/api/v1/management/routes/${routeId}`,
    payload: { displayName: routeId, recipeId, enabled: true },
  });
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
