import { describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
import { ManagedOpenAIEngineAdapter, type ManagedOpenAIHandle } from "./managed-openai-adapter.js";
import { OpenAICompatibleClient } from "./openai-compatible-client.js";

describe("ManagedOpenAIEngineAdapter", () => {
  it("builds an engine-agnostic launch inside the managed inference runtime", async () => {
    const adapter = new ManagedOpenAIEngineAdapter({ linuxRuntimes: new Map([["inference-linux", { distribution: "Fitz-Inference" }]]) });
    const recipe = managedRecipe({
      enginePath: "/opt/fitz/llm/engines/private-fork",
      runtime: "linux-managed",
      runtimeId: "inference-linux",
      command: "./build/server",
      args: ["--host", "{host}", "--port", "{port}", "--model", "{model}", "--ctx-size", "{context}"],
      workingDirectory: ".",
      healthPath: "/v1/models",
      readinessTimeoutMs: 30_000,
    });

    await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    await expect(adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 19191 })).resolves.toMatchObject({
      executable: "wsl.exe",
      args: ["-d", "Fitz-Inference", "-u", "root", "--", "sh", "-s", "--", "/opt/fitz/llm/engines/private-fork", "/opt/fitz/llm/engines/private-fork/build/server", "--host", "127.0.0.1", "--port", "19191", "--model", "custom-model", "--ctx-size", "32768"],
    });
  });

  it("builds a launch entirely inside a named managed Linux runtime", async () => {
    const adapter = new ManagedOpenAIEngineAdapter({ linuxRuntimes: new Map([["inference-linux", { distribution: "Fitz-Inference" }]]) });
    const recipe = managedRecipe({
      enginePath: "/opt/fitz/llm/environments/vllm",
      runtime: "linux-managed",
      runtimeId: "inference-linux",
      command: "./serve.sh",
      args: ["--port", "{port}"],
      workingDirectory: "bin",
      healthPath: "/health",
      readinessTimeoutMs: 45_000,
    });

    await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    await expect(adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 18181 })).resolves.toMatchObject({
      executable: "wsl.exe",
      args: ["-d", "Fitz-Inference", "-u", "root", "--", "sh", "-s", "--", "/opt/fitz/llm/environments/vllm/bin", "/opt/fitz/llm/environments/vllm/bin/serve.sh", "--port", "18181"],
    });
  });

  it("passes a validated managed guest environment explicitly", async () => {
    const adapter = new ManagedOpenAIEngineAdapter({ linuxRuntimes: new Map([["inference-linux", { distribution: "Fitz-Inference" }]]) });
    const recipe = managedRecipe({
      enginePath: "/opt/fitz/llm/engines/vllm",
      runtime: "linux-managed",
      runtimeId: "inference-linux",
      command: "/opt/fitz/llm/environments/vllm/bin/vllm",
      args: ["serve", "/models/qwen"],
      workingDirectory: ".",
      healthPath: "/health",
      readinessTimeoutMs: 900_000,
      environment: { VLLM_SERVER_DEV_MODE: "1" },
    });

    await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    await expect(adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 18181 })).resolves.toMatchObject({
      args: ["-d", "Fitz-Inference", "-u", "root", "--", "sh", "-s", "--", "/opt/fitz/llm/engines/vllm", "/usr/bin/env", "VLLM_SERVER_DEV_MODE=1", "/opt/fitz/llm/environments/vllm/bin/vllm", "serve", "/models/qwen"],
    });
  });

  it("rejects unnamed WSL recipes so distribution details cannot leak into playbooks", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    await expect(adapter.validateRecipe(managedRecipe({
      enginePath: "/opt/fitz/llm/engines/vllm", runtime: "wsl", command: "vllm",
      args: [], workingDirectory: ".", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    }))).resolves.toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "invalid_configuration" })] });
  });

  it("rejects a managed endpoint that belongs to another served model", async () => {
    const client = new OpenAICompatibleClient({
      fetch: async (input) => String(input).endsWith("/health")
        ? new Response(null, { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: "Qwen/Qwen3.5-2B" }] }), { status: 200 }),
    });
    const adapter = new ManagedOpenAIEngineAdapter({ pollIntervalMs: 1 });
    const handle = {
      modelId: "custom-model",
      baseUrl: "http://127.0.0.1:19001",
      healthPath: "/health",
      readinessTimeoutMs: 30_000,
      process: { exitCode: null, signalCode: null },
      logs: [],
      client,
    } as unknown as ManagedOpenAIHandle;

    await expect(adapter.waitUntilReady(handle, new AbortController().signal)).rejects.toThrow(
      /expected model custom-model, advertised Qwen\/Qwen3\.5-2B/,
    );
  });

  it("rejects working directories and relative commands that escape the engine checkout", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    await expect(adapter.validateRecipe(managedRecipe({
      enginePath: "/opt/fitz/llm/engines/private-fork", runtime: "linux-managed", runtimeId: "inference-linux", command: "python",
      args: [], workingDirectory: "..", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    }))).resolves.toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "invalid_working_directory" })] });
    await expect(adapter.validateRecipe(managedRecipe({
      enginePath: "/opt/fitz/llm/engines/private-fork", runtime: "linux-managed", runtimeId: "inference-linux", command: "../outside",
      args: [], workingDirectory: ".", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    }))).resolves.toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "invalid_command_path" })] });
  });

  it("reports loaded shared capacity from engine logs with a recipe-limit fallback", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    const recipe = managedRecipe({});
    const handle = (logs: string[]) => ({ logs } as ManagedOpenAIHandle);

    await expect(adapter.contextCapacity(handle(["GPU KV cache size: 637,486 tokens"]), recipe)).resolves.toBe(637_486);
    await expect(adapter.contextCapacity(handle(["llama_server: n_slots = 3, n_ctx_slot = 11008, kv_unified = 'false'"]), recipe)).resolves.toBe(11_008);
    await expect(adapter.contextCapacity(handle(["server ready"]), recipe)).resolves.toBe(32_768);
  });

  it("translates a typed llama drafter relationship at launch without persisting engine flags", async () => {
    const adapter = new ManagedOpenAIEngineAdapter({ linuxRuntimes: new Map([["inference-linux", { distribution: "Fitz-Inference" }]]) });
    const recipe = managedRecipe({
      enginePath: "/opt/fitz/llm/engines/llama.cpp", runtime: "linux-managed", runtimeId: "inference-linux", command: "./build/server",
      args: ["--model", "{model}", "--ctx-size", "{context}"], workingDirectory: ".", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    });
    const linked = { ...recipe, playbookId: "llama.cpp", speculativeDecoding: {
      strategy: "draft-dflash" as const,
      drafter: { id: "drafter-1", modelId: "Qwen-DFlash", path: "/opt/fitz/llm/models/gguf/qwen-dflash.gguf" },
      maxDraftTokens: 15, gpuLayers: "all" as const, source: "auto" as const,
    }};

    await expect(adapter.validateRecipe(linked)).resolves.toEqual({ valid: true, issues: [] });
    await expect(adapter.buildLaunchSpec(linked, { host: "127.0.0.1", port: 19191 })).resolves.toMatchObject({
      args: expect.arrayContaining(["--model-draft", "/opt/fitz/llm/models/gguf/qwen-dflash.gguf", "--spec-type", "draft-dflash", "--spec-draft-ngl", "999", "--spec-draft-n-max", "15"]),
    });
  });

  it("launches native MTP without a separate draft-model argument", async () => {
    const adapter = new ManagedOpenAIEngineAdapter({ linuxRuntimes: new Map([["inference-linux", { distribution: "Fitz-Inference" }]]) });
    const recipe = managedRecipe({
      enginePath: "/opt/fitz/llm/engines/llama.cpp", runtime: "linux-managed", runtimeId: "inference-linux", command: "./build/server",
      args: ["--model", "{model}", "--ctx-size", "{context}"], workingDirectory: ".", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    });
    const mtp = { ...recipe, playbookId: "llama.cpp", speculativeDecoding: {
      strategy: "draft-mtp" as const, maxDraftTokens: 4, gpuLayers: "all" as const, source: "auto" as const,
    }};

    await expect(adapter.validateRecipe(mtp)).resolves.toEqual({ valid: true, issues: [] });
    const spec = await adapter.buildLaunchSpec(mtp, { host: "127.0.0.1", port: 19192 });
    expect(spec.args).toEqual(expect.arrayContaining(["--spec-type", "draft-mtp", "--spec-draft-n-max", "4"]));
    expect(spec.args).not.toContain("--model-draft");
  });
});

function managedRecipe(configuration: Recipe["configuration"]): Recipe {
  return {
    id: "custom-recipe",
    playbookId: "private-fork",
    displayName: "Custom recipe",
    adapter: "openai-managed",
    modelId: "custom-model",
    contextTokens: 32_768,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 300, minimumResidencySeconds: 0 },
    configuration,
  };
}
