import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NInferEngineAdapter } from "@fitz/engine-ninfer";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import { FakeMediaEngineAdapter } from "@fitz/engine-media-fake";
import { ManagedOpenAIEngineAdapter, OpenAICompatibleEngineAdapter } from "@fitz/engine-openai-compatible";
import { ComfyUIEngineAdapter } from "@fitz/engine-comfyui";
import { applyPendingStorageRestore, ArtifactRepository, LocalBlobStore, SqliteStore, StorageDurabilityService } from "@fitz/storage";
import { SecurityService } from "@fitz/security";
import { createHost } from "./create-app.js";
import { createMediaTools } from "./media-tools.js";
import type { MediaJobCoordinator } from "./media-jobs.js";
import { ModelCatalogService } from "./model-catalog.js";
import { PiAgentRuntime, PiPackageService, WorkspaceMutationLeaseManager, requiredInitialSubagentRoutes } from "@fitz/agent-pi";
import { createNInferPlaybook } from "./ninfer-playbook.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";
import { reconcileNInferConfiguration } from "./ninfer-reconcile.js";
import { createToolApprovalRequester } from "./tool-approval-gate.js";
import { createSessionReader } from "./session-reader.js";
import { contextTokensForAgentRequest, contextTokensForRoute, executionClassForRoute, thinkingFormatForAgentRequest } from "./route-context.js";
import { WindowsStartupManager } from "@fitz/connectivity";
import { SharedHostGateway, TailscaleFunnelManager } from "@fitz/connectivity";
import { FitzConfigService } from "@fitz/config";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { NInferRuntimeManager } from "./ninfer-runtime.js";
import { managedLinuxRuntimeLayout, managedLinuxRuntimeMap, terminateManagedLinuxRuntime } from "./managed-linux-runtime.js";
import { AgentSafetyService } from "./agent-safety/index.js";
import { localComfyUIPaths, localComfyUIRecipeIds, reconcileLocalComfyUIConfiguration } from "./comfyui-reconcile.js";
import { ensureComfyUISafeModeExtension } from "./comfyui-safe-mode.js";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import { HostInstanceLock } from "./host-instance-lock.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import { LlamaCppModelReconciler } from "./llama-cpp-reconcile.js";
import { VllmModelReconciler } from "./vllm-reconcile.js";
import { createSubagentTool, isDelegatedToolContext, subagentRouteBudget } from "./subagent-tools.js";
import type { AgentRunCoordinator } from "./agent-runs.js";
import { LOCAL_OWNER_ID } from "./user-route-resolver.js";
import { HostingService } from "./hosting-service.js";
import { createAgentPlanTool, createAgentRunPlanPolicy } from "./agent-plan-tools.js";
import { rootAgentToolCallBudget } from "./agent-effort-policy.js";
import type { Recipe, ResolvedAgentTopology } from "@fitz/protocol";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runtimePaths = resolveRuntimePaths();
const bundledNpmCli = resolve(moduleDirectory, "../node_modules/npm/bin/npm-cli.js");
const npmCliPath = process.env.FITZ_NPM_CLI_PATH ?? (existsSync(bundledNpmCli) ? bundledNpmCli : undefined);
const databasePath = runtimePaths.databasePath;
const host = process.env.FITZ_HOST ?? "127.0.0.1";
const port = parsePort(process.env.FITZ_PORT ?? "8787");
const engineMode = process.env.FITZ_ENGINE_MODE ?? "ninfer";
const authMode = process.env.FITZ_AUTH_MODE === "disabled" ? "disabled" : "required";
const agentRuntimeMode = process.env.FITZ_AGENT_RUNTIME ?? "pi";
const agentBaseUrl = process.env.FITZ_AGENT_BASE_URL ?? `http://127.0.0.1:${port}/v1`;
const internalAgentToken = agentRuntimeMode === "pi" && !process.env.FITZ_AGENT_BASE_URL ? randomBytes(32).toString("base64url") : undefined;

mkdirSync(runtimePaths.dataRoot, { recursive: true });
const hostInstanceLock = HostInstanceLock.acquire(join(runtimePaths.dataRoot, "host.lock"));
const restoredStorage = await applyPendingStorageRestore(runtimePaths);
if (restoredStorage) console.info("Scheduled storage restore applied", restoredStorage);
mkdirSync(dirname(databasePath), { recursive: true });
for (const directory of [runtimePaths.piAgentDir, runtimePaths.logsDir, runtimePaths.cacheDir, runtimePaths.engineRoot, runtimePaths.modelRoot, runtimePaths.ggufModelRoot, runtimePaths.environmentRoot, runtimePaths.runtimeRoot, runtimePaths.snapshotsDir, runtimePaths.artifactsDir, runtimePaths.backupsDir]) mkdirSync(directory, { recursive: true });
ensureComfyUISafeModeExtension(localComfyUIPaths(runtimePaths).hostBaseDir);
const linuxRuntimeLayout = managedLinuxRuntimeLayout(runtimePaths);
const linuxRuntimes = managedLinuxRuntimeMap(linuxRuntimeLayout);
const ninferRuntime = engineMode === "ninfer" && process.platform === "win32"
  ? new NInferRuntimeManager({ paths: runtimePaths, sourceDistribution: process.env.FITZ_NINFER_SOURCE_WSL_DISTRIBUTION ?? "Ubuntu" })
  : undefined;
const engineOptions = engineModeOptions(engineMode);
const store = new SqliteStore(databasePath);
const configuration = new FitzConfigService({
  path: join(runtimePaths.dataRoot, "fitz.config.json"),
  defaults: {
    inference: {
      engineRoot: runtimePaths.engineRoot,
      reserveVramMiB: parseNonNegativeInteger(process.env.FITZ_RESERVE_VRAM_MIB ?? "2048", "FITZ_RESERVE_VRAM_MIB"),
      agentConcurrency: parsePositiveInteger(process.env.FITZ_AGENT_CONCURRENCY ?? "4", "FITZ_AGENT_CONCURRENCY"),
      agentConcurrencyPerUser: parsePositiveInteger(process.env.FITZ_AGENT_CONCURRENCY_PER_USER ?? "1", "FITZ_AGENT_CONCURRENCY_PER_USER"),
    },
  },
});
const legacySettings = store.listLegacySettings();
configuration.migrateLegacySettings(Object.fromEntries(Object.entries(legacySettings).filter(([key]) => key !== "consumerConnections" && key !== "consumerCloudRoutes")));
// Remove duplicates written by development builds that briefly treated
// provider connection records as settings. SQLite remains authoritative.
configuration.delete("consumerConnections");
configuration.delete("consumerCloudRoutes");
store.useSettingsBackend(configuration);
const desiredConfiguration = configuration.read();
runtimePaths.engineRoot = desiredConfiguration.inference.engineRoot ?? runtimePaths.engineRoot;
const reserveVramMiB = desiredConfiguration.inference.reserveVramMiB;
const agentConcurrency = desiredConfiguration.inference.agentConcurrency;
const agentConcurrencyPerOwner = desiredConfiguration.inference.agentConcurrencyPerUser;
const startupManager = new WindowsStartupManager(process.env.FITZ_STARTUP_LAUNCHER ?? resolve(moduleDirectory, "../start-host.ps1"));
const sharingGateway = new SharedHostGateway({ target: new URL(`http://127.0.0.1:${port}`), port: desiredConfiguration.hosting.gatewayPort });
const funnelManager = new TailscaleFunnelManager({ target: new URL(sharingGateway.origin), httpsPort: desiredConfiguration.hosting.publicPort });
const hosting = new HostingService({ config: configuration, gateway: sharingGateway, funnel: funnelManager, startup: startupManager, onError: (error) => console.warn("Hosting reconciliation failed", error) });
const llamaCppModels = new LlamaCppModelReconciler(store, runtimePaths);
const vllmModels = new VllmModelReconciler(store, runtimePaths, linuxRuntimeLayout);
const artifacts = new ArtifactRepository(store, new LocalBlobStore(runtimePaths.artifactsDir), { quotaBytes: () => store.getSetting<number>("artifactStorageQuotaBytes") });
const artifactRecovery = await artifacts.initialize();
if (artifactRecovery.migrated || artifactRecovery.collected) console.info("Artifact store reconciled", artifactRecovery);
const storageDurability = new StorageDurabilityService(artifacts, runtimePaths);
const storeInitiallyEmpty = store.listRecipes().length === 0;
const authPepper = authMode === "required" ? resolveAuthPepper(store) : undefined;
// One SecurityService shared by HTTP auth, the media coordinator, and the agent media
// tools: in-process submits build device-less principals via `principalForUser` (§5.9).
const security = authPepper ? new SecurityService(store, authPepper) : undefined;
if (engineMode === "ninfer") {
  if (!ninferRuntime) throw new Error("NInfer requires the canonical inference-linux runtime");
  reconcileNInferConfiguration(store, ninferRuntime.layout);
}
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
  runtimeDirs: [runtimePaths.piAgentDir, runtimePaths.logsDir, runtimePaths.cacheDir, runtimePaths.engineRoot, runtimePaths.modelRoot, runtimePaths.environmentRoot, runtimePaths.runtimeRoot, runtimePaths.llmRoot],
});
// Late-bound: the media coordinator is constructed inside createHost, but customTools
// runs per agent run — after host startup — so the closure reads the assigned instance.
let mediaJobs: MediaJobCoordinator | undefined;
let agentRuns: AgentRunCoordinator | undefined;
let loadedLocalTopology: ((recipe: Recipe) => ResolvedAgentTopology) | undefined;
const workspaceMutationLeases = new WorkspaceMutationLeaseManager();
const runtime = createHost({
  store,
  artifacts,
  storageDurability,
  releaseLocalRuntime: () => terminateManagedLinuxRuntime(linuxRuntimeLayout),
  logger: true,
  resourcePolicy: { reserveVramMiB },
  authMode,
  safety,
  agentConcurrency,
  agentConcurrencyPerOwner,
  ...(security ? { security } : {}),
  ...(internalAgentToken ? { internalAgentToken } : {}),
  ...(process.env.FITZ_DEV_SESSION_TOKEN ? { devSessionToken: process.env.FITZ_DEV_SESSION_TOKEN } : {}),
  localPort: port,
  hostingService: hosting,
  engineRoot: runtimePaths.engineRoot,
  piPackages: new PiPackageService({
    agentDir: runtimePaths.piAgentDir,
    cwd: process.cwd(),
    ...(npmCliPath ? { npmCommand: [process.execPath, npmCliPath] } : {}),
  }),
  modelCatalog: new ModelCatalogService({
    modelRoot: runtimePaths.ggufModelRoot,
    ...(process.env.FITZ_HF_ENDPOINT ? { endpoint: process.env.FITZ_HF_ENDPOINT } : {}),
  }),
  reconcileLocalModels: (routes) => {
    llamaCppModels.reconcile(routes);
    vllmModels.reconcile(routes);
  },
  ...(ninferRuntime ? { ninferRuntime } : {}),
  ...(authPepper ? { authPepper } : {}),
  ...engineOptions,
  ...(process.env.FITZ_ADMIN_TOKEN ? { adminToken: process.env.FITZ_ADMIN_TOKEN } : {}),
  ...(agentRuntimeMode === "pi" ? {
    agentRuntime: new PiAgentRuntime({
      baseUrl: agentBaseUrl,
      apiKey: process.env.FITZ_AGENT_API_KEY ?? internalAgentToken ?? "fitz-local",
      thinkingLevel: (request) => request.effort === "high" ? "high" : request.effort === "light" ? "low" : "medium",
      thinkingFormat: (request, context) => thinkingFormatForAgentRequest(store, request, context?.ownerUserId),
      toolCallBudget: (request) => rootAgentToolCallBudget(request.effort),
      forwardWorkContext: Boolean(internalAgentToken),
      // The pi session's context window must match the recipe the route resolves to
      // (e.g. 131072 for consumer/DeepSeek routes, 100000 for ninfer), not a fixed default.
      contextWindow: (request, context) => contextTokensForAgentRequest(store, request, context?.ownerUserId, loadedLocalTopology),
      cwd: (request) => {
        if (process.env.FITZ_AGENT_CWD) return process.env.FITZ_AGENT_CWD;
        const inheritedSessionId = request.delegation
          ? store.getAgentRun(request.delegation.parentRunId)?.sessionId
          : undefined;
        const sessionId = request.sessionId ?? inheritedSessionId;
        const session = sessionId ? store.getSession(sessionId) : undefined;
        const project = session?.projectId ? store.getProject(session.projectId) : undefined;
        return project?.rootPath ?? process.cwd();
      },
      requestToolApproval: createToolApprovalRequester(store),
      sessionReader: createSessionReader(store),
      toolPolicy: safety.createToolEvaluator(),
      toolLease: workspaceMutationLeases.acquire,
      redactToolResult: safety.createResultRedactor(),
      subagentBudget: (request, context) => subagentRouteBudget(store, context?.ownerUserId ?? LOCAL_OWNER_ID, request.model, request.effort ?? "normal", loadedLocalTopology),
      runPlan: (_request, context) => context?.runId ? createAgentRunPlanPolicy(store, context.runId) : undefined,
      customTools: (context) => {
        const delegated = isDelegatedToolContext(store, context);
        const ownerUserId = (context.runId ? store.getAgentRun(context.runId)?.ownerUserId : undefined) ?? LOCAL_OWNER_ID;
        const parentRequest = context.request ?? (context.runId ? store.getAgentRunRequest(context.runId) : undefined);
        const parentRoute = parentRequest?.model ?? "default";
        const subagentBudget = subagentRouteBudget(store, ownerUserId, parentRoute, parentRequest?.effort ?? "normal", loadedLocalTopology);
        return [
          ...safety.createCustomTools()(context),
          ...(!delegated ? [createAgentPlanTool({
            store,
            ...(parentRequest && subagentBudget ? { requiredWorkerRoutes: [...requiredInitialSubagentRoutes(parentRequest, subagentBudget)] } : {}),
          }, context)] : []),
          // Authenticated runs enforce the owner's media quota and route grants.
          // Explicit local auth-disabled mode has no user and follows the existing
          // administrator-diagnostic path used by the management media test.
          ...(!delegated && mediaJobs ? createMediaTools({ mediaJobs, store, ...(security ? { security } : {}) })(context) : []),
          ...(!delegated && subagentBudget && agentRuns ? [createSubagentTool({
            agentRuns,
            store,
            executionClass: executionClassForRoute(store, parentRoute, ownerUserId),
          }, context, subagentBudget)] : []),
        ];
      },
      agentDir: runtimePaths.piAgentDir,
      llmRoot: runtimePaths.llmRoot,
    }),
  } : {}),
});
loadedLocalTopology = (recipe) => runtime.lifecycle.localAgentTopology(recipe);
mediaJobs = runtime.mediaJobs;
agentRuns = runtime.agentRuns;
let removeSignalHandlers: () => void = () => undefined;
runtime.app.addHook("onClose", async () => {
  removeSignalHandlers();
  await hosting.close();
  await hostInstanceLock.release();
});
// On a fresh database createHost seeds the complete engine-mode recipe set first;
// reconcile afterward so ComfyUI also gets its Playbooks registration without
// suppressing the normal chat defaults. Pacing is engine-side (the extension
// under data/comfyui), so no host-owned performance mode is set here.
if (storeInitiallyEmpty) reconcileLocalComfyUIConfiguration(store, runtimePaths);
if (storeInitiallyEmpty) enforceModelResidency(store);

await runtime.app.listen({ host, port });
try { await hosting.initialize(); }
catch (error) { runtime.app.log.error({ error }, "Fitz Hosting could not initialize"); }
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
  if (!ninferRuntime) throw new Error("NInfer requires the canonical inference-linux runtime");
  const playbook = createNInferPlaybook(ninferRuntime.layout);
  const mediaPlaybook = installedLocalComfyUIPlaybook();
  const adapter = new NInferEngineAdapter({ managedLinux: { distribution: ninferRuntime.layout.distribution, user: "root" } });
  return {
    adapters: [adapter, new ComfyUIEngineAdapter({ linuxRuntimes }), managedOpenAIAdapter(), new OpenAICompatibleEngineAdapter()],
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
    runtime: "linux-managed",
    runtimeId: linuxRuntimeLayout.id,
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
        evictionPolicy: "never",
        idleTtlSeconds: 0,
        minimumResidencySeconds: 0,
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
      adapters: [fakeAdapter, new FakeMediaEngineAdapter(), new ComfyUIEngineAdapter({ linuxRuntimes }), managedOpenAIAdapter(), new OpenAICompatibleEngineAdapter()],
      initialRecipes: [...DEFAULT_RECIPES, ...(mediaPlaybook?.recipes ?? [])],
      initialRoutes: [...DEFAULT_ROUTES, ...(mediaPlaybook?.routes ?? [])],
    };
  }
  if (mode === "ninfer") return ninferOptions();
  throw new Error(`Unsupported FITZ_ENGINE_MODE: ${mode}`);
}

function managedOpenAIAdapter(): ManagedOpenAIEngineAdapter {
  return new ManagedOpenAIEngineAdapter({ linuxRuntimes });
}


function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}
