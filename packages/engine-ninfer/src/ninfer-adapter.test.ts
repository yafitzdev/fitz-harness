import { describe, expect, it } from "vitest";
import { NInferEngineAdapter, buildCurrentNInferRecipe, buildNInferProcessLaunch, type NInferInstanceHandle } from "./ninfer-adapter.js";
import { validateNInferConfiguration } from "./config.js";

describe("NInferEngineAdapter launch contract", () => {
  it("renders the current 27B MTP3 recipe as executable plus argv", async () => {
    const recipe = buildCurrentNInferRecipe(
      "qwen-27b",
      "qwen3.6-27b",
      "/models/ninfer/qwen3_6_27b_nvfp4.ninfer",
      3,
      "/engines/ninfer/build/apps/ninfer-serve",
    );
    const adapter = new NInferEngineAdapter({ validatePaths: false });

    expect(await adapter.validateRecipe(recipe)).toEqual({ valid: true, issues: [] });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 19_001 });

    expect(spec.executable).toBe("/engines/ninfer/build/apps/ninfer-serve");
    expect(spec.args).toContain("/models/ninfer/qwen3_6_27b_nvfp4.ninfer");
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--host",
        "127.0.0.1",
        "--port",
        "19001",
        "--max-context",
        "100000",
        "--spec",
        "mtp",
        "--draft-tokens",
        "3",
        "--lm-head-draft",
        "--no-thinking",
      ]),
    );
    expect(spec.args).not.toContain("--api-key");
  });

  it("rejects extra arguments that override Fitz-owned process controls", () => {
    const recipe = buildCurrentNInferRecipe("bad", "bad", "/model.ninfer", 4, "/ninfer-serve");
    recipe.configuration = { ...recipe.configuration, extraArgs: ["--api-key=leak"] };
    expect(validateNInferConfiguration(recipe)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reserved_argument" })]),
    );
  });

  it("wraps the exact launch argv for a Windows WSL host", async () => {
    const recipe = buildCurrentNInferRecipe("qwen-27b", "qwen3.6-27b", "/models/ninfer/model.ninfer", 3, "/engines/ninfer/build/apps/ninfer-serve");
    const spec = await new NInferEngineAdapter({ validatePaths: false }).buildLaunchSpec(recipe, { host: "127.0.0.1", port: 19_001 });
    const launch = buildNInferProcessLaunch(spec, "generated-secret", "Ubuntu", "root");

    expect(launch.executable).toBe("wsl.exe");
    expect(launch.args.slice(0, 8)).toEqual(["-d", "Ubuntu", "-u", "root", "--", "sh", "-s", "--"]);
    expect(launch.args).toContain("/engines/ninfer/build/apps/ninfer-serve");
    expect(launch.args.slice(-2)).toEqual(["--api-key", "generated-secret"]);
    expect(launch.stdin).toContain('exec "$@"');
  });

  it("enforces the readiness deadline when a health request hangs", async () => {
    const adapter = new NInferEngineAdapter({
      pollIntervalMs: 2,
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });
    const instance = {
      id: "stalled",
      recipeId: "recipe",
      modelId: "model",
      baseUrl: "http://127.0.0.1:19001",
      startedAt: new Date(),
      apiKey: "secret-key",
      process: { exitCode: null, signalCode: null },
      logs: ["stderr: startup secret-key stalled"],
      readinessTimeoutMs: 30,
    } as unknown as NInferInstanceHandle;

    await expect(adapter.waitUntilReady(instance, new AbortController().signal)).rejects.toThrow(
      /Timed out waiting for NInfer.*\[REDACTED\]/,
    );
  });

  it("includes redacted stderr when the engine exits during startup", async () => {
    const adapter = new NInferEngineAdapter();
    const instance = {
      id: "failed",
      recipeId: "recipe",
      modelId: "model",
      baseUrl: "http://127.0.0.1:19001",
      startedAt: new Date(),
      apiKey: "secret-key",
      process: { exitCode: 1, signalCode: null },
      logs: ["stderr: cannot open /opt/fitz/llm/logs/ninfer-requests.jsonl", "stderr: secret-key"],
      readinessTimeoutMs: 30,
    } as unknown as NInferInstanceHandle;

    await expect(adapter.waitUntilReady(instance, new AbortController().signal)).rejects.toThrow(
      /code 1.*cannot open.*\[REDACTED\]/,
    );
  });

  it("forwards tools and returns streamed function-call deltas", async () => {
    let requestBody: any;
    const encoder = new TextEncoder();
    const adapter = new NInferEngineAdapter({
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const instance = { modelId: "qwen", baseUrl: "http://127.0.0.1:19001", apiKey: "secret" } as NInferInstanceHandle;
    const chunks = [];
    for await (const chunk of adapter.streamChat(instance, {
      id: "request", routeId: "smart", messages: [{ role: "user", content: "read" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      toolChoice: "auto",
    }, new AbortController().signal)) chunks.push(chunk);
    expect(requestBody).toMatchObject({ model: "qwen", tools: [expect.objectContaining({ function: expect.objectContaining({ name: "read" }) })], tool_choice: "auto" });
    expect(chunks).toEqual([
      expect.objectContaining({ toolCalls: [expect.objectContaining({ id: "call-1", function: expect.objectContaining({ name: "read" }) })] }),
      expect.objectContaining({ finishReason: "tool_calls" }),
    ]);
  });
});
