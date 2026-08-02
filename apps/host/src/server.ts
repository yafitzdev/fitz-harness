import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NInferEngineAdapter } from "@fitz/engine-ninfer";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { ManagedOpenAIEngineAdapter, OpenAICompatibleEngineAdapter } from "@fitz/engine-openai-compatible";
import { LlamaCppEngineAdapter } from "@fitz/engine-llama-cpp";
import type { Recipe, Route } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { createHost } from "./create-app.js";
import { PiAgentRuntime } from "@fitz/agent-pi";
import { createNInferPlaybook, NINFER_PLAYBOOK_ID } from "./ninfer-playbook.js";
import { createToolApprovalRequester } from "./tool-approval-gate.js";

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
const agentRuntimeMode = process.env.FITZ_AGENT_RUNTIME ?? "pi";

mkdirSync(dirname(databasePath), { recursive: true });
const engineOptions = engineModeOptions(engineMode);
const store = new SqliteStore(databasePath);
if (engineMode === "ninfer") reconcileNInferConfiguration(store);
const runtime = createHost({
  store,
  logger: true,
  resourcePolicy: { reserveVramMiB },
  authMode,
  localPort: port,
  ...(authMode === "required" ? { authPepper: requiredEnvironment("FITZ_AUTH_PEPPER") } : {}),
  ...engineOptions,
  ...(process.env.FITZ_ADMIN_TOKEN ? { adminToken: process.env.FITZ_ADMIN_TOKEN } : {}),
  ...(agentRuntimeMode === "pi" ? {
    agentRuntime: new PiAgentRuntime({
      baseUrl: process.env.FITZ_AGENT_BASE_URL ?? `http://127.0.0.1:${port}/v1`,
      cwd: (request) => {
        if (process.env.FITZ_AGENT_CWD) return process.env.FITZ_AGENT_CWD;
        const session = request.sessionId ? store.getSession(request.sessionId) : undefined;
        const project = session ? store.getProject(session.projectId) : undefined;
        return project?.rootPath ?? process.cwd();
      },
      requestToolApproval: createToolApprovalRequester(store),
    }),
  } : {}),
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
  return { adapters: [adapter, new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter()], initialRecipes: playbook.recipes, initialRoutes: playbook.routes };
}

function reconcileNInferConfiguration(store: SqliteStore): void {
  const playbook = createNInferPlaybook();
  const templatesById = new Map(playbook.recipes.map((recipe) => [recipe.id, recipe]));
  for (const recipe of store.listRecipes()) {
    const template = templatesById.get(recipe.id);
    const migratedPlaybookId = recipe.playbookId === "ninfer-qwen36" ? NINFER_PLAYBOOK_ID : recipe.playbookId;
    const migratedLifecycle = template && recipe.lifecycle.evictionPolicy === "idle-ttl" && recipe.lifecycle.idleTtlSeconds === 60
      ? { ...recipe.lifecycle, idleTtlSeconds: template.lifecycle.idleTtlSeconds }
      : recipe.lifecycle;
    const migratedCapabilities = template && !recipe.capabilities.toolCalls
      ? { ...recipe.capabilities, toolCalls: true }
      : recipe.capabilities;
    if (migratedPlaybookId !== recipe.playbookId || migratedLifecycle !== recipe.lifecycle || migratedCapabilities !== recipe.capabilities) {
      store.upsertRecipe({ ...recipe, playbookId: migratedPlaybookId, lifecycle: migratedLifecycle, capabilities: migratedCapabilities });
    }
  }
  const templates = playbook.routes;
  const existingRoutes = store.listRoutes();
  const existingById = new Map(existingRoutes.map((route) => [route.id, route]));
  const legacyDefault = existingById.get("default-agent");
  const recipeIds = new Set([...store.listRecipes(), ...playbook.recipes].map((recipe) => recipe.id));
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
    const fakeAdapter = new FakeEngineAdapter({
      loadDelayMs: parseNonNegativeInteger(process.env.FITZ_FAKE_LOAD_DELAY_MS ?? "0", "FITZ_FAKE_LOAD_DELAY_MS"),
      tokenDelayMs: parseNonNegativeInteger(process.env.FITZ_FAKE_TOKEN_DELAY_MS ?? "0", "FITZ_FAKE_TOKEN_DELAY_MS"),
    });
    return {
      fakeAdapter,
      adapters: [fakeAdapter, new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter()],
    };
  }
  if (mode === "ninfer") return ninferOptions();
  if (mode === "openai-compatible") {
    const recipe = engineRecipe("openai-compatible", {
      baseUrl: requiredEnvironment("FITZ_OPENAI_BASE_URL"),
      ...(process.env.FITZ_OPENAI_API_KEY_ENV ? { apiKeyEnv: process.env.FITZ_OPENAI_API_KEY_ENV } : {}),
      ...(process.env.FITZ_OPENAI_ALLOW_INSECURE_REMOTE === "true" ? { allowInsecureRemote: true } : {}),
    });
    return singleEngineOptions([new OpenAICompatibleEngineAdapter(), new ManagedOpenAIEngineAdapter()], recipe);
  }
  if (mode === "llama-cpp") {
    const recipe = engineRecipe("llama-cpp", {
      executable: requiredEnvironment("FITZ_LLAMA_CPP_EXECUTABLE"),
      modelPath: requiredEnvironment("FITZ_LLAMA_CPP_MODEL"),
      contextTokens: parsePositiveInteger(process.env.FITZ_MODEL_CONTEXT_TOKENS ?? "32768", "FITZ_MODEL_CONTEXT_TOKENS"),
      ...(process.env.FITZ_LLAMA_CPP_GPU_LAYERS ? { gpuLayers: parseNonNegativeInteger(process.env.FITZ_LLAMA_CPP_GPU_LAYERS, "FITZ_LLAMA_CPP_GPU_LAYERS") } : {}),
    });
    return singleEngineOptions([new LlamaCppEngineAdapter(), new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter()], recipe);
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

function singleEngineOptions(adapters: Array<NInferEngineAdapter | OpenAICompatibleEngineAdapter | ManagedOpenAIEngineAdapter | LlamaCppEngineAdapter>, recipe: Recipe) {
  const route: Route = { id: "default", displayName: "Default", recipeId: recipe.id, enabled: true, isDefault: true };
  return { adapters, initialRecipes: [recipe], initialRoutes: [route] };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}
