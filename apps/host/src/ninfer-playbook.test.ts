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
    expect(playbook.recipes.every((recipe) => recipe.lifecycle.idleTtlSeconds === 1_800)).toBe(true);
    expect(playbook.recipes.map((recipe) => readNInferConfiguration(recipe).draftTokens)).toEqual([4, 3]);
    expect(playbook.routes).toEqual([
      expect.objectContaining({ id: "fast", recipeId: playbook.recipes[1]!.id }),
      expect.objectContaining({ id: "default", recipeId: playbook.recipes[0]!.id, isDefault: true }),
      expect.objectContaining({ id: "smart", recipeId: playbook.recipes[0]!.id }),
    ]);
  });
});
