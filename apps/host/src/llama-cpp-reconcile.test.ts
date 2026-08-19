import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import type { Recipe } from "@fitz/protocol";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { LlamaCppModelReconciler } from "./llama-cpp-reconcile.js";
import { managedLinuxRuntimeLayout } from "./managed-linux-runtime.js";

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
      contextTokens: 131_072,
      capabilities: expect.objectContaining({ maxConcurrentGenerations: 3 }),
    })]);
    expect(store.listRecipes()[0]!.lifecycle).toMatchObject({ evictionPolicy: "never", idleTtlSeconds: 0 });
    expect(store.listRecipes()[0]!.configuration.args).toContain("/opt/fitz/llm/models/gguf/org/repo/mmproj-Model-BF16.gguf");
    expect(store.listRecipes()[0]!.configuration).toMatchObject({ runtime: "linux-managed", runtimeId: "inference-linux" });
    expect(store.listRecipes()[0]!.configuration.args).toEqual(expect.arrayContaining(["--parallel", "3", "--ctx-size", "131072", "--kv-unified", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]));

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
    expect(store.listRecipes()[0]!.configuration.args).toEqual(expect.arrayContaining(["--parallel", "3", "--ctx-size", "131072", "--kv-unified", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]));
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

  it("links a compatible DFlash artifact to its target and keeps the drafter out of the recipe catalog", () => {
    const { store, paths } = fixture();
    installDflash2Runtime(paths);
    const model = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-Q5_K_S.gguf");
    const drafter = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-DFlash2-Q4_K_M.gguf");
    mkdirSync(dirname(model), { recursive: true }); writeFileSync(model, "target"); writeFileSync(drafter, "drafter");

    const reconciler = new LlamaCppModelReconciler(store, paths);
    expect(reconciler.listDrafterCandidates()).toEqual([expect.objectContaining({ modelId: "Qwen3.8-27B-DFlash2-Q4_K_M" })]);
    const result = reconciler.reconcile();
    expect(result.registered).toHaveLength(1);
    const recipes = store.listRecipes();
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toMatchObject({
      modelId: "Qwen3.8-27B-Q5_K_S",
      speculativeDecoding: {
        strategy: "draft-dflash",
        drafter: { modelId: "Qwen3.8-27B-DFlash2-Q4_K_M", path: "/opt/fitz/llm/models/gguf/qwen/Qwen3.8-27B-DFlash2-Q4_K_M.gguf" },
        maxDraftTokens: 4,
        gpuLayers: "all",
        source: "auto",
      },
    });
    expect(recipes[0]!.configuration.args).not.toContain("--model-draft");
    expect(recipes[0]!.configuration.command).toBe("./build-linux-cuda-dflash2/bin/llama-server");
    expect(readdirSync(join(paths.ggufModelRoot, ".fitz"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))).toHaveLength(1);
    store.close();
  });

  it("prefers built-in MTP heads without inventing a drafter relationship", () => {
    const { store, paths } = fixture();
    installDflash2Runtime(paths);
    const model = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-Q5_K_S.gguf");
    const drafter = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-DFlash2-Q4_K_M.gguf");
    mkdirSync(dirname(model), { recursive: true });
    writeFileSync(model, ggufWithTensor("blk.64.nextn.eh_proj.weight"));
    writeFileSync(drafter, "drafter");

    new LlamaCppModelReconciler(store, paths).reconcile();

    expect(store.listRecipes()).toEqual([expect.objectContaining({
      contextTokens: 98_304,
      speculativeDecoding: { strategy: "draft-mtp", maxDraftTokens: 4, gpuLayers: "all", source: "auto" },
      configuration: expect.objectContaining({ command: "./build-linux-cuda-dflash2/bin/llama-server" }),
    })]);
    expect(store.listRecipes()[0]!.configuration.args).toEqual(expect.arrayContaining([
      "--ctx-size", "98304", "--cache-type-k", "bf16", "--cache-type-v", "bf16",
    ]));
    expect(store.listRecipes()[0]!.configuration.preloadPaths).not.toContain(expect.stringContaining("DFlash2"));
    store.close();
  });

  it("does not auto-enable DFlash when the matching runtime is unavailable", () => {
    const { store, paths } = fixture();
    const model = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-Q5_K_S.gguf");
    const drafter = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-DFlash2-Q4_K_M.gguf");
    mkdirSync(dirname(model), { recursive: true }); writeFileSync(model, "target"); writeFileSync(drafter, "drafter");

    new LlamaCppModelReconciler(store, paths).reconcile();

    expect(store.listRecipes()[0]).not.toHaveProperty("speculativeDecoding");
    expect(store.listRecipes()[0]!.configuration.command).toBe("./build-linux-cuda/bin/llama-server");
    store.close();
  });

  it("retires stale standalone DFlash registrations written by older builds", () => {
    const { store, paths } = fixture();
    const model = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-Q5_K_S.gguf");
    const drafter = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-DFlash2-Q4_K_M.gguf");
    mkdirSync(dirname(model), { recursive: true }); writeFileSync(model, "target"); writeFileSync(drafter, "drafter");
    const stale = recipe("stale-dflash", "/opt/fitz/llm/models/gguf/qwen/Qwen3.8-27B-DFlash2-Q4_K_M.gguf");
    store.upsertRecipe(stale);
    const runtime = managedLinuxRuntimeLayout(paths);
    const registrationRoot = join(paths.ggufModelRoot, ".fitz"); mkdirSync(registrationRoot, { recursive: true });
    writeFileSync(join(registrationRoot, "stale-dflash.json"), JSON.stringify({
      schemaVersion: 1, id: "stale-dflash", engine: "llama.cpp", format: "gguf",
      payload: { backend: "runtime-filesystem", runtimeId: runtime.id, path: stale.configuration.args[1] }, recipe: stale,
    }));

    const result = new LlamaCppModelReconciler(store, paths).reconcile();
    expect(result.unregistered).toContain("stale-dflash");
    expect(store.listRecipes().some((candidate) => candidate.id === "stale-dflash")).toBe(false);
    expect(existsRegistration(paths.ggufModelRoot, "stale-dflash")).toBe(false);
    expect(store.listRecipes()).toHaveLength(1);
    store.close();
  });

  it("does not resurrect a drafter after the target recipe explicitly disables it", () => {
    const { store, paths } = fixture();
    installDflash2Runtime(paths);
    const model = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-Q5_K_S.gguf");
    const drafter = join(paths.ggufModelRoot, "qwen", "Qwen3.8-27B-DFlash2-Q4_K_M.gguf");
    mkdirSync(dirname(model), { recursive: true }); writeFileSync(model, "target"); writeFileSync(drafter, "drafter");
    const reconciler = new LlamaCppModelReconciler(store, paths);
    reconciler.reconcile();
    const current = store.listRecipes()[0]!;
    store.upsertRecipe({ ...current, speculativeDecoding: null });

    reconciler.reconcile();
    expect(store.listRecipes()[0]).toHaveProperty("speculativeDecoding", null);
    expect(store.listRecipes()[0]!.configuration.args).not.toContain("--model-draft");
    reconciler.reconcile();
    expect(store.listRecipes()[0]).toHaveProperty("speculativeDecoding", null);
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

function installDflash2Runtime(paths: ReturnType<typeof resolveRuntimePaths>): void {
  const executable = join(paths.engineRoot, "llama.cpp", "build-linux-cuda-dflash2", "bin", "llama-server");
  mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, "fixture");
}

function ggufWithTensor(name: string): Buffer {
  const u32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };
  const u64 = (value: number) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; };
  const string = (value: string) => { const bytes = Buffer.from(value); return Buffer.concat([u64(bytes.length), bytes]); };
  return Buffer.concat([
    Buffer.from("GGUF"), u32(3), u64(1), u64(0),
    string(name), u32(1), u64(1), u32(0), u64(0),
  ]);
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
