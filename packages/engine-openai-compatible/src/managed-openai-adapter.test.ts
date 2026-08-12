import { describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
import { ManagedOpenAIEngineAdapter } from "./managed-openai-adapter.js";

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

  it("rejects unnamed WSL recipes so distribution details cannot leak into playbooks", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    await expect(adapter.validateRecipe(managedRecipe({
      enginePath: "/opt/fitz/llm/engines/vllm", runtime: "wsl", command: "vllm",
      args: [], workingDirectory: ".", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    }))).resolves.toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "invalid_configuration" })] });
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
