import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { ComfyUIEngineAdapter } from "@fitz/engine-comfyui";
import type { Recipe } from "@fitz/protocol";
import { createHost, type HostRuntime } from "./create-app.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";

const FIXTURE = fileURLToPath(new URL("../../../packages/engine-comfyui/src/fixtures/comfyui-server.mjs", import.meta.url));
/** Matches the fixture's canonical video output bytes. */
const FIXTURE_VIDEO_BYTES = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x66, 0x69, 0x74, 0x7a];

const children: Array<ChildProcessWithoutNullStreams> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

describe("MiniMax H3 via ComfyUI (PR 7)", () => {
  it("seeds the H3 playbook: video route assigned, experimental image recipe unassigned", async () => {
    const playbook = createComfyUIPlaybook({ engineDir: "/engines/comfyui", executable: "python", expectedVramMiB: 24_576 });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });

    const h3Video = playbook.recipes.find((recipe) => recipe.id === "h3-video");
    const h3Image = playbook.recipes.find((recipe) => recipe.id === "h3-image");
    expect(h3Video).toMatchObject({
      adapter: "comfyui",
      capabilities: { modalities: { output: ["video", "audio"], limits: { maxDurationSeconds: 15, maxResolution: "1280x720", maxRefs: 12 } } },
      configuration: { executable: "python", cwd: "/engines/comfyui", expectedVramMiB: 24_576 },
    });
    expect(h3Image).toMatchObject({ configuration: { experimental: true } });
    for (const recipe of playbook.recipes) {
      await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    }
    expect(playbook.routes).toContainEqual(expect.objectContaining({ id: "video", recipeId: "h3-video", kind: "video", enabled: true }));
    // The image route is not assigned by default (KD-2 — experimental recipe stays hidden).
    expect(playbook.routes).not.toContainEqual(expect.objectContaining({ id: "image" }));
  });

  it("runs a video generation end-to-end through the host pipeline", async () => {
    const fixturePort = await unusedPort();
    const child = spawn(process.execPath, [FIXTURE, "--listen", "127.0.0.1", "--port", String(fixturePort), "--progress-per-poll", "0.5"]);
    children.push(child);
    await waitForHttp(fixturePort);

    const comfyui = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000 });
    const runtime = createHost({ adapters: [new FakeEngineAdapter(), comfyui] });
    try {
      await registerRecipe(runtime, h3VideoRecipe(`http://127.0.0.1:${fixturePort}`));
      const assigned = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/routes/video",
        payload: { displayName: "Video generation", recipeId: "h3-video", enabled: true },
      });
      expect(assigned.statusCode, assigned.body).toBe(200);

      // Admin diagnostic probe (§5.10) exercises the real adapter: recipe → route
      // → scheduler → lifecycle (start/wait/submit/poll) → artifact.
      const test = await runtime.app.inject({ method: "POST", url: "/api/v1/management/recipes/h3-video/media-test" });
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json().data).toEqual(expect.objectContaining({ recipeId: "h3-video", modality: "video", status: "completed", working: true }));
      const artifactId = test.json().data.artifactId as string;
      expect(artifactId).toEqual(expect.any(String));

      const content = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${artifactId}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toBe("video/mp4");
      expect([...content.rawPayload]).toEqual(FIXTURE_VIDEO_BYTES);

      const job = runtime.store.getMediaJob(test.json().data.jobId as string);
      expect(job).toMatchObject({ modality: "video", routeId: "video", status: "completed", providerJobId: expect.any(String) });
    } finally {
      await runtime.app.close();
    }
  });
});

function h3VideoRecipe(baseUrl: string): Recipe {
  return {
    id: "h3-video",
    playbookId: "comfyui",
    displayName: "MiniMax H3 · Video & Audio (ComfyUI)",
    adapter: "comfyui",
    modelId: "h3",
    contextTokens: 1, // unused for media recipes; must be a positive integer for the recipe parser
    capabilities: {
      chatCompletions: false,
      streaming: false,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
      modalities: {
        input: ["text", "image", "video", "audio"],
        output: ["video", "audio"],
        limits: { maxDurationSeconds: 15, maxResolution: "1280x720", maxRefs: 12 },
      },
    },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
    configuration: {
      baseUrl,
      expectedVramMiB: 24_576,
      readinessTimeoutMs: 30_000,
      comfyuiWorkflow: {
        "1": {
          class_type: "HailuoVideoGenerate",
          inputs: { prompt: "{{prompt}}", seed: "{{seed}}", width: "{{width}}", height: "{{height}}" },
        },
        "2": { class_type: "SaveVideo", inputs: { filename_prefix: "fitz-h3" } },
      },
      outputFormats: ["mp4"],
      defaults: { resolution: "1280x720", fps: 30 },
    },
  };
}

async function registerRecipe(runtime: HostRuntime, recipe: Recipe): Promise<void> {
  const response = await runtime.app.inject({ method: "PUT", url: `/api/v1/management/recipes/${recipe.id}`, payload: recipe });
  expect(response.statusCode, response.body).toBe(200);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHttp(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/system_stats`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fixture server on port ${port} did not become ready`);
}
