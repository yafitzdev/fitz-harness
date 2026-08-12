import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouteResolver } from "@fitz/inference-core";
import { SqliteStore } from "@fitz/storage";
import { managedLinuxRuntimeLayout } from "./managed-linux-runtime.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { VllmModelReconciler } from "./vllm-reconcile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("vLLM model reconciliation", () => {
  it("materializes registered runtime payloads as managed Linux recipes", () => {
    const { store, paths, layout } = fixture();
    writeRegistration(paths.modelRoot, qwenRegistration(layout.modelRoot));
    const reconciler = new VllmModelReconciler(store, paths, layout, { runtimePathExists: () => true });

    expect(reconciler.reconcile()).toEqual({ registered: ["qwen3.6-35b-a3b-nvfp4"], unregistered: [] });
    expect(store.getEngine("vllm")).toEqual(expect.objectContaining({
      displayName: "vLLM", runtime: "linux-managed", runtimeId: "inference-linux",
    }));
    expect(store.listRecipes()).toEqual([expect.objectContaining({
      id: "qwen3.6-35b-a3b-nvfp4",
      playbookId: "vllm",
      modelId: "qwen3.6-35b-a3b-nvfp4",
      contextTokens: 32_768,
      capabilities: expect.objectContaining({ toolCalls: true, maxConcurrentGenerations: 1 }),
      configuration: expect.objectContaining({
        runtime: "linux-managed",
        runtimeId: "inference-linux",
        command: `${layout.environmentRoot}/vllm/bin/vllm`,
        readinessTimeoutMs: 900_000,
        environment: {
          VLLM_HOST_IP: "127.0.0.1",
          INSTANTTENSOR_BACKEND: "BUFFERED",
          VLLM_ENABLE_STARTUP_PLAN: "1",
        },
      }),
    })]);
    const args = store.listRecipes()[0]!.configuration.args as string[];
    expect(args).toEqual(expect.arrayContaining([
      "--load-format", "instanttensor", "--language-model-only", "--skip-mm-profiling",
      "--mm-processor-cache-gb", "0", "--max-num-seqs", "1", "--max-num-batched-tokens", "2048",
      "-O2", "--tool-call-parser", "qwen3_xml", "--reasoning-parser", "qwen3",
    ]));
    expect(store.listRoutes()).toEqual([]);
    store.close();
  });

  it("removes the live recipe and its routes when the payload disappears while retaining registration", () => {
    const { store, paths, layout } = fixture();
    writeRegistration(paths.modelRoot, qwenRegistration(layout.modelRoot));
    let payloadPresent = true;
    const reconciler = new VllmModelReconciler(store, paths, layout, {
      runtimePathExists: (path, kind) => kind === "executable" || (payloadPresent && path.endsWith("/qwen")),
    });
    reconciler.reconcile();
    store.upsertRoute({ id: "research", displayName: "Research", recipeId: "qwen3.6-35b-a3b-nvfp4", enabled: true });
    const routes = new RouteResolver(store.listRoutes(), store.listRecipes());

    payloadPresent = false;
    expect(reconciler.reconcile(routes)).toEqual({ registered: [], unregistered: ["qwen3.6-35b-a3b-nvfp4"] });
    expect(store.listRecipes()).toEqual([]);
    expect(store.listRoutes()).toEqual([]);
    expect(store.getEngine("vllm")).toBeUndefined();
    expect(() => routes.resolve("research")).toThrow();
    expect(() => routes.resolveRecipe("qwen3.6-35b-a3b-nvfp4")).toThrow();
    store.close();
  });

  it("ignores registrations without an explicit recipe or outside the managed vLLM model root", () => {
    const { store, paths, layout } = fixture();
    const missingRecipe = qwenRegistration(layout.modelRoot) as Record<string, unknown>;
    delete missingRecipe.recipe;
    writeRegistration(paths.modelRoot, missingRecipe, "missing-recipe.json");
    writeRegistration(paths.modelRoot, {
      ...qwenRegistration(layout.modelRoot),
      id: "escape",
      payload: { backend: "runtime-filesystem", runtimeId: layout.id, path: `${layout.modelRoot}/elsewhere` },
      recipe: { ...(qwenRegistration(layout.modelRoot).recipe as object), id: "escape" },
    }, "escape.json");

    expect(new VllmModelReconciler(store, paths, layout, { runtimePathExists: () => true }).reconcile())
      .toEqual({ registered: [], unregistered: [] });
    expect(store.listRecipes()).toEqual([]);
    store.close();
  });

  it("refreshes the managed launch contract while preserving a user rename", () => {
    const { store, paths, layout } = fixture();
    writeRegistration(paths.modelRoot, qwenRegistration(layout.modelRoot));
    const reconciler = new VllmModelReconciler(store, paths, layout, { runtimePathExists: () => true });
    reconciler.reconcile();
    const recipe = store.listRecipes()[0]!;
    store.upsertRecipe({ ...recipe, displayName: "My worker", configuration: { ...recipe.configuration, command: "/stale/vllm" } });

    expect(reconciler.reconcile()).toEqual({ registered: [], unregistered: [] });
    expect(store.listRecipes()[0]).toEqual(expect.objectContaining({
      displayName: "My worker",
      configuration: expect.objectContaining({ command: `${layout.environmentRoot}/vllm/bin/vllm` }),
    }));
    store.close();
  });

  it("materializes recipes without creating or mutating text routes", () => {
    const { store, paths, layout } = fixture();
    store.upsertRecipe(externalRecipe());
    store.upsertRoute({ id: "research", displayName: "Research", recipeId: "cloud-worker", enabled: true });
    writeRegistration(paths.modelRoot, qwenRegistration(layout.modelRoot));

    new VllmModelReconciler(store, paths, layout, { runtimePathExists: () => true }).reconcile();

    expect(store.listRoutes()).toEqual([expect.objectContaining({ id: "research", recipeId: "cloud-worker" })]);
    store.close();
  });

  it("leaves unrelated routes intact when no vLLM registrations exist", () => {
    const { store, paths, layout } = fixture();
    store.upsertRecipe(externalRecipe());
    store.upsertRoute({ id: "research", displayName: "Research", recipeId: "cloud-worker", enabled: true });

    expect(new VllmModelReconciler(store, paths, layout, { runtimePathExists: () => false }).reconcile())
      .toEqual({ registered: [], unregistered: [] });
    expect(store.listRoutes()).toContainEqual(expect.objectContaining({ id: "research", recipeId: "cloud-worker" }));
    store.close();
  });
});

function externalRecipe() {
  return {
    id: "cloud-worker",
    playbookId: "consumer-cloud",
    displayName: "Cloud worker",
    adapter: "openai-compatible",
    modelId: "worker-model",
    contextTokens: 131_072,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 8 },
    lifecycle: { loadPolicy: "onDemand" as const, evictionPolicy: "never" as const, idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: { baseUrl: "https://example.test/v1", healthPath: "/models" },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fitz-vllm-reconcile-")); roots.push(root);
  const paths = resolveRuntimePaths({ FITZ_DATA_ROOT: join(root, "data"), FITZ_LLM_ROOT: join(root, "llm") });
  return { store: SqliteStore.memory(), paths, layout: managedLinuxRuntimeLayout(paths) };
}

function writeRegistration(modelRoot: string, value: unknown, name = "qwen.json"): void {
  const root = join(modelRoot, "vllm");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name), JSON.stringify(value));
}

function qwenRegistration(modelRoot: string) {
  return {
    schemaVersion: 1,
    id: "qwen3.6-35b-a3b-nvfp4",
    engine: "vllm",
    format: "safetensors-nvfp4",
    source: { repoId: "nvidia/Qwen", revision: "a" },
    payload: { backend: "runtime-filesystem", runtimeId: "inference-linux", path: `${modelRoot}/vllm/qwen` },
    recipe: {
      id: "qwen3.6-35b-a3b-nvfp4",
      displayName: "Qwen 3.6",
      modelId: "qwen3.6-35b-a3b-nvfp4",
      contextTokens: 32_768,
      optimizationLevel: 2,
      serving: {
        loadFormat: "instanttensor",
        instantTensorBackend: "buffered",
        languageModelOnly: true,
        skipMmProfiling: true,
        mmProcessorCacheGb: 0,
        maxNumBatchedTokens: 2_048,
        persistStartupPlan: true,
      },
      toolCallParser: "qwen3_xml",
      reasoningParser: "qwen3",
    },
    files: 1,
    bytes: 1,
    sha256: "a".repeat(64),
  };
}
