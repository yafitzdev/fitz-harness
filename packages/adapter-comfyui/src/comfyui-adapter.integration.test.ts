import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MediaGenerationRequest, MediaJobPoll, Recipe } from "@fitz/protocol";
import { ComfyUIEngineAdapter, type ComfyUIHandle } from "./comfyui-adapter.js";

const running: Array<{ process: ChildProcessWithoutNullStreams }> = [];

afterEach(() => {
  for (const instance of running.splice(0)) instance.process.kill("SIGKILL");
});

const FIXTURE = fileURLToPath(new URL("./fixtures/comfyui-server.mjs", import.meta.url));

const VIDEO_WORKFLOW = {
  "1": { class_type: "HailuoVideoGenerate", inputs: { prompt: "{{prompt}}", seed: "{{seed}}", width: "{{width}}", height: "{{height}}" } },
  "2": { class_type: "SaveVideo", inputs: { filename_prefix: "h3" } },
};

describe("ComfyUIEngineAdapter integration", () => {
  it("launches a managed ComfyUI, generates a video, and stops it", async () => {
    const port = await unusedPort();
    // A real ComfyUI checkout runs `python main.py`; the fixture stands in for
    // main.py inside its fixtures folder, launched through the managed path.
    const engineDir = fileURLToPath(new URL("./fixtures", import.meta.url));
    const recipe = recipeFor({ executable: process.execPath, cwd: engineDir, entrypoint: "comfyui-server.mjs", comfyuiWorkflow: VIDEO_WORKFLOW });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: true, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000, stopTimeoutMs: 1_000 });

    expect(await adapter.validateRecipe(recipe)).toEqual({ valid: true, issues: [] });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    running.push({ process: instance.process! });
    await expect(adapter.waitUntilReady(instance, new AbortController().signal)).resolves.toMatchObject({ modelId: "h3" });

    const job = await adapter.submit(instance, request("video", { prompt: "a red cube rotating", seed: 42, size: "1280x720", fps: 30 }), new AbortController().signal);
    expect(job).toMatchObject({ modality: "video" });
    expect(job.id).toBeTruthy();

    const poll = await pollUntil(adapter, instance, job);
    expect(poll.status).toBe("completed");
    expect(poll.result).toMatchObject({ mimeType: "video/mp4", byteSize: 16 });
    expect(poll.result?.data).toBeInstanceOf(Uint8Array);

    await expect(adapter.stop(instance, "graceful")).resolves.toEqual({ stopped: true });
    running.pop();
  });

  it("connects to an external ComfyUI endpoint without spawning a process", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, [FIXTURE, "--listen", "127.0.0.1", "--port", String(port), "--progress-per-poll", "0.5"]);
    running.push({ process: child });
    await waitForHttp(port);

    const recipe = recipeFor({ baseUrl: `http://127.0.0.1:${port}`, comfyuiWorkflow: VIDEO_WORKFLOW });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000 });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    expect(instance.process).toBeUndefined();
    await expect(adapter.waitUntilReady(instance, new AbortController().signal)).resolves.toMatchObject({ modelId: "h3" });

    const job = await adapter.submit(instance, request("video", { prompt: "a red cube rotating" }), new AbortController().signal);
    const poll = await pollUntil(adapter, instance, job);
    expect(poll.status).toBe("completed");
    expect(poll.result?.mimeType).toBe("video/mp4");

    await expect(adapter.stop(instance, "graceful")).resolves.toMatchObject({ stopped: true, detail: "External endpoint left running" });
    await expect(adapter.inspect(instance)).resolves.toMatchObject({ healthy: true, modelId: "h3" });
    running.pop();
    child.kill("SIGKILL");
  });

  it("reports failed workflows as failed jobs", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, [FIXTURE, "--listen", "127.0.0.1", "--port", String(port), "--fail-on", "boom"]);
    running.push({ process: child });
    await waitForHttp(port);

    const recipe = recipeFor({ baseUrl: `http://127.0.0.1:${port}`, comfyuiWorkflow: VIDEO_WORKFLOW });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000 });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await adapter.waitUntilReady(instance, new AbortController().signal);

    const job = await adapter.submit(instance, request("video", { prompt: "boom now" }), new AbortController().signal);
    const poll = await pollUntil(adapter, instance, job);
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe("ComfyUI workflow execution failed");
    running.pop();
    child.kill("SIGKILL");
  });

  it("cancels a queued/running prompt best-effort", async () => {
    const port = await unusedPort();
    const child = spawn(process.execPath, [FIXTURE, "--listen", "127.0.0.1", "--port", String(port)]);
    running.push({ process: child });
    await waitForHttp(port);

    const recipe = recipeFor({ baseUrl: `http://127.0.0.1:${port}`, comfyuiWorkflow: VIDEO_WORKFLOW });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000 });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await adapter.waitUntilReady(instance, new AbortController().signal);

    const job = await adapter.submit(instance, request("video", { prompt: "a red cube rotating" }), new AbortController().signal);
    await expect(adapter.cancel(instance, job)).resolves.toBeUndefined();
    running.pop();
    child.kill("SIGKILL");
  });

  it("streams live progress over WebSocket when the server has no /progress endpoint", async () => {
    const port = await unusedPort();
    // Modern ComfyUI builds have no HTTP /progress route — progress is pushed
    // over /ws only. --no-progress-endpoint makes the fixture behave like the
    // real checkout, so progress must arrive through the WebSocket listener.
    const child = spawn(process.execPath, [
      FIXTURE, "--listen", "127.0.0.1", "--port", String(port),
      "--no-progress-endpoint", "--progress-per-poll", "0.2", "--ws-tick-ms", "10",
    ]);
    running.push({ process: child });
    await waitForHttp(port);

    const recipe = recipeFor({ baseUrl: `http://127.0.0.1:${port}`, comfyuiWorkflow: VIDEO_WORKFLOW });
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 5, readinessTimeoutMs: 5_000 });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await adapter.waitUntilReady(instance, new AbortController().signal);

    const job = await adapter.submit(instance, request("video", { prompt: "a red cube rotating" }), new AbortController().signal);
    let sawProgress = false;
    let terminal: MediaJobPoll | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const poll = await adapter.poll(instance, job, new AbortController().signal);
      if (poll.status === "progressing" && (poll.progress ?? 0) > 0) sawProgress = true;
      if (poll.status === "completed" || poll.status === "failed") {
        terminal = poll;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sawProgress).toBe(true);
    expect(terminal?.status).toBe("completed");
    expect(terminal?.progress).toBe(1);
    running.pop();
    child.kill("SIGKILL");
  });
});

async function pollUntil(
  adapter: ComfyUIEngineAdapter,
  instance: ComfyUIHandle,
  job: { id: string; modality: "image" | "video" | "audio" },
): Promise<MediaJobPoll> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const poll = await adapter.poll(instance, job, new AbortController().signal);
    if (poll.status === "completed" || poll.status === "failed") return poll;
  }
  throw new Error("Timed out polling the fixture ComfyUI server");
}

function request(modality: "image" | "video" | "audio", params: Record<string, unknown>): MediaGenerationRequest {
  return { id: "request-1", routeId: modality, modality, params: params as MediaGenerationRequest["params"] };
}

function recipeFor(configuration: Record<string, unknown>): Recipe {
  return {
    id: "h3", playbookId: "comfyui", displayName: "H3", adapter: "comfyui", modelId: "h3", contextTokens: 4096,
    capabilities: {
      chatCompletions: false, streaming: false, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1,
      modalities: { input: ["text", "image"], output: ["video", "audio"] },
    },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 60, minimumResidencySeconds: 0 },
    configuration,
  };
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
