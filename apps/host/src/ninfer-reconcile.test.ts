import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { createNInferPlaybook } from "./ninfer-playbook.js";
import { QWEN36_35B_RECIPE_ID, QWEN38_GROUPWISE_RECIPE_ID, QWEN38_NVFP4_RECIPE_ID } from "./ninfer-model-profiles.js";
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
  it("upgrades every NInfer model to the global runtime policy", () => {
    const store = SqliteStore.memory();
    try {
      const current = createNInferPlaybook(runtime).recipes.find((recipe) => recipe.modelId === "qwen3.6-35b-a3b")!;
      store.upsertRecipe({
        ...current,
        displayName: "My renamed Qwen",
        capabilities: { ...current.capabilities, maxConcurrentGenerations: 1 },
        configuration: { ...current.configuration, maxConcurrency: 1 },
      });

      reconcileNInferConfiguration(store, runtime);

      expect(store.listRecipes().find((recipe) => recipe.id === current.id)).toMatchObject({
        displayName: "My renamed Qwen",
        capabilities: { maxConcurrentGenerations: 3 },
        configuration: { maxConcurrency: 3, kvCapacity: "auto", maxContext: 131_072, thinking: true },
      });
      expect(store.listRecipes().find((recipe) => recipe.id === current.id)).not.toHaveProperty("agentTopology");
    } finally {
      store.close();
    }
  });

  it("replaces unsafe automatic KV sizing for the NVFP4 worker pool", () => {
    const store = SqliteStore.memory();
    try {
      const current = createNInferPlaybook(runtime).recipes.find((recipe) => recipe.id === QWEN38_NVFP4_RECIPE_ID)!;
      store.upsertRecipe({
        ...current,
        configuration: { ...current.configuration, kvCapacity: "auto" },
      });

      reconcileNInferConfiguration(store, runtime);

      expect(store.listRecipes().find((recipe) => recipe.id === QWEN38_NVFP4_RECIPE_ID)).toMatchObject({
        configuration: { maxContext: 131_072, kvCapacity: 131_072, maxConcurrency: 3 },
      });
    } finally {
      store.close();
    }
  });

  it("removes the retired Qwen 3.6 27B recipe and migrates its route to 35B", () => {
    const store = SqliteStore.memory();
    try {
      const replacement = createNInferPlaybook(runtime).recipes.find((recipe) => recipe.id === QWEN36_35B_RECIPE_ID)!;
      store.upsertRecipe({ ...replacement, id: "qwen36-27b-mtp3-100k", modelId: "qwen3.6-27b" });
      store.upsertRoute({ id: "default", displayName: "Local", recipeId: "qwen36-27b-mtp3-100k", enabled: true, isDefault: true });

      reconcileNInferConfiguration(store, runtime);

      expect(store.listRoutes().find((route) => route.id === "default")?.recipeId).toBe(QWEN36_35B_RECIPE_ID);
      expect(store.listRecipes().some((recipe) => recipe.id === "qwen36-27b-mtp3-100k")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("migrates the retired Qwen route and removes every legacy allocation field", () => {
    const store = SqliteStore.memory();
    try {
      const current = createNInferPlaybook(runtime).recipes[0]!;
      store.upsertRecipe({
        ...current,
        id: "qwen38-27b-mtp3-16k-vision-c2",
        contextTokens: 16_384,
        capabilities: { ...current.capabilities, maxConcurrentGenerations: 2 },
        configuration: {
          ...current.configuration,
          maxContext: 16_384,
          kvCapacity: 150_000,
          kvHeadroomMiB: 800,
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

      const recipe = store.listRecipes().find((candidate) => candidate.id === QWEN38_GROUPWISE_RECIPE_ID);
      expect(recipe).toMatchObject({
        contextTokens: 262_144,
        capabilities: { maxConcurrentGenerations: 1 },
        configuration: {
          maxContext: 131_072,
          kvCapacity: "auto",
          maxConcurrency: 1,
          kvDtype: "bf16",
        },
      });
      expect(recipe).not.toHaveProperty("agentTopology");
      expect(recipe?.configuration).not.toHaveProperty("workerContextTokens");
      expect(recipe?.configuration).not.toHaveProperty("maxLocalWorkers");
      expect(recipe?.configuration).not.toHaveProperty("kvHeadroomMiB");
      expect(store.listRoutes().find((route) => route.id === "default")?.recipeId).toBe(QWEN38_GROUPWISE_RECIPE_ID);
      expect(store.listRecipes().some((candidate) => candidate.id === "qwen38-27b-mtp3-16k-vision-c2")).toBe(false);
    } finally {
      store.close();
    }
  });
});
