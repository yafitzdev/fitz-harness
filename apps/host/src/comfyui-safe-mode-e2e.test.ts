import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { ComfyUIEngineAdapter } from "@fitz/engine-comfyui";
import { SqliteStore } from "@fitz/storage";
import { createHost } from "./create-app.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";
import { testThermalGuard } from "./test-thermal.js";

const FIXTURE = fileURLToPath(new URL("../../../packages/engine-comfyui/src/fixtures/comfyui-server.mjs", import.meta.url));

const children: Array<ChildProcessWithoutNullStreams> = [];
const tempRoots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * End-to-end path for local ComfyUI media generation: a store seeded exactly
 * like reconcileLocalComfyUIConfiguration (engine record + h3-video recipe +
 * video route), a real createHost pipeline, and a fixture server that records
 * the exact graph the adapter submits to ComfyUI. The test asserts the graph
 * leaves the host unchanged: GPU pacing is engine-side now, applied by the
 * fitz_safe_sampler extension inside ComfyUI, so no host-side node swap or
 * performance mode exists anymore.
 */
describe("ComfyUI media generation end-to-end (engine-side pacing)", () => {
  it("submits the workflow unchanged; pacing is applied engine-side by the extension", async () => {
    const fixturePort = await unusedPort();
    const tempRoot = mkdtempSync(join(tmpdir(), "fitz-comfy-safe-e2e-"));
    tempRoots.push(tempRoot);
    const graphFile = join(tempRoot, "graphs.jsonl");
    const child = spawn(process.execPath, [FIXTURE, "--listen", "127.0.0.1", "--port", String(fixturePort), "--progress-per-poll", "0.5", "--graph-file", graphFile]);
    children.push(child);
    await waitForHttp(fixturePort);

    const store = SqliteStore.memory();
    const now = new Date().toISOString();
    store.upsertEngine({
      id: "comfyui",
      folderName: "ComfyUI",
      displayName: "comfyui",
      connectionMode: "managed",
      runtime: "linux-managed",
      runtimeId: "inference-linux",
      baseUrl: "http://127.0.0.1",
      healthPath: "/system_stats",
      launchCommand: "python",
      launchArguments: ["main.py"],
      workingDirectory: ".",
      createdAt: now,
      updatedAt: now,
    });
    const playbook = createComfyUIPlaybook({ engineDir: ".", baseUrl: `http://127.0.0.1:${fixturePort}` });
    const recipe = playbook.recipes.find((candidate) => candidate.id === "h3-video")!;
    store.upsertRecipe(recipe);
    store.upsertRoute({ id: "video", displayName: "Video generation", description: "Local video generation via ComfyUI", recipeId: "h3-video", kind: "video", enabled: true });

    const comfyui = new ComfyUIEngineAdapter({ validatePaths: false, pollIntervalMs: 10, defaultPollIntervalMs: 1, readinessTimeoutMs: 5_000 });
    const runtime = createHost({
      store,
      adapters: [new FakeEngineAdapter(), comfyui],
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
      const test = await runtime.app.inject({ method: "POST", url: "/api/v1/management/recipes/h3-video/media-test" });
      expect(test.statusCode, test.body).toBe(200);
      expect(test.json().data).toEqual(expect.objectContaining({ recipeId: "h3-video", status: "completed", working: true }));

      const lines = readFileSync(graphFile, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const graph = JSON.parse(lines[lines.length - 1]) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

      const sampler = Object.values(graph).find((node) => node.class_type.includes("Sampler"));
      expect(sampler).toBeDefined();
      expect(sampler!.class_type).toBe("SamplerCustomAdvanced");
      expect(sampler!.inputs.safe_duty_cycle).toBeUndefined();
    } finally {
      await runtime.app.close();
    }
  });
});

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
