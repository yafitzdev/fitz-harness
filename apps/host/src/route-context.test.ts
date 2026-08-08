import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { contextTokensForRoute } from "./route-context.js";

function recipe(store: SqliteStore, id: string, contextTokens: number): void {
  store.upsertRecipe({
    id,
    playbookId: "test",
    displayName: id,
    adapter: "fake",
    modelId: id,
    contextTokens,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
    configuration: {},
  });
}

describe("contextTokensForRoute", () => {
  it("resolves the context window of the recipe the route points at", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "deepseek-recipe", 131_072);
      recipe(store, "ninfer-recipe", 100_000);
      store.upsertRoute({ id: "smart", displayName: "Smart", description: "Smart", recipeId: "deepseek-recipe", enabled: true, isDefault: false });
      store.upsertRoute({ id: "default", displayName: "Default", description: "Default", recipeId: "ninfer-recipe", enabled: true, isDefault: true });
      expect(contextTokensForRoute(store, "smart")).toBe(131_072);
      expect(contextTokensForRoute(store, "default")).toBe(100_000);
    } finally {
      store.close();
    }
  });

  it("falls back to the pi SDK default for unknown routes", () => {
    const store = SqliteStore.memory();
    try {
      expect(contextTokensForRoute(store, "missing-route")).toBe(100_000);
    } finally {
      store.close();
    }
  });
});
