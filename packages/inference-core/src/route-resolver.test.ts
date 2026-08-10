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

describe("RouteResolver engine performance policy", () => {
  it("overlays host policy without mutating stored recipe configuration", () => {
    const resolver = new RouteResolver([route], [recipe], new Map([["comfyui", "safe"]]));
    expect(resolver.resolve("video").recipe.configuration).toEqual({ pinned: true, performanceMode: "safe" });
    expect(resolver.listRecipes()[0]?.configuration).toEqual({ pinned: true });
  });

  it("applies engine changes to subsequent requests", () => {
    const resolver = new RouteResolver([route], [recipe]);
    expect(resolver.resolveRecipe("media").configuration.performanceMode).toBe("normal");
    resolver.setEnginePerformanceMode("COMFYUI", "safe");
    expect(resolver.resolveRecipe("media").configuration.performanceMode).toBe("safe");
  });
});
