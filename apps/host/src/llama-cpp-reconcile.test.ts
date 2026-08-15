import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import type { Recipe } from "@fitz/protocol";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { LlamaCppModelReconciler } from "./llama-cpp-reconcile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("llama.cpp model reconciliation", () => {
  it("unregisters recipes that have no canonical runtime registration", () => {
    const { store, paths } = fixture();
    const missing = join(paths.ggufModelRoot, "org", "model-q4.gguf");
    store.upsertRecipe(recipe("model-q4", missing));

    expect(new LlamaCppModelReconciler(store, paths).reconcile()).toEqual({ registered: [], unregistered: ["model-q4"] });
    expect(store.listRecipes()).toEqual([]);
    expect(existsRegistration(paths.ggufModelRoot, "model-q4")).toBe(false);
    store.close();
  });

  it("auto-registers a new main GGUF and removes it when the payload disappears", () => {
    const { root, store, paths } = fixture();
    const model = join(paths.ggufModelRoot, "org", "repo", "Model-Q5_K_M.gguf");
    const projector = join(dirname(model), "mmproj-Model-BF16.gguf");
    for (const file of [model, projector]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "payload"); }
    const reconciler = new LlamaCppModelReconciler(store, paths);

    const added = reconciler.reconcile();
    expect(added.registered).toHaveLength(1);
    expect(store.listRecipes()).toEqual([expect.objectContaining({
      playbookId: "llama.cpp",
      modelId: "Model-Q5_K_M",
      capabilities: expect.objectContaining({ maxConcurrentGenerations: 3 }),
    })]);
    expect(store.listRecipes()[0]!.lifecycle).toMatchObject({ evictionPolicy: "never", idleTtlSeconds: 0 });
    expect(store.listRecipes()[0]!.configuration.args).toContain("/opt/fitz/llm/models/gguf/org/repo/mmproj-Model-BF16.gguf");
    expect(store.listRecipes()[0]!.configuration).toMatchObject({ runtime: "linux-managed", runtimeId: "inference-linux" });
    expect(store.listRecipes()[0]!.configuration.args).toEqual(expect.arrayContaining(["--parallel", "3", "--ctx-size", "32768"]));

    rmSync(model);
    expect(reconciler.reconcile().unregistered).toEqual(added.registered);
    expect(store.listRecipes()).toEqual([]);
    expect(root).toBeTruthy();
    store.close();
  });

  it("discards legacy worker allocation while preserving a user rename", () => {
    const { store, paths } = fixture();
    const model = join(paths.ggufModelRoot, "org", "repo", "Model-Q5_K_M.gguf");
    mkdirSync(dirname(model), { recursive: true }); writeFileSync(model, "payload");
    const reconciler = new LlamaCppModelReconciler(store, paths);
    reconciler.reconcile();
    const current = store.listRecipes()[0]!;
    store.upsertRecipe({
      ...current,
      displayName: "My llama",
      agentTopology: { sharedContextTokens: 32_768, workers: { count: 1, contextTokens: 8_192 } },
    } as Recipe & { agentTopology: unknown });

    reconciler.reconcile();

    expect(store.listRecipes()[0]).toMatchObject({
      displayName: "My llama",
      capabilities: { maxConcurrentGenerations: 3 },
    });
    expect(store.listRecipes()[0]).not.toHaveProperty("agentTopology");
    expect(store.listRecipes()[0]!.configuration.args).toEqual(expect.arrayContaining(["--parallel", "3", "--ctx-size", "32768"]));
    store.close();
  });

  it("does not register projectors, DFlash drafts, MTP artifacts, or embeddings", () => {
    const { store, paths } = fixture();
    for (const name of ["mmproj-model.gguf", "dflash-kquant.gguf", "model-MTP.gguf", "nomic-embed-text.gguf"]) {
      const file = join(paths.ggufModelRoot, "aux", name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "payload");
    }
    expect(new LlamaCppModelReconciler(store, paths).reconcile()).toEqual({ registered: [], unregistered: [] });
    expect(store.listRecipes()).toEqual([]);
    store.close();
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fitz-llama-reconcile-")); roots.push(root);
  const paths = resolveRuntimePaths({ FITZ_DATA_ROOT: join(root, "data"), FITZ_LLM_ROOT: join(root, "llm") });
  const executable = join(paths.engineRoot, "llama.cpp", "build-linux-cuda", "bin", "llama-server");
  mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, "fixture");
  return { root, paths, store: SqliteStore.memory() };
}

function recipe(id: string, modelPath: string): Recipe {
  return {
    id, playbookId: "llama.cpp", displayName: id, adapter: "openai-managed", modelId: id, contextTokens: 100_000,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: true, minP: true, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: { enginePath: "/opt/fitz/llm/engines/llama.cpp", runtime: "linux-managed", runtimeId: "inference-linux", command: "./server", args: ["--model", modelPath], workingDirectory: ".", healthPath: "/v1/models", readinessTimeoutMs: 30_000 },
  };
}

function existsRegistration(ggufRoot: string, id: string): boolean {
  return existsSync(join(ggufRoot, ".fitz", `${id}.json`));
}
