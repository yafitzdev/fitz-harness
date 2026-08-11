import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NInferEngineAdapter } from "@fitz/engine-ninfer";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { FakeMediaEngineAdapter } from "@fitz/engine-media-fake";
import { ManagedOpenAIEngineAdapter, OpenAICompatibleEngineAdapter } from "@fitz/engine-openai-compatible";
import { LlamaCppEngineAdapter } from "@fitz/engine-llama-cpp";
import { ComfyUIEngineAdapter } from "@fitz/engine-comfyui";
import type { Recipe, Route } from "@fitz/protocol";
import { applyPendingStorageRestore, ArtifactRepository, LocalBlobStore, SqliteStore, StorageDurabilityService } from "@fitz/storage";
import { SecurityService } from "@fitz/security";
import { createHost } from "./create-app.js";
import { createMediaTools } from "./media-tools.js";
import type { MediaJobCoordinator } from "./media-jobs.js";
import { ModelCatalogService } from "./model-catalog.js";
import { PiAgentRuntime, PiPackageService, WorkspaceMutationLeaseManager } from "@fitz/agent-pi";
import { createNInferPlaybook } from "./ninfer-playbook.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";
import { reconcileNInferConfiguration } from "./ninfer-reconcile.js";
import { createToolApprovalRequester } from "./tool-approval-gate.js";
import { createSessionReader } from "./session-reader.js";
import { contextTokensForRoute } from "./route-context.js";
import { WindowsStartupManager } from "@fitz/connectivity";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { AgentSafetyService } from "./agent-safety/index.js";
import { localComfyUIPaths, localComfyUIRecipeIds, reconcileLocalComfyUIConfiguration } from "./comfyui-reconcile.js";
import { ensureComfyUISafeModeExtension } from "./comfyui-safe-mode.js";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import { HostInstanceLock } from "./host-instance-lock.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runtimePaths = resolveRuntimePaths();
const bundledNpmCli = resolve(moduleDirectory, "../node_modules/npm/bin/npm-cli.js");
const npmCliPath = process.env.FITZ_NPM_CLI_PATH ?? (existsSync(bundledNpmCli) ? bundledNpmCli : undefined);
const databasePath = runtimePaths.databasePath;
const host = process.env.FITZ_HOST ?? "127.0.0.1";
const port = parsePort(process.env.FITZ_PORT ?? "8787");
const engineMode = process.env.FITZ_ENGINE_MODE ?? "ninfer";
const reserveVramMiB = parseNonNegativeInteger(
  process.env.FITZ_RESERVE_VRAM_MIB ?? "2048",
  "FITZ_RESERVE_VRAM_MIB",
);
const authMode = process.env.FITZ_AUTH_MODE === "disabled" ? "disabled" : "required";
const agentRuntimeMode = process.env.FITZ_AGENT_RUNTIME ?? "pi";
const agentConcurrency = parsePositiveInteger(process.env.FITZ_AGENT_CONCURRENCY ?? "4", "FITZ_AGENT_CONCURRENCY");
const agentConcurrencyPerOwner = parsePositiveInteger(process.env.FITZ_AGENT_CONCURRENCY_PER_USER ?? "1", "FITZ_AGENT_CONCURRENCY_PER_USER");
const agentBaseUrl = process.env.FITZ_AGENT_BASE_URL ?? `http://127.0.0.1:${port}/v1`;
const internalAgentToken = agentRuntimeMode === "pi" && !process.env.FITZ_AGENT_BASE_URL ? randomBytes(32).toString("base64url") : undefined;

mkdirSync(runtimePaths.dataRoot, { recursive: true });
const hostInstanceLock = HostInstanceLock.acquire(join(runtimePaths.dataRoot, "host.lock"));
const restoredStorage = await applyPendingStorageRestore(runtimePaths);
if (restoredStorage) console.info("Scheduled storage restore applied", restoredStorage);
mkdirSync(dirname(databasePath), { recursive: true });
for (const directory of [runtimePaths.piAgentDir, runtimePaths.logsDir, runtimePaths.cacheDir, runtimePaths.engineRoot, runtimePaths.modelRoot, runtimePaths.snapshotsDir, runtimePaths.artifactsDir, runtimePaths.backupsDir]) mkdirSync(directory, { recursive: true });
ensureComfyUISafeModeExtension(localComfyUIPaths(runtimePaths).baseDir);
const engineOptions = engineModeOptions(engineMode);
const store = new SqliteStore(databasePath);
const artifacts = new ArtifactRepository(store, new LocalBlobStore(runtimePaths.artifactsDir), { quotaBytes: () => store.getSetting<number>("artifactStorageQuotaBytes") });
const artifactRecovery = await artifacts.initialize();
if (artifactRecovery.migrated || artifactRecovery.collected) console.info("Artifact store reconciled", artifactRecovery);
const storageDurability = new StorageDurabilityService(artifacts, runtimePaths);
const storeInitiallyEmpty = store.listRecipes().length === 0;
const authPepper = authMode === "required" ? resolveAuthPepper(store) : undefined;
// One SecurityService shared by HTTP auth, the media coordinator, and the agent media
// tools: in-process submits build device-less principals via `principalForUser` (§5.9).
const security = authPepper ? new SecurityService(store, authPepper) : undefined;
if (engineMode === "ninfer") reconcileNInferConfiguration(store);
// A fresh store is seeded atomically by createHost from engineOptions. Existing
// stores need an additive reconcile because seedDefaults is intentionally
// create-only and must not reset user route assignments.
if (!storeInitiallyEmpty) reconcileLocalComfyUIConfiguration(store, runtimePaths);
enforceModelResidency(store);
// Safety layer: deterministic policy engine (trash-everything deletes, zone blocking),
// per-run workspace snapshots, run trash, and secret redaction. Machine guarantees only.
const safety = new AgentSafetyService({
  store,
  snapshotsDir: runtimePaths.snapshotsDir,
  runtimeDirs: [runtimePaths.piAgentDir, runtimePaths.logsDir, runtimePaths.cacheDir, runtimePaths.engineRoot, runtimePaths.modelRoot, runtimePaths.llmRoot],
});
// Late-bound: the media coordinator is constructed inside createHost, but customTools
// runs per agent run — after host startup — so the closure reads the assigned instance.
let mediaJobs: MediaJobCoordinator | undefined;
const workspaceMutationLeases = new WorkspaceMutationLeaseManager();
const runtime = createHost({
  store,
  artifacts,
  storageDurability,
  logger: true,
  resourcePolicy: { reserveVramMiB },
  authMode,
  safety,
  agentConcurrency,
  agentConcurrencyPerOwner,
  ...(security ? { security } : {}),
  ...(internalAgentToken ? { internalAgentToken } : {}),
  localPort: port,
  startupManager: new WindowsStartupManager(resolve(moduleDirectory, "../start-host.ps1")),
  engineRoot: runtimePaths.engineRoot,
  piPackages: new PiPackageService({
    agentDir: runtimePaths.piAgentDir,
    cwd: process.cwd(),
    ...(npmCliPath ? { npmCommand: [process.execPath, npmCliPath] } : {}),
  }),
  modelCatalog: new ModelCatalogService({
    modelRoot: runtimePaths.modelRoot,
    ...(process.env.FITZ_HF_ENDPOINT ? { endpoint: process.env.FITZ_HF_ENDPOINT } : {}),
  }),
  ...(authPepper ? { authPepper } : {}),
  ...engineOptions,
  ...(process.env.FITZ_ADMIN_TOKEN ? { adminToken: process.env.FITZ_ADMIN_TOKEN } : {}),
  ...(agentRuntimeMode === "pi" ? {
    agentRuntime: new PiAgentRuntime({
      baseUrl: agentBaseUrl,
      apiKey: process.env.FITZ_AGENT_API_KEY ?? internalAgentToken ?? "fitz-local",
      forwardWorkContext: Boolean(internalAgentToken),
      // The pi session's context window must match the recipe the route resolves to
      // (e.g. 131072 for consumer/DeepSeek routes, 100000 for ninfer), not a fixed default.
      contextWindow: (request) => contextTokensForRoute(store, request.model),
      cwd: (request) => {
        if (process.env.FITZ_AGENT_CWD) return process.env.FITZ_AGENT_CWD;
        const session = request.sessionId ? store.getSession(request.sessionId) : undefined;
        const project = session?.projectId ? store.getProject(session.projectId) : undefined;
        return project?.rootPath ?? process.cwd();
      },
      requestToolApproval: createToolApprovalRequester(store),
      sessionReader: createSessionReader(store),
      toolPolicy: safety.createToolEvaluator(),
      toolLease: workspaceMutationLeases.acquire,
      redactToolResult: safety.createResultRedactor(),
      customTools: (context) => [
        ...safety.createCustomTools()(context),
        // Authenticated runs enforce the owner's media quota and route grants.
        // Explicit local auth-disabled mode has no user and follows the existing
        // administrator-diagnostic path used by the management media test.
        ...(mediaJobs ? createMediaTools({ mediaJobs, store, ...(security ? { security } : {}) })(context) : []),
      ],
      agentDir: runtimePaths.piAgentDir,
      llmRoot: runtimePaths.llmRoot,
    }),
  } : {}),
});
mediaJobs = runtime.mediaJobs;
let removeSignalHandlers: () => void = () => undefined;
runtime.app.addHook("onClose", async () => {
  removeSignalHandlers();
  await hostInstanceLock.release();
});
// On a fresh database createHost seeds the complete engine-mode recipe set first;
// reconcile afterward so ComfyUI also gets its Playbooks registration without
// suppressing the normal chat defaults. Pacing is engine-side (the extension
// under data/comfyui), so no host-owned performance mode is set here.
if (storeInitiallyEmpty) reconcileLocalComfyUIConfiguration(store, runtimePaths);
if (storeInitiallyEmpty) enforceModelResidency(store);

await runtime.app.listen({ host, port });
removeSignalHandlers = installGracefulShutdown(
  () => runtime.app.close(),
  { onError: (error) => runtime.app.log.error({ error }, "Graceful shutdown failed") },
);

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

function resolveAuthPepper(store: SqliteStore): string {
  const configured = process.env.FITZ_AUTH_PEPPER?.trim();
  if (configured) return configured;
  const stored = store.getSetting<string>("security.authPepper");
  if (stored) return stored;
  const generated = randomBytes(32).toString("base64url");
  store.setSetting("security.authPepper", generated);
  return generated;
}

function ninferOptions() {
  const playbook = createNInferPlaybook();
  const mediaPlaybook = installedLocalComfyUIPlaybook();
  const wslDistribution = process.env.FITZ_NINFER_WSL_DISTRIBUTION ?? (process.platform === "win32" ? "Ubuntu" : undefined);
  const adapter = new NInferEngineAdapter({ ...(wslDistribution ? { wslDistribution, wslUser: process.env.FITZ_NINFER_WSL_USER ?? "root" } : {}) });
  return {
    adapters: [adapter, new ComfyUIEngineAdapter(), new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter()],
    initialRecipes: [...playbook.recipes, ...(mediaPlaybook?.recipes ?? [])],
    initialRoutes: [...playbook.routes, ...(mediaPlaybook?.routes ?? [])],
  };
}

function installedLocalComfyUIPlaybook() {
  const local = localComfyUIPaths(runtimePaths);
  const recipeIds = localComfyUIRecipeIds(runtimePaths, local);
  if (recipeIds.length === 0) return undefined;
  return createComfyUIPlaybook({
    engineDir: local.engineDir,
    executable: local.executable,
    launchArgs: ["--base-directory", local.baseDir, "--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
    recipeIds,
  });
}

function enforceModelResidency(store: SqliteStore): void {
  for (const recipe of store.listRecipes()) {
    const isMedia = (recipe.capabilities.modalities?.output.length ?? 0) > 0;
    if (isMedia) {
      store.upsertRecipe({
        ...recipe,
        lifecycle: { ...recipe.lifecycle, evictionPolicy: "immediate", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      });
      continue;
    }
    if (recipe.adapter === "openai-compatible") continue;
    store.upsertRecipe({
      ...recipe,
      lifecycle: {
        ...recipe.lifecycle,
        evictionPolicy: "idle-ttl",
        idleTtlSeconds: 600,
        minimumResidencySeconds: Math.min(recipe.lifecycle.minimumResidencySeconds, 600),
      },
    });
  }
}

function engineModeOptions(mode: string) {
  if (mode === "fake") {
    const fakeAdapter = new FakeEngineAdapter({
      loadDelayMs: parseNonNegativeInteger(process.env.FITZ_FAKE_LOAD_DELAY_MS ?? "0", "FITZ_FAKE_LOAD_DELAY_MS"),
      tokenDelayMs: parseNonNegativeInteger(process.env.FITZ_FAKE_TOKEN_DELAY_MS ?? "0", "FITZ_FAKE_TOKEN_DELAY_MS"),
    });
    const mediaPlaybook = installedLocalComfyUIPlaybook();
    return {
      fakeAdapter,
      adapters: [fakeAdapter, new FakeMediaEngineAdapter(), new ComfyUIEngineAdapter(), new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter()],
      initialRecipes: [...DEFAULT_RECIPES, ...(mediaPlaybook?.recipes ?? [])],
      initialRoutes: [...DEFAULT_ROUTES, ...(mediaPlaybook?.routes ?? [])],
    };
  }
  if (mode === "ninfer") return ninferOptions();
  if (mode === "openai-compatible") {
    const recipe = engineRecipe("openai-compatible", {
      baseUrl: requiredEnvironment("FITZ_OPENAI_BASE_URL"),
      ...(process.env.FITZ_OPENAI_API_KEY_ENV ? { apiKeyEnv: process.env.FITZ_OPENAI_API_KEY_ENV } : {}),
      ...(process.env.FITZ_OPENAI_ALLOW_INSECURE_REMOTE === "true" ? { allowInsecureRemote: true } : {}),
    });
    return singleEngineOptions([new OpenAICompatibleEngineAdapter(), new ManagedOpenAIEngineAdapter(), new ComfyUIEngineAdapter()], recipe);
  }
  if (mode === "llama-cpp") {
    const recipe = engineRecipe("llama-cpp", {
      executable: requiredEnvironment("FITZ_LLAMA_CPP_EXECUTABLE"),
      modelPath: requiredEnvironment("FITZ_LLAMA_CPP_MODEL"),
      contextTokens: parsePositiveInteger(process.env.FITZ_MODEL_CONTEXT_TOKENS ?? "32768", "FITZ_MODEL_CONTEXT_TOKENS"),
      ...(process.env.FITZ_LLAMA_CPP_GPU_LAYERS ? { gpuLayers: parseNonNegativeInteger(process.env.FITZ_LLAMA_CPP_GPU_LAYERS, "FITZ_LLAMA_CPP_GPU_LAYERS") } : {}),
    });
    return singleEngineOptions([new LlamaCppEngineAdapter(), new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter(), new ComfyUIEngineAdapter()], recipe);
  }
  if (mode === "comfyui") return comfyuiOptions();
  throw new Error(`Unsupported FITZ_ENGINE_MODE: ${mode}`);
}

/** Explicit ComfyUI mode uses the same official local H3 playbook as the
 * composed chat-engine modes, with environment overrides for remote/admin
 * deployments. */
function comfyuiOptions() {
  const local = localComfyUIPaths(runtimePaths);
  const installedRecipeIds = localComfyUIRecipeIds(runtimePaths, local);
  const playbook = createComfyUIPlaybook({
    engineDir: process.env.FITZ_COMFYUI_DIR ?? local.engineDir,
    executable: process.env.FITZ_COMFYUI_EXECUTABLE ?? local.executable,
    ...(process.env.FITZ_COMFYUI_ENTRYPOINT ? { entrypoint: process.env.FITZ_COMFYUI_ENTRYPOINT } : {}),
    ...(process.env.FITZ_COMFYUI_BASE_URL ? { baseUrl: process.env.FITZ_COMFYUI_BASE_URL } : {}),
    ...(!process.env.FITZ_COMFYUI_BASE_URL ? {
      launchArgs: [
        "--base-directory",
        local.baseDir,
        "--extra-model-paths-config",
        process.env.FITZ_COMFYUI_MODEL_CONFIG ?? local.modelConfigPath,
        "--output-directory",
        process.env.FITZ_COMFYUI_OUTPUT_DIR ?? local.outputDir,
      ],
    } : {}),
    ...(process.env.FITZ_COMFYUI_EXPECTED_VRAM_MIB
      ? { expectedVramMiB: parseNonNegativeInteger(process.env.FITZ_COMFYUI_EXPECTED_VRAM_MIB, "FITZ_COMFYUI_EXPECTED_VRAM_MIB") }
      : {}),
    ...(installedRecipeIds.length ? { recipeIds: installedRecipeIds } : {}),
  });
  return {
    adapters: [new ComfyUIEngineAdapter(), new ManagedOpenAIEngineAdapter(), new OpenAICompatibleEngineAdapter()],
    initialRecipes: playbook.recipes,
    initialRoutes: playbook.routes,
  };
}

function engineRecipe(adapter: "openai-compatible" | "llama-cpp", configuration: Record<string, unknown>): Recipe {
  const modelId = process.env.FITZ_MODEL_ID ?? "local-model";
  const contextTokens = parsePositiveInteger(process.env.FITZ_MODEL_CONTEXT_TOKENS ?? "32768", "FITZ_MODEL_CONTEXT_TOKENS");
  return {
    id: `${adapter}-default`, playbookId: adapter, displayName: modelId, adapter, modelId, contextTokens,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: adapter === "openai-compatible" ? "never" : "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
    configuration,
  };
}

function singleEngineOptions(adapters: Array<NInferEngineAdapter | OpenAICompatibleEngineAdapter | ManagedOpenAIEngineAdapter | LlamaCppEngineAdapter | ComfyUIEngineAdapter>, recipe: Recipe) {
  const route: Route = { id: "default", displayName: "Default", recipeId: recipe.id, enabled: true, isDefault: true };
  const mediaPlaybook = installedLocalComfyUIPlaybook();
  return {
    adapters,
    initialRecipes: [recipe, ...(mediaPlaybook?.recipes ?? [])],
    initialRoutes: [route, ...(mediaPlaybook?.routes ?? [])],
  };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}
