import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
import { LlamaCppEngineAdapter, validateLlamaCppConfiguration } from "./llama-cpp-adapter.js";

const running: Array<{ process: { kill(signal?: NodeJS.Signals): boolean } }> = [];

afterEach(() => { for (const instance of running.splice(0)) instance.process.kill("SIGKILL"); });

describe("LlamaCppEngineAdapter process integration", () => {
  it("launches, waits, streams, and stops a simulated llama-server", async () => {
    const port = await unusedPort();
    const fixture = fileURLToPath(new URL("./fixtures/llama-server.mjs", import.meta.url));
    const recipe = recipeFor({ executable: process.execPath, modelPath: fixture, prefixArgs: [fixture] });
    const adapter = new LlamaCppEngineAdapter({ validatePaths: true, pollIntervalMs: 10, readinessTimeoutMs: 3_000, stopTimeoutMs: 1_000 });
    expect(await adapter.validateRecipe(recipe)).toEqual({ valid: true, issues: [] });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    running.push(instance);
    await expect(adapter.waitUntilReady(instance, new AbortController().signal)).resolves.toMatchObject({ modelId: "fixture-model" });

    const chunks = [];
    for await (const chunk of adapter.streamChat(instance, {
      id: "request-1", routeId: "default", messages: [{ role: "user", content: "hello" }],
    }, new AbortController().signal)) chunks.push(chunk);
    expect(chunks).toEqual([{ text: "llama", finishReason: "stop" }]);
    await expect(adapter.stop(instance, "graceful")).resolves.toEqual({ stopped: true });
    running.pop();
  });

  it("rejects attempts to override managed process arguments", () => {
    expect(validateLlamaCppConfiguration(recipeFor({ executable: "llama-server", modelPath: "model.gguf", extraArgs: ["--port=1"] }))).toEqual([
      expect.objectContaining({ code: "reserved_argument" }),
    ]);
  });
});

function recipeFor(configuration: Record<string, unknown>): Recipe {
  return {
    id: "llama", playbookId: "llama", displayName: "llama.cpp", adapter: "llama-cpp", modelId: "fixture-model", contextTokens: 4096,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
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
