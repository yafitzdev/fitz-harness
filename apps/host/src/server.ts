import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NInferEngineAdapter } from "@fitz/engine-ninfer";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { OpenAICompatibleEngineAdapter } from "@fitz/engine-openai-compatible";
import { LlamaCppEngineAdapter } from "@fitz/engine-llama-cpp";
import type { Recipe, Route } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { createHost } from "./create-app.js";
import { PiAgentRuntime } from "@fitz/agent-pi";
import { createNInferPlaybook, NINFER_PLAYBOOK_ID } from "./ninfer-playbook.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDataPath = resolve(moduleDirectory, "../../../data/fitz.db");
const databasePath = process.env.FITZ_DATABASE_PATH ?? defaultDataPath;
const host = process.env.FITZ_HOST ?? "127.0.0.1";
const port = parsePort(process.env.FITZ_PORT ?? "8787");
const engineMode = process.env.FITZ_ENGINE_MODE ?? "ninfer";
const reserveVramMiB = parseNonNegativeInteger(
  process.env.FITZ_RESERVE_VRAM_MIB ?? "2048",
  "FITZ_RESERVE_VRAM_MIB",
);
const authMode = process.env.FITZ_AUTH_MODE === "required" ? "required" : "disabled";

mkdirSync(dirname(databasePath), { recursive: true });
const engineOptions = engineModeOptions(engineMode);
const store = new SqliteStore(databasePath);
if (engineMode === "ninfer") reconcileNInferConfiguration(store);
const runtime = createHost({
  store,
  logger: true,
  resourcePolicy: { reserveVramMiB },
  authMode,
  ...(authMode === "required" ? { authPepper: requiredEnvironment("FITZ_AUTH_PEPPER") } : {}),
  ...engineOptions,
  ...(process.env.FITZ_ADMIN_TOKEN ? { adminToken: process.env.FITZ_ADMIN_TOKEN } : {}),
  ...(process.env.FITZ_AGENT_RUNTIME === "pi" ? { agentRuntime: new PiAgentRuntime({ cwd: process.env.FITZ_AGENT_CWD ?? process.cwd() }) } : {}),
});

if (authMode === "required" && runtime.store.listUsers().length === 0) {
  const bootstrapToken = requiredEnvironment("FITZ_BOOTSTRAP_ADMIN_TOKEN");
  const administrator = runtime.security!.createUser("Bootstrap Administrator", "administrator");
  runtime.security!.issueDevice(administrator.id, "Bootstrap Device", bootstrapToken);
  runtime.security!.audit("security.bootstrapped", administrator.id, "user", administrator.id);
}

await runtime.app.listen({ host, port });

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid FITZ_PORT: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function requiredEnvironment(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

function ninferOptions() {
  const playbook = createNInferPlaybook();
  const wslDistribution = process.env.FITZ_NINFER_WSL_DISTRIBUTION ?? (process.platform === "win32" ? "Ubuntu" : undefined);
  const adapter = new NInferEngineAdapter({ ...(wslDistribution ? { wslDistribution, wslUser: process.env.FITZ_NINFER_WSL_USER ?? "root" } : {}) });
  return { adapters: [adapter, new LlamaCppEngineAdapter(), new OpenAICompatibleEngineAdapter()], initialRecipes: playbook.recipes, initialRoutes: playbook.routes };
}

function reconcileNInferConfiguration(store: SqliteStore): void {
  for (const recipe of store.listRecipes()) {
    if (recipe.playbookId === "ninfer-qwen36") store.upsertRecipe({ ...recipe, playbookId: NINFER_PLAYBOOK_ID });
  }
  const templates = createNInferPlaybook().routes;
  const existingRoutes = store.listRoutes();
  const existingById = new Map(existingRoutes.map((route) => [route.id, route]));
  const legacyDefault = existingById.get("default-agent");
  const recipeIds = new Set([...store.listRecipes(), ...createNInferPlaybook().recipes].map((recipe) => recipe.id));
  for (const route of existingRoutes) {
    if (!templates.some((template) => template.id === route.id)) store.deleteRoute(route.id);
  }
  for (const template of templates) {
    const existing = existingById.get(template.id) ?? (template.id === "default" ? legacyDefault : undefined);
    const recipeId = existing && recipeIds.has(existing.recipeId) ? existing.recipeId : template.recipeId;
    store.upsertRoute({ ...template, recipeId });
  }
}

function engineModeOptions(mode: string) {
  if (mode === "fake") {
    return {
      fakeAdapter: new FakeEngineAdapter({
        loadDelayMs: parseNonNegativeInteger(process.env.FITZ_FAKE_LOAD_DELAY_MS ?? "0", "FITZ_FAKE_LOAD_DELAY_MS"),
        tokenDelayMs: parseNonNegativeInteger(process.env.FITZ_FAKE_TOKEN_DELAY_MS ?? "0", "FITZ_FAKE_TOKEN_DELAY_MS"),
      }),
    };
  }
  if (mode === "ninfer") return ninferOptions();
  if (mode === "openai-compatible") {
    const recipe = engineRecipe("openai-compatible", {
      baseUrl: requiredEnvironment("FITZ_OPENAI_BASE_URL"),
      ...(process.env.FITZ_OPENAI_API_KEY_ENV ? { apiKeyEnv: process.env.FITZ_OPENAI_API_KEY_ENV } : {}),
      ...(process.env.FITZ_OPENAI_ALLOW_INSECURE_REMOTE === "true" ? { allowInsecureRemote: true } : {}),
    });
    return singleEngineOptions(new OpenAICompatibleEngineAdapter(), recipe);
  }
  if (mode === "llama-cpp") {
    const recipe = engineRecipe("llama-cpp", {
      executable: requiredEnvironment("FITZ_LLAMA_CPP_EXECUTABLE"),
      modelPath: requiredEnvironment("FITZ_LLAMA_CPP_MODEL"),
      contextTokens: parsePositiveInteger(process.env.FITZ_MODEL_CONTEXT_TOKENS ?? "32768", "FITZ_MODEL_CONTEXT_TOKENS"),
      ...(process.env.FITZ_LLAMA_CPP_GPU_LAYERS ? { gpuLayers: parseNonNegativeInteger(process.env.FITZ_LLAMA_CPP_GPU_LAYERS, "FITZ_LLAMA_CPP_GPU_LAYERS") } : {}),
    });
    return singleEngineOptions(new LlamaCppEngineAdapter(), recipe);
  }
  throw new Error(`Unsupported FITZ_ENGINE_MODE: ${mode}`);
}

function engineRecipe(adapter: "openai-compatible" | "llama-cpp", configuration: Record<string, unknown>): Recipe {
  const modelId = process.env.FITZ_MODEL_ID ?? "local-model";
  const contextTokens = parsePositiveInteger(process.env.FITZ_MODEL_CONTEXT_TOKENS ?? "32768", "FITZ_MODEL_CONTEXT_TOKENS");
  return {
    id: `${adapter}-default`, playbookId: adapter, displayName: modelId, adapter, modelId, contextTokens,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: adapter === "openai-compatible" ? "never" : "idle-ttl", idleTtlSeconds: 60, minimumResidencySeconds: 0 },
    configuration,
  };
}

function singleEngineOptions(adapter: NInferEngineAdapter | OpenAICompatibleEngineAdapter | LlamaCppEngineAdapter, recipe: Recipe) {
  const route: Route = { id: "default", displayName: "Default", recipeId: recipe.id, enabled: true, isDefault: true };
  return { adapters: [adapter], initialRecipes: [recipe], initialRoutes: [route] };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}
