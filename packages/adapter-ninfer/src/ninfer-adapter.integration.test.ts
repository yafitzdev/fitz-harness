import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { InferenceDelta } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import { NInferEngineAdapter, buildCurrentNInferRecipe } from "./ninfer-adapter.js";

const fakeServerPath = fileURLToPath(
  new URL("./fixtures/ninfer-server.mjs", import.meta.url),
);

describe("NInferEngineAdapter process integration", () => {
  it("launches, authenticates, becomes ready, streams, inspects, and stops", async () => {
    const port = await availablePort();
    const recipe = buildCurrentNInferRecipe(
      "simulated-ninfer",
      "simulated-ninfer-model",
      fakeServerPath,
      3,
      process.execPath,
    );
    recipe.configuration = {
      ...recipe.configuration,
      executable: process.execPath,
      artifact: fakeServerPath,
      readinessTimeoutMs: 5_000,
      requestLogJsonl: undefined,
    };
    const adapter = new NInferEngineAdapter({
      pollIntervalMs: 20,
      stopTimeoutMs: 2_000,
    });
    const controller = new AbortController();
    const validation = await adapter.validateRecipe(recipe);
    expect(validation).toEqual({ valid: true, issues: [] });

    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port });
    expect(spec.args).not.toContain("--api-key");
    const instance = await adapter.start(recipe, spec, controller.signal);

    try {
      const ready = await adapter.waitUntilReady(instance, controller.signal);
      expect(ready).toEqual({
        modelId: "simulated-ninfer-model",
        baseUrl: `http://127.0.0.1:${port}`,
      });

      const deltas: InferenceDelta[] = [];
      for await (const delta of adapter.streamChat(
        instance,
        {
          id: "integration-request",
          routeId: "default-agent",
          messages: [{ role: "user", content: "adapter integration" }],
        },
        controller.signal,
      )) {
        deltas.push(delta);
      }

      expect(deltas.map((delta) => delta.text).join("")).toBe("simulated adapter integration");
      expect(deltas.at(-1)).toEqual({
        text: "",
        finishReason: "stop",
        promptTokens: 4,
        completionTokens: 2,
      });
      expect(await adapter.inspect(instance)).toEqual({
        healthy: true,
        modelId: "simulated-ninfer-model",
      });
      expect(instance.logs.join("\n")).toContain("fake-ninfer ready");
      expect(instance.logs.join("\n")).not.toContain(instance.apiKey);
    } finally {
      const stopped = await adapter.stop(instance, "graceful");
      expect(stopped.stopped).toBe(true);
    }
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
