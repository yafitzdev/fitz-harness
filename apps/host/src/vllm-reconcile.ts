import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { posix } from "node:path";
import type { RouteResolver } from "@fitz/inference-core";
import type { Recipe } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";
import type { ManagedLinuxRuntimeLayout } from "./managed-linux-runtime.js";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { withLocalAgentCapacity } from "./local-agent-capacity.js";

export const VLLM_PLAYBOOK_ID = "vllm";

interface VllmRecipeRegistration {
  id: string;
  displayName: string;
  modelId: string;
  contextTokens: number;
  optimizationLevel: 0 | 1 | 2 | 3;
  serving: {
    loadFormat: "instanttensor";
    instantTensorBackend: "buffered";
    languageModelOnly: boolean;
    skipMmProfiling: boolean;
    mmProcessorCacheGb: number;
    maxNumBatchedTokens: number;
    persistStartupPlan: boolean;
  };
  toolCallParser?: string;
  reasoningParser?: string;
}

interface VllmModelRegistration {
  schemaVersion: 1;
  id: string;
  engine: "vllm";
  format: "safetensors-nvfp4";
  source: { repoId: string; revision: string };
  payload: { backend: "runtime-filesystem"; runtimeId: string; path: string };
  recipe: VllmRecipeRegistration;
  files: number;
  bytes: number;
  sha256: string;
}

export interface VllmReconcileResult {
  registered: string[];
  unregistered: string[];
}

type RuntimePathExists = (path: string, kind: "directory" | "executable") => boolean;

/** Materializes vLLM recipes from the persistent host registry when their
 * runtime-resident payloads exist. Registration records survive payload
 * removal; SQLite and RouteResolver contain only currently runnable recipes. */
export class VllmModelReconciler {
  readonly #store: SqliteStore;
  readonly #layout: ManagedLinuxRuntimeLayout;
  readonly #registrationRoot: string;
  readonly #runtimePathExists: RuntimePathExists;

  constructor(
    store: SqliteStore,
    paths: FitzRuntimePaths,
    layout: ManagedLinuxRuntimeLayout,
    options: { runtimePathExists?: RuntimePathExists } = {},
  ) {
    this.#store = store;
    this.#layout = layout;
    this.#registrationRoot = resolve(join(paths.modelRoot, VLLM_PLAYBOOK_ID));
    this.#runtimePathExists = options.runtimePathExists ?? ((path, kind) => runtimePathExists(layout, path, kind));
  }

  reconcile(routes?: RouteResolver): VllmReconcileResult {
    mkdirSync(this.#registrationRoot, { recursive: true });
    const registrations = this.#readRegistrations();
    if (registrations.size === 0) return this.#removeAll(routes);
    const executable = `${this.#layout.environmentRoot}/vllm/bin/vllm`;
    const engineAvailable = this.#runtimePathExists(executable, "executable");
    const runnable = new Map<string, VllmModelRegistration>();
    if (engineAvailable) {
      for (const registration of registrations.values()) {
        if (this.#runtimePathExists(registration.payload.path, "directory")) runnable.set(registration.recipe.id, registration);
      }
    }

    const registered: string[] = [];
    const unregistered: string[] = [];
    const existingRecipes = new Map(this.#store.listRecipes().map((recipe) => [recipe.id, recipe]));

    for (const recipe of existingRecipes.values()) {
      if (recipe.playbookId !== VLLM_PLAYBOOK_ID || runnable.has(recipe.id)) continue;
      this.#dematerialize(recipe.id, routes);
      existingRecipes.delete(recipe.id);
      unregistered.push(recipe.id);
    }

    if (runnable.size === 0) {
      if (this.#store.getEngine(VLLM_PLAYBOOK_ID)) this.#store.deleteEngine(VLLM_PLAYBOOK_ID);
      return { registered, unregistered };
    }

    this.#upsertEngine(executable);
    for (const registration of runnable.values()) {
      const existing = existingRecipes.get(registration.recipe.id);
      const recipe = this.#recipe(registration, executable, existing);
      this.#store.upsertRecipe(recipe);
      routes?.upsertRecipe(recipe);
      if (!existing) registered.push(recipe.id);
    }
    return { registered, unregistered };
  }

  #removeAll(routes?: RouteResolver): VllmReconcileResult {
    const unregistered: string[] = [];
    for (const recipe of this.#store.listRecipes()) {
      if (recipe.playbookId !== VLLM_PLAYBOOK_ID) continue;
      this.#dematerialize(recipe.id, routes);
      unregistered.push(recipe.id);
    }
    if (this.#store.getEngine(VLLM_PLAYBOOK_ID)) this.#store.deleteEngine(VLLM_PLAYBOOK_ID);
    return { registered: [], unregistered };
  }

  #readRegistrations(): Map<string, VllmModelRegistration> {
    const registrations = new Map<string, VllmModelRegistration>();
    for (const entry of readdirSync(this.#registrationRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(readFileSync(join(this.#registrationRoot, entry.name), "utf8")) as unknown;
        if (!validRegistration(value, this.#layout)) continue;
        registrations.set(value.id, value);
      } catch { /* Malformed registrations do not authorize runtime execution. */ }
    }
    return registrations;
  }

  #recipe(registration: VllmModelRegistration, executable: string, existing?: Recipe): Recipe {
    const declared = registration.recipe;
    const serving = declared.serving;
    // Optimization level is registration-owned because vLLM startup/throughput
    // tradeoffs vary materially by model and must not be hidden host defaults.
    // The loader/profile contract is registration-owned for the same reason:
    // ModelOpt NVFP4 checkpoints on consumer Blackwell otherwise spend most of
    // every cold start repacking weights and profiling unused multimodal work.
    const args = [
      "serve", registration.payload.path,
      "--served-model-name", "{model}",
      "--host", "{host}",
      "--port", "{port}",
      "--quantization", "modelopt",
      "--load-format", serving.loadFormat,
      "--max-model-len", "{context}",
      "--max-num-seqs", "1",
      "--max-num-batched-tokens", String(serving.maxNumBatchedTokens),
      "--kv-cache-dtype", "fp8",
      "--gpu-memory-utilization", "0.90",
      "--enable-prefix-caching",
      `-O${declared.optimizationLevel}`,
    ];
    if (serving.languageModelOnly) args.push("--language-model-only");
    if (serving.skipMmProfiling) args.push("--skip-mm-profiling");
    args.push("--mm-processor-cache-gb", String(serving.mmProcessorCacheGb));
    if (declared.toolCallParser) args.push("--enable-auto-tool-choice", "--tool-call-parser", declared.toolCallParser);
    if (declared.reasoningParser) args.push("--reasoning-parser", declared.reasoningParser);
    return withLocalAgentCapacity({
      id: declared.id,
      playbookId: VLLM_PLAYBOOK_ID,
      displayName: existing?.displayName ?? declared.displayName,
      adapter: "openai-managed",
      modelId: declared.modelId,
      contextTokens: declared.contextTokens,
      capabilities: {
        chatCompletions: true,
        streaming: true,
        toolCalls: Boolean(declared.toolCallParser),
        responseFormat: true,
        minP: true,
        maxConcurrentGenerations: 1,
      },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: {
        enginePath: `${this.#layout.engineRoot}/vllm`,
        runtime: "linux-managed",
        runtimeId: this.#layout.id,
        command: executable,
        args,
        workingDirectory: ".",
        healthPath: "/v1/models",
        readinessTimeoutMs: 900_000,
        environment: {
          // The managed engine is single-host. Loopback avoids PyTorch's
          // reverse-DNS timeout against WSL's ephemeral private address.
          VLLM_HOST_IP: "127.0.0.1",
          INSTANTTENSOR_BACKEND: serving.instantTensorBackend.toUpperCase(),
          ...(serving.persistStartupPlan ? { VLLM_ENABLE_STARTUP_PLAN: "1" } : {}),
        },
      },
    }, existing?.agentTopology);
  }

  #upsertEngine(executable: string): void {
    const existing = this.#store.getEngine(VLLM_PLAYBOOK_ID);
    const now = new Date().toISOString();
    this.#store.upsertEngine({
      id: VLLM_PLAYBOOK_ID,
      folderName: VLLM_PLAYBOOK_ID,
      displayName: existing?.displayName ?? "vLLM",
      connectionMode: "managed",
      runtime: "linux-managed",
      runtimeId: this.#layout.id,
      baseUrl: "http://127.0.0.1",
      healthPath: "/v1/models",
      launchCommand: executable,
      launchArguments: ["serve", "{model}", "--host", "{host}", "--port", "{port}"],
      workingDirectory: ".",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  #dematerialize(recipeId: string, routes?: RouteResolver): void {
    for (const route of this.#store.listRoutes().filter((candidate) => candidate.recipeId === recipeId)) {
      this.#store.deleteRoute(route.id);
      routes?.deleteRoute(route.id);
    }
    this.#store.deleteRecipe(recipeId);
    routes?.deleteRecipe(recipeId);
  }
}

function validRegistration(value: unknown, layout: ManagedLinuxRuntimeLayout): value is VllmModelRegistration {
  if (!value || typeof value !== "object") return false;
  const registration = value as Partial<VllmModelRegistration>;
  if (registration.schemaVersion !== 1 || registration.engine !== "vllm" || registration.format !== "safetensors-nvfp4") return false;
  if (!safeId(registration.id) || registration.payload?.backend !== "runtime-filesystem" || registration.payload.runtimeId !== layout.id) return false;
  if (!insideRuntimeModelRoot(registration.payload.path, layout) || !validRecipeRegistration(registration.recipe, registration.id)) return false;
  return typeof registration.source?.repoId === "string"
    && typeof registration.source.revision === "string"
    && positiveInteger(registration.files)
    && typeof registration.bytes === "number" && Number.isSafeInteger(registration.bytes) && registration.bytes > 0
    && typeof registration.sha256 === "string" && /^[a-f0-9]{64}$/i.test(registration.sha256);
}

function validRecipeRegistration(value: VllmRecipeRegistration | undefined, registrationId: string | undefined): value is VllmRecipeRegistration {
  return Boolean(value
    && value.id === registrationId
    && safeId(value.id)
    && typeof value.displayName === "string" && value.displayName.trim()
    && safeId(value.modelId)
    && positiveInteger(value.contextTokens)
    && validOptimizationLevel(value.optimizationLevel)
    && validServingRegistration(value.serving)
    && optionalSafeArgument(value.toolCallParser)
    && optionalSafeArgument(value.reasoningParser));
}

function validServingRegistration(value: VllmRecipeRegistration["serving"] | undefined): value is VllmRecipeRegistration["serving"] {
  return Boolean(value
    && value.loadFormat === "instanttensor"
    && value.instantTensorBackend === "buffered"
    && typeof value.languageModelOnly === "boolean"
    && typeof value.skipMmProfiling === "boolean"
    && typeof value.mmProcessorCacheGb === "number" && Number.isFinite(value.mmProcessorCacheGb) && value.mmProcessorCacheGb >= 0
    && positiveInteger(value.maxNumBatchedTokens)
    && typeof value.persistStartupPlan === "boolean");
}

function insideRuntimeModelRoot(path: unknown, layout: ManagedLinuxRuntimeLayout): path is string {
  if (typeof path !== "string" || !posix.isAbsolute(path)) return false;
  const root = `${layout.modelRoot}/vllm`;
  const child = posix.relative(root, posix.resolve(path));
  return child !== "" && !child.startsWith("..") && !posix.isAbsolute(child);
}

function safeId(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function validOptimizationLevel(value: unknown): value is 0 | 1 | 2 | 3 { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3; }
function optionalSafeArgument(value: unknown): boolean { return value === undefined || (typeof value === "string" && /^[a-z0-9_]+$/i.test(value)); }

function runtimePathExists(layout: ManagedLinuxRuntimeLayout, path: string, kind: "directory" | "executable"): boolean {
  if (process.platform !== "win32") return false;
  const flag = kind === "directory" ? "-d" : "-x";
  const result = spawnSync("wsl.exe", ["-d", layout.distribution, "-u", "root", "--", "test", flag, path], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 15_000,
  });
  return result.status === 0;
}
