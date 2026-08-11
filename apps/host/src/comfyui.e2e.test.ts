import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { ComfyUIEngineAdapter, substituteWorkflow } from "@fitz/engine-comfyui";
import { createHost, type HostRuntime } from "./create-app.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";
import { testThermalGuard } from "./test-thermal.js";

const FIXTURE = fileURLToPath(new URL("../../../packages/engine-comfyui/src/fixtures/comfyui-server.mjs", import.meta.url));
/** Matches the fixture's canonical video output bytes. */
const FIXTURE_VIDEO_BYTES = [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x66, 0x69, 0x74, 0x7a];

const children: Array<ChildProcessWithoutNullStreams> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

describe("MiniMax H3 via ComfyUI (PR 7)", () => {
  it("seeds the official H3 video route without inventing an image recipe", async () => {
    const playbook = createComfyUIPlaybook({ engineDir: "/engines/comfyui", executable: "python", expectedVramMiB: 24_576 });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });

    const h3Video = playbook.recipes.find((recipe) => recipe.id === "h3-video");
    expect(h3Video).toMatchObject({
      adapter: "comfyui",
      capabilities: { modalities: { input: ["text"], output: ["video", "audio"], limits: { maxDurationSeconds: 6, maxFps: 30, maxResolution: "1280x720" } } },
      configuration: { executable: "python", cwd: "/engines/comfyui", expectedVramMiB: 24_576 },
    });
    expect(playbook.recipes.map((recipe) => recipe.id)).toEqual(["h3-video"]);
    for (const recipe of playbook.recipes) {
      await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    }
    expect(playbook.routes).toContainEqual(expect.objectContaining({ id: "video", recipeId: "h3-video", kind: "video", enabled: true }));
    // H3 is a video model; no fake text-to-image route is exposed.
    expect(playbook.routes).not.toContainEqual(expect.objectContaining({ id: "image" }));
  });

  it("onboards independently installed PinkCherry H3 and Krea 2 recipes", async () => {
    const playbook = createComfyUIPlaybook({
      engineDir: "/engines/comfyui",
      executable: "python",
      recipeIds: ["h3-video", "pinkcherry-h3-video", "krea2-turbo-image"],
    });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });

    expect(playbook.recipes.map((recipe) => recipe.id)).toEqual([
      "h3-video",
      "pinkcherry-h3-video",
      "krea2-turbo-image",
    ]);
    expect(playbook.recipes.find((recipe) => recipe.id === "pinkcherry-h3-video")).toMatchObject({
      modelId: "pinkcherry-minimax-h3-v0.5-pruned-int8",
      lifecycle: { evictionPolicy: "immediate", idleTtlSeconds: 0 },
      capabilities: { modalities: { output: ["video", "audio"] } },
    });
    expect(playbook.recipes.find((recipe) => recipe.id === "krea2-turbo-image")).toMatchObject({
      modelId: "krea2-turbo-nvfp4",
      lifecycle: { evictionPolicy: "immediate", idleTtlSeconds: 0 },
      capabilities: { modalities: { output: ["image"] } },
      configuration: { defaults: { resolution: "1024x1024", sampler: "euler", steps: 8, guidance: 1 } },
    });
    for (const recipe of playbook.recipes) {
      await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    }
    expect(playbook.routes).toContainEqual(expect.objectContaining({ id: "video", recipeId: "h3-video" }));
    expect(playbook.routes).toContainEqual(expect.objectContaining({ id: "image", recipeId: "krea2-turbo-image" }));
  });

  it("computes the H3 frame count from the requested fps, not a hardcoded 24", () => {
    const playbook = createComfyUIPlaybook({ engineDir: "/engines/comfyui", executable: "python" });
    const h3Video = playbook.recipes.find((recipe) => recipe.id === "h3-video")!;
    const workflow = h3Video.configuration.comfyuiWorkflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

    // H3 `length` is a frame count. At the recipe default (24 fps) the formula
    // matches the old hardcoded expression; at 30 fps the duration→frames
    // conversion must follow the requested fps or playback runs short.
    // (substituteWorkflow receives params after applyGenerationDefaults, so the
    // default fps must be passed explicitly here, as the adapter does.)
    const defaults = substituteWorkflow(workflow, { prompt: "x", fps: 24 });
    const atDefault = (defaults["107"].inputs.expression as string);
    expect(atDefault).toContain("round(a * 24)");

    const at30 = substituteWorkflow(workflow, { prompt: "x", durationSeconds: 10, fps: 30 });
    const expression = at30["107"].inputs.expression as string;
    expect(expression).toBe("max(5, round(a * 30)) + (5 - (max(5, round(a * 30)) % 17)) % 17");
    // 10 s at 30 fps → ~300 frames, which is what feeds MiniMaxH3ImageToVideo.length.
    expect(at30["104"].inputs.length).toEqual(["107", 1]);
    // CreateVideo carries the requested container fps.
    expect(at30["91"].inputs.fps).toBe(30);
  });

  it("routes PinkCherry when it is the only installed video recipe", () => {
    const playbook = createComfyUIPlaybook({
      engineDir: "/engines/comfyui",
      executable: "python",
      recipeIds: ["pinkcherry-h3-video"],
    });
    expect(playbook.recipes.map((recipe) => recipe.id)).toEqual(["pinkcherry-h3-video"]);
    expect(playbook.routes).toEqual([expect.objectContaining({ id: "video", recipeId: "pinkcherry-h3-video" })]);
  });

  it("runs a video generation end-to-end through the host pipeline", async () => {
    const fixturePort = await unusedPort();
    const child = spawn(process.execPath, [FIXTURE, "--listen", "127.0.0.1", "--port", String(fixturePort), "--progress-per-poll", "0.5"]);
    children.push(child);
    await waitForHttp(fixturePort);

    const comfyui = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000 });
    const runtime = createHost({
      adapters: [new FakeEngineAdapter(), comfyui],
      // This is a fixture-server integration test, so its result must not
      // depend on how much VRAM an unrelated process is using on the host.
      resourceMonitor: {
        snapshot: async () => ({
          capturedAt: new Date(0).toISOString(),
          totalRamMiB: 64_000,
          freeRamMiB: 48_000,
          totalVramMiB: 32_000,
          usedVramMiB: 0,
          freeVramMiB: 32_000,
          gpuTelemetryAvailable: true,
        }),
      },
      thermalGuard: testThermalGuard(),
    });
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

function h3VideoRecipe(baseUrl: string) {
  return createComfyUIPlaybook({ engineDir: ".", baseUrl }).recipes[0]!;
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
