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
  it("resolves Default and an owner-scoped Smart binding", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "deepseek-recipe", 131_072);
      recipe(store, "ninfer-recipe", 100_000);
      store.upsertRoute({ id: "default", displayName: "Default", description: "Default", recipeId: "ninfer-recipe", enabled: true, isDefault: true });
      store.setSetting("consumerCloudRoutes", [{ ownerUserId: "alice", role: "smart", recipeId: "deepseek-recipe", updatedAt: new Date(0).toISOString() }]);
      expect(contextTokensForRoute(store, "smart", "alice")).toBe(131_072);
      expect(contextTokensForRoute(store, "smart", "bob")).toBe(100_000);
      expect(contextTokensForRoute(store, "default")).toBe(100_000);
    } finally {
      store.close();
    }
  });

  it("uses the construction default for unconfigured Fast and the owner's cloud worker when configured", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "worker-recipe", 32_768);
      recipe(store, "default-recipe", 65_536);
      store.upsertRoute({ id: "default", displayName: "Default", recipeId: "default-recipe", enabled: true, isDefault: true });
      expect(contextTokensForRoute(store, "fast", "alice")).toBe(100_000);
      store.setSetting("consumerCloudRoutes", [{ ownerUserId: "alice", role: "fast", recipeId: "worker-recipe", updatedAt: new Date(0).toISOString() }]);
      expect(contextTokensForRoute(store, "fast", "alice")).toBe(32_768);
      expect(contextTokensForRoute(store, "fast", "bob")).toBe(100_000);
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
