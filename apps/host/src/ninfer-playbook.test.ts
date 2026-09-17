import { describe, expect, it } from "vitest";
import { readNInferConfiguration, validateNInferConfiguration } from "@fitz/adapter-ninfer";
import { createNInferPlaybook, NINFER_PLAYBOOK_ID } from "./ninfer-playbook.js";

describe("production NiNfer playbook", () => {
  const runtime = {
    id: "inference-linux",
    distribution: "Fitz-Inference",
    hostRoot: "C:\\Users\\tester\\.llm\\runtimes\\inference-linux",
    guestRoot: "/opt/fitz/llm",
    engineRoot: "/opt/fitz/llm/engines",
    environmentRoot: "/opt/fitz/llm/environments",
    logRoot: "/opt/fitz/llm/logs",
    modelRoot: "/opt/fitz/llm/models/ninfer",
    executable: "/opt/fitz/llm/environments/ninfer/bin/ninfer-serve",
  };

  it("contains the managed model profiles and one host-owned Default route", () => {
    const playbook = createNInferPlaybook(runtime);

    expect(playbook).toMatchObject({ id: "ninfer", displayName: "ninfer" });
    expect(new Set(playbook.recipes.map((recipe) => recipe.playbookId))).toEqual(new Set([NINFER_PLAYBOOK_ID]));
    expect(playbook.recipes).toHaveLength(3);
    expect(playbook.recipes.every((recipe) => validateNInferConfiguration(recipe).length === 0)).toBe(true);
    expect(playbook.recipes.every((recipe) => recipe.lifecycle.evictionPolicy === "never" && recipe.lifecycle.idleTtlSeconds === 0)).toBe(true);
    expect(playbook.recipes.map((recipe) => recipe.capabilities.maxConcurrentGenerations)).toEqual([1, 3, 3]);
    expect(playbook.recipes.every((recipe) => readNInferConfiguration(recipe).thinking)).toBe(true);
    expect(playbook.recipes.map((recipe) => readNInferConfiguration(recipe).draftTokens)).toEqual([4, 4, 4]);
    expect(playbook.recipes.map((recipe) => readNInferConfiguration(recipe).kvCapacity)).toEqual(["auto", 131_072, "auto"]);
    expect(playbook.routes).toEqual([expect.objectContaining({ id: "default", recipeId: playbook.recipes[0]!.id, isDefault: true })]);
  });

  it("resolves logical recipes into the managed Linux runtime", () => {
    const playbook = createNInferPlaybook(runtime);
    expect(playbook.recipes.every((recipe) => recipe.configuration.runtimeId === "inference-linux")).toBe(true);
    expect(playbook.recipes.every((recipe) => recipe.configuration.runtimeDistribution === undefined)).toBe(true);
    expect(playbook.recipes[0]).toMatchObject({
      modelId: "qwen3.8-27b",
      contextTokens: 262_144,
      capabilities: {
        maxConcurrentGenerations: 1,
        modalities: { input: ["text", "image"], output: [] },
      },
      configuration: {
        artifact: "/opt/fitz/llm/models/ninfer/qwen3_8_27b.ninfer",
        maxContext: 131_072,
        kvCapacity: "auto",
        maxConcurrency: 1,
        kvDtype: "bf16",
        vision: true,
      },
    });
    expect(playbook.recipes[1]).toMatchObject({
      modelId: "qwen3.8-27b-nvfp4",
      capabilities: { maxConcurrentGenerations: 3 },
      configuration: {
        artifact: "/opt/fitz/llm/models/ninfer/qwen3_8_27b_nvfp4.ninfer",
        maxContext: 131_072,
        kvCapacity: 131_072,
        kvDtype: "int8",
      },
    });
    expect(playbook.recipes[2]!.configuration).toMatchObject({
      executable: runtime.executable,
      artifact: "/opt/fitz/llm/models/ninfer/qwen3_6_35b_a3b.ninfer",
      maxConcurrency: 3,
      kvCapacity: "auto",
      requestLogJsonl: "/opt/fitz/llm/logs/ninfer-requests.jsonl",
      engineRef: "llm://engines/ninfer",
      modelRef: "llm://models/qwen3.6-35b-a3b",
    });
    expect(playbook.recipes.every((recipe) => !("agentTopology" in recipe))).toBe(true);
  });
});
