import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { contextTokensForAgentRequest, contextTokensForRoute, thinkingFormatForAgentRequest } from "./route-context.js";

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

  it("selects Qwen template controls only for a resolved NInfer recipe", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "local", 100_000);
      const local = store.listRecipes().find((candidate) => candidate.id === "local")!;
      store.upsertRecipe({ ...local, adapter: "ninfer" });
      store.upsertRoute({ id: "default", displayName: "Default", recipeId: "local", enabled: true, isDefault: true });
      expect(thinkingFormatForAgentRequest(store, { model: "default", messages: [] })).toBe("ninfer");

      store.upsertRecipe({ ...local, adapter: "openai-compatible" });
      expect(thinkingFormatForAgentRequest(store, { model: "default", messages: [] })).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("uses configured self-hosted context independently of effort", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "orchestrator", 262_144);
      const current = store.listRecipes().find((candidate) => candidate.id === "orchestrator")!;
      store.upsertRecipe({
        ...current,
        capabilities: { ...current.capabilities, toolCalls: true, maxConcurrentGenerations: 3 },
        configuration: {},
        agentTopology: { sharedContextTokens: 256_000, workers: { count: 2, contextTokens: 64_000 } },
      });
      store.upsertRoute({ id: "default", displayName: "Default", recipeId: "orchestrator", enabled: true, isDefault: true });

      expect(contextTokensForAgentRequest(store, {
        model: "default",
        effort: "high",
        messages: [{ role: "user", content: "coordinate" }],
      })).toBe(128_000);
      expect(contextTokensForAgentRequest(store, {
        model: "default",
        effort: "high",
        delegation: { role: roleSnapshot(store, "implementer"), parentRunId: "parent" },
        messages: [{ role: "user", content: "implement" }],
      })).toBe(64_000);
      expect(contextTokensForAgentRequest(store, {
        model: "default",
        effort: "light",
        messages: [{ role: "user", content: "quick answer" }],
      })).toBe(128_000);
      expect(contextTokensForAgentRequest(store, {
        model: "default",
        messages: [{ role: "user", content: "normal answer" }],
      })).toBe(128_000);
    } finally {
      store.close();
    }
  });

  it("caps cloud parent and delegated worker context by inherited effort", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "default-recipe", 100_000);
      recipe(store, "fast-recipe", 131_072);
      store.upsertRoute({ id: "default", displayName: "Default", recipeId: "default-recipe", enabled: true, isDefault: true });
      store.setSetting("consumerCloudRoutes", [{ ownerUserId: "alice", role: "fast", recipeId: "fast-recipe", updatedAt: new Date(0).toISOString() }]);
      expect(contextTokensForAgentRequest(store, { model: "fast", effort: "light", messages: [] }, "alice")).toBe(12_000);
      expect(contextTokensForAgentRequest(store, { model: "fast", effort: "normal", messages: [] }, "alice")).toBe(32_000);
      expect(contextTokensForAgentRequest(store, {
        model: "fast",
        effort: "high",
        delegation: { role: roleSnapshot(store, "researcher"), parentRunId: "parent" },
        messages: [],
      }, "alice")).toBe(64_000);
    } finally {
      store.close();
    }
  });

  it("keeps a trusted remote self-hosted route on recipe context rules", () => {
    const store = SqliteStore.memory();
    try {
      recipe(store, "remote-gpu", 196_000);
      const current = store.listRecipes().find((candidate) => candidate.id === "remote-gpu")!;
      store.upsertRecipe({
        ...current,
        executionClass: "self_hosted",
        capabilities: { ...current.capabilities, toolCalls: true, maxConcurrentGenerations: 3 },
        agentTopology: { sharedContextTokens: 192_000, workers: { count: 2, contextTokens: 48_000 } },
      });
      store.setSetting("consumerConnections", [{
        ownerUserId: "alice", id: "yan-gpu", displayName: "Yan GPU", baseUrl: "https://yan.tail.test/v1",
        authType: "bearer", credentialEnv: "FITZ_TEST", template: "openai-compatible",
        executionClass: "self_hosted", accessClass: "trusted_remote",
        models: [{ modelId: "remote-gpu", recipeId: "remote-gpu" }], mediaModels: [], updatedAt: new Date(0).toISOString(),
      }]);
      store.setSetting("consumerCloudRoutes", [{ ownerUserId: "alice", role: "smart", recipeId: "remote-gpu", updatedAt: new Date(0).toISOString() }]);

      expect(contextTokensForAgentRequest(store, { model: "smart", effort: "light", messages: [] }, "alice")).toBe(96_000);
      expect(contextTokensForAgentRequest(store, {
        model: "smart", effort: "high", delegation: { role: roleSnapshot(store, "researcher"), parentRunId: "parent" }, messages: [],
      }, "alice")).toBe(48_000);
    } finally {
      store.close();
    }
  });
});

function roleSnapshot(store: SqliteStore, id: string) {
  const { enabled: _enabled, ...snapshot } = store.getSubagentRole(id)!;
  return snapshot;
}
