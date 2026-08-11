import { describe, expect, it } from "vitest";
import type { Recipe, Route } from "@fitz/protocol";
import { RouteResolver } from "./route-resolver.js";

const recipe: Recipe = {
  id: "media", playbookId: "ComfyUI", displayName: "Media", adapter: "comfyui", modelId: "model", contextTokens: 1,
  capabilities: { chatCompletions: false, streaming: false, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1, modalities: { input: ["text"], output: ["video"] } },
  lifecycle: { loadPolicy: "onDemand", evictionPolicy: "immediate", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
  configuration: { pinned: true },
};
const route: Route = { id: "video", displayName: "Video", recipeId: recipe.id, enabled: true, isDefault: false, kind: "video" };

describe("RouteResolver recipe resolution", () => {
  it("resolves recipes without overlaying host policy on stored configuration", () => {
    const resolver = new RouteResolver([route], [recipe]);
    expect(resolver.resolve("video").recipe.configuration).toEqual({ pinned: true });
    expect(resolver.listRecipes()[0]?.configuration).toEqual({ pinned: true });
  });

  it("clones resolved recipes so callers cannot mutate the registry", () => {
    const resolver = new RouteResolver([route], [recipe]);
    const resolved = resolver.resolve("video").recipe;
    resolved.configuration = { injected: true };
    expect(resolver.resolveRecipe("media").configuration).toEqual({ pinned: true });
  });
});
