import { describe, expect, it } from "vitest";
import { readNInferConfiguration, validateNInferConfiguration } from "@fitz/engine-ninfer";
import { createNInferPlaybook, NINFER_PLAYBOOK_ID } from "./ninfer-playbook.js";

describe("production NiNfer playbook", () => {
  it("contains exactly two validated recipes and the fixed fast/default/smart routes", () => {
    const playbook = createNInferPlaybook();

    expect(playbook).toMatchObject({ id: "ninfer", displayName: "ninfer" });
    expect(new Set(playbook.recipes.map((recipe) => recipe.playbookId))).toEqual(new Set([NINFER_PLAYBOOK_ID]));
    expect(playbook.recipes).toHaveLength(2);
    expect(playbook.recipes.every((recipe) => validateNInferConfiguration(recipe).length === 0)).toBe(true);
    expect(playbook.recipes.every((recipe) => recipe.lifecycle.idleTtlSeconds === 600)).toBe(true);
    expect(playbook.recipes.map((recipe) => readNInferConfiguration(recipe).draftTokens)).toEqual([4, 3]);
    expect(playbook.routes).toEqual([
      expect.objectContaining({ id: "fast", recipeId: playbook.recipes[1]!.id }),
      expect.objectContaining({ id: "default", recipeId: playbook.recipes[0]!.id, isDefault: true }),
      expect.objectContaining({ id: "smart", recipeId: playbook.recipes[0]!.id }),
    ]);
  });

  it("resolves logical recipes into the managed Linux runtime", () => {
    const runtime = {
      id: "ninfer-linux",
      distribution: "Fitz-NInfer",
      hostRoot: "C:\\Users\\tester\\.llm\\runtimes\\ninfer-linux",
      guestRoot: "/opt/fitz/llm",
      modelRoot: "/opt/fitz/llm/models/ninfer",
      executable: "/opt/fitz/llm/engines/ninfer/ninfer-serve",
    };
    const playbook = createNInferPlaybook(runtime);
    expect(playbook.recipes.every((recipe) => recipe.configuration.runtimeId === "ninfer-linux")).toBe(true);
    expect(playbook.recipes.every((recipe) => recipe.configuration.runtimeDistribution === "Fitz-NInfer")).toBe(true);
    expect(playbook.recipes[1]!.configuration).toMatchObject({
      executable: runtime.executable,
      artifact: "/opt/fitz/llm/models/ninfer/qwen3_6_27b_nvfp4.ninfer",
      requestLogJsonl: "/opt/fitz/llm/logs/ninfer-requests.jsonl",
      engineRef: "llm://engines/ninfer",
      modelRef: "llm://models/qwen3.6-27b",
    });
  });
});
