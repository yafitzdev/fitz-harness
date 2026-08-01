import { describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
import { ManagedOpenAIEngineAdapter } from "./managed-openai-adapter.js";

describe("ManagedOpenAIEngineAdapter", () => {
  it("builds an engine-agnostic Windows launch without changing the repository", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    const recipe = managedRecipe({
      enginePath: "C:\\Users\\test\\engines\\private-fork",
      runtime: "windows",
      command: ".\\build\\server.exe",
      args: ["--host", "{host}", "--port", "{port}", "--model", "{model}", "--ctx-size", "{context}"],
      workingDirectory: ".",
      healthPath: "/v1/models",
      readinessTimeoutMs: 30_000,
    });

    await expect(adapter.validateRecipe(recipe)).resolves.toEqual({ valid: true, issues: [] });
    await expect(adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 19191 })).resolves.toMatchObject({
      executable: "C:\\Users\\test\\engines\\private-fork\\build\\server.exe",
      cwd: "C:\\Users\\test\\engines\\private-fork",
      args: ["--host", "127.0.0.1", "--port", "19191", "--model", "custom-model", "--ctx-size", "32768"],
    });
  });

  it("builds a generic WSL launch rooted in the selected engine checkout", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    const recipe = managedRecipe({
      enginePath: "C:\\Users\\test\\engines\\another-engine",
      runtime: "wsl",
      command: "./serve.sh",
      args: ["--port", "{port}"],
      workingDirectory: "runtime",
      wslDistribution: "Ubuntu-24.04",
      healthPath: "/health",
      readinessTimeoutMs: 45_000,
    });

    await expect(adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 18181 })).resolves.toMatchObject({
      executable: "wsl.exe",
      args: ["-d", "Ubuntu-24.04", "--cd", "/mnt/c/Users/test/engines/another-engine/runtime", "--", "./serve.sh", "--port", "18181"],
    });
  });

  it("rejects working directories and relative commands that escape the engine checkout", async () => {
    const adapter = new ManagedOpenAIEngineAdapter();
    await expect(adapter.validateRecipe(managedRecipe({
      enginePath: "C:\\Users\\test\\engines\\private-fork", runtime: "windows", command: "python",
      args: [], workingDirectory: "..", healthPath: "/v1/models", readinessTimeoutMs: 30_000,
    }))).resolves.toMatchObject({ valid: false, issues: [expect.objectContaining({ code: "invalid_working_directory" })] });
    await expect(adapter.validateRecipe(managedRecipe({
      enginePath: "C:\\Users\\test\\engines\\private-fork", runtime: "windows", command: "..\\outside.exe",
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
