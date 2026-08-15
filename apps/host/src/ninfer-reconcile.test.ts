import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { createNInferPlaybook, QWEN38_ORCHESTRATOR_RECIPE_ID } from "./ninfer-playbook.js";
import { reconcileNInferConfiguration } from "./ninfer-reconcile.js";

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

describe("reconcileNInferConfiguration", () => {
  it("upgrades every NInfer model to configurable concurrent workers", () => {
    const store = SqliteStore.memory();
    try {
      const current = createNInferPlaybook(runtime).recipes.find((recipe) => recipe.modelId === "qwen3.6-27b")!;
      const { agentTopology: _topology, ...legacySerial } = current;
      store.upsertRecipe({
        ...legacySerial,
        displayName: "My renamed Qwen",
        capabilities: { ...legacySerial.capabilities, maxConcurrentGenerations: 1 },
        configuration: { ...legacySerial.configuration, maxConcurrency: 1 },
      });

      reconcileNInferConfiguration(store, runtime);

      expect(store.listRecipes().find((recipe) => recipe.id === current.id)).toMatchObject({
        displayName: "My renamed Qwen",
        capabilities: { maxConcurrentGenerations: 3 },
        configuration: { maxConcurrency: 3, kvCapacity: 100_000, maxContext: 100_000, thinking: true },
        agentTopology: { sharedContextTokens: 100_000, workers: { count: 0, contextTokens: 32_000 } },
      });
    } finally {
      store.close();
    }
  });

  it("migrates the retired Qwen route to the recipe-owned agent pool and removes legacy fields", () => {
    const store = SqliteStore.memory();
    try {
      const current = createNInferPlaybook(runtime).recipes[0]!;
      const { agentTopology: _currentTopology, ...legacyCurrent } = current;
      store.upsertRecipe({
        ...legacyCurrent,
        id: "qwen38-27b-mtp3-16k-vision-c2",
        contextTokens: 16_384,
        capabilities: { ...current.capabilities, maxConcurrentGenerations: 2 },
        configuration: {
          ...current.configuration,
          maxContext: 16_384,
          kvCapacity: 150_000,
          maxConcurrency: 2,
          workerContextTokens: 64_000,
          maxLocalWorkers: 2,
        },
      });
      store.upsertRoute({
        id: "default",
        displayName: "Local",
        recipeId: "qwen38-27b-mtp3-16k-vision-c2",
        enabled: true,
        isDefault: true,
      });

      reconcileNInferConfiguration(store, runtime);

      const recipe = store.listRecipes().find((candidate) => candidate.id === QWEN38_ORCHESTRATOR_RECIPE_ID);
      expect(recipe).toMatchObject({
        contextTokens: 262_144,
        capabilities: { maxConcurrentGenerations: 3 },
        configuration: {
          maxContext: 128_000,
          kvCapacity: 256_000,
          maxConcurrency: 3,
        },
        agentTopology: {
          sharedContextTokens: 256_000,
          workers: { count: 2, contextTokens: 64_000 },
        },
      });
      expect(recipe?.configuration).not.toHaveProperty("workerContextTokens");
      expect(recipe?.configuration).not.toHaveProperty("maxLocalWorkers");
      expect(store.listRoutes().find((route) => route.id === "default")?.recipeId).toBe(QWEN38_ORCHESTRATOR_RECIPE_ID);
      expect(store.listRecipes().some((candidate) => candidate.id === "qwen38-27b-mtp3-16k-vision-c2")).toBe(false);
    } finally {
      store.close();
    }
  });
});
