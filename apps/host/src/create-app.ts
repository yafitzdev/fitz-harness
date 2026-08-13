import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import {
  type EngineAdapter,
  type MediaEngineAdapter,
  EngineAdapterRegistry,
  InferenceAdmissionError,
  InferenceScheduler,
  LifecycleEventBus,
  LifecycleManager,
  GpuThermalGuard,
  RouteNotFoundError,
  RouteResolver,
  ResourceGovernor,
  SystemResourceMonitor,
  type InferenceSchedulerOptions,
  type ResourceMonitor,
  type ResourcePolicy,
} from "@fitz/inference-core";
import {
  HOST_CONTRACT_VERSION,
  PROTOCOL_VERSION,
  type Recipe,
  type Route,
  type ToolPolicyRecord,
} from "@fitz/protocol";
import { MetricsRegistry, redactSecrets } from "@fitz/observability";
import { DEFAULT_QUOTAS, SecurityPolicyError, SecurityService, type AuthenticatedPrincipal } from "@fitz/security";
import { ArtifactRepository, MemoryBlobStore, SqliteStore, type StorageDurabilityService } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import type { ModelCatalogService } from "./model-catalog.js";
import type { NInferRuntimeManager } from "./ninfer-runtime.js";
import { AgentRunCoordinator } from "./agent-runs.js";
import { MediaJobCoordinator } from "./media-jobs.js";
import type { AgentRuntime } from "@fitz/agent-core";
import type { PiPackageService } from "@fitz/agent-pi";
import { ContextManager } from "@fitz/context";
import { TailscaleMonitor, TailscaleServeManager, WindowsStartupManager } from "@fitz/connectivity";
import { OpenAICompatibleEngineAdapter } from "@fitz/engine-openai-compatible";
import {
  FalProvider,
  MediaProviderRegistry,
  OpenAICompatibleMediaProvider,
  ReplicateProvider,
} from "@fitz/media-providers";
import { MediaProviderEngineAdapter } from "./media-provider-adapter.js";
import type { AgentSafetyService } from "./agent-safety/index.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerMediaRoutes } from "./media-routes.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";
import { classifyHostError } from "./host-error.js";
import { registerOpenAIRoutes } from "./openai-routes.js";
import { registerCatalogRoutes } from "./catalog-routes.js";
import { registerRuntimeAdministrationRoutes } from "./runtime-administration-routes.js";
import { registerStorageRoutes } from "./storage-routes.js";
import { discardLegacyConsumerConnections, registerConsumerConnectionRoutes } from "./consumer-connection-routes.js";
import {
  ensureMediaRoutes,
  MEDIA_ROUTE_IDS,
  registerModelManagementRoutes,
  scanEngineFolders,
} from "./model-management-routes.js";
import { CHAT_ROUTE_IDS, LOCAL_OWNER_ID, UserRouteResolver } from "./user-route-resolver.js";

export { ensureMediaRoutes } from "./model-management-routes.js";

export interface CreateHostOptions {
  store?: SqliteStore;
  fakeAdapter?: FakeEngineAdapter;
  adapters?: Array<EngineAdapter | MediaEngineAdapter>;
  initialRecipes?: Recipe[];
  initialRoutes?: Route[];
  resourceMonitor?: ResourceMonitor;
  resourcePolicy?: Partial<ResourcePolicy>;
  thermalGuard?: GpuThermalGuard;
  logger?: boolean;
  adminToken?: string;
  authMode?: "disabled" | "required";
  authPepper?: string;
  internalAgentToken?: string;
  security?: SecurityService;
  agentRuntime?: AgentRuntime;
  /** Maximum number of whole agent turns admitted at once (running + queued). */
  agentQueueCapacity?: number;
  /** Independent Pi state machines allowed at once. Local inference overlaps
   * only when the active recipe explicitly declares batching capacity. */
  agentConcurrency?: number;
  /** Prevent one authenticated user from occupying every agent state machine. */
  agentConcurrencyPerOwner?: number;
  /** Bounded inference-lane capacities. Production defaults are intentionally
   * conservative; tests and managed deployments may lower them explicitly. */
  schedulerOptions?: InferenceSchedulerOptions;
  contextManager?: ContextManager;
  tailscaleMonitor?: TailscaleMonitor;
  tailscaleServeManager?: TailscaleServeManager;
  startupManager?: WindowsStartupManager;
  localPort?: number;
  engineRoot?: string;
  /** Bounded await for the synchronous image gateway (default 120 s, §5.8). */
  mediaImageTimeoutMs?: number;
  piPackages?: PiPackageService;
  modelCatalog?: ModelCatalogService;
  /** Reconciles canonical filesystem model registrations into the live index. */
  reconcileLocalModels?: (routes: RouteResolver) => void;
  ninferRuntime?: NInferRuntimeManager;
  /** The host safety layer (policy engine, snapshots, trash, redaction). Optional so tests can run without it. */
  safety?: AgentSafetyService;
  artifacts?: ArtifactRepository;
  /** Coordinated database/artifact backup, restore, and storage maintenance. */
  storageDurability?: StorageDurabilityService;
  /** Releases the dedicated local inference appliance after all engine
   * instances have stopped. Used by the desktop hosting-plane lifecycle. */
  releaseLocalRuntime?: (reason: string) => Promise<void>;
}

export interface HostRuntime {
  app: FastifyInstance;
  store: SqliteStore;
  routes: RouteResolver;
  events: LifecycleEventBus;
  lifecycle: LifecycleManager;
  scheduler: InferenceScheduler;
  agentRuns: AgentRunCoordinator;
  mediaJobs: MediaJobCoordinator;
  context: ContextManager;
  metrics: MetricsRegistry;
  security?: SecurityService;
  fakeAdapter?: FakeEngineAdapter;
  safety?: AgentSafetyService;
  artifacts: ArtifactRepository;
  storageDurability?: StorageDurabilityService;
}

export function createHost(options: CreateHostOptions = {}): HostRuntime {
  const app = Fastify({
    logger: options.logger
      ? {
          level: "info",
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers.x-fitz-admin-token",
              "request.headers.authorization",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
    // JSON body limit: must fit the largest artifact (5 MB) as padded base64 plus envelope.
    bodyLimit: 8 * 1024 * 1024,
  });
  const store = options.store ?? SqliteStore.memory();
  const artifacts = options.artifacts ?? new ArtifactRepository(store, new MemoryBlobStore());
  const storageDurability = options.storageDurability;
  const authMode = options.authMode ?? "disabled";
  const security = options.security ?? (authMode === "required" ? new SecurityService(store, options.authPepper ?? "") : undefined);
  const recoveredInterruptedRequests = store.recoverInterruptedRequests();
  const recoveredGpuWork = store.recoverInterruptedGpuWork();
  const recoveredAgentRuns = store.recoverInterruptedAgentRuns();
  const recoveredToolApprovals = store.recoverInterruptedToolApprovals();
  const recoveredMediaJobs = store.recoverInterruptedMediaJobs();
  seedDefaults(
    store,
    options.initialRecipes ?? DEFAULT_RECIPES,
    options.initialRoutes ?? DEFAULT_ROUTES,
  );
  ensureDefaultRoute(store, options.initialRecipes ?? DEFAULT_RECIPES, options.initialRoutes ?? DEFAULT_ROUTES);
  for (const retiredRouteId of ["fast", "smart", "subagent"]) store.deleteRoute(retiredRouteId);
  discardLegacyConsumerConnections(store);
  const configuredEngineRoot = options.engineRoot ?? store.getSetting<string>("engineRoot") ?? join(homedir(), ".llm", "engines");
  store.setSetting("engineRoot", configuredEngineRoot);
  const routes = new RouteResolver(
    store.listRoutes(),
    store.listRecipes(),
  );
  const reconcileRecipeCatalog = () => {
    options.reconcileLocalModels?.(routes);
    // Reconciliation may dematerialize the selected model after its payload was
    // removed. Preserve the one-Default invariant with the engine mode's valid
    // seed rather than leaving a dangling assignment or crashing the host.
    ensureDefaultRoute(store, options.initialRecipes ?? DEFAULT_RECIPES, options.initialRoutes ?? DEFAULT_ROUTES);
    const reconciledDefault = store.listRoutes().find((route) => route.id === "default")!;
    const reconciledDefaultRecipe = store.listRecipes().find((recipe) => recipe.id === reconciledDefault.recipeId)!;
    routes.upsertRecipe(reconciledDefaultRecipe);
    routes.upsertRoute(reconciledDefault);
  };
  reconcileRecipeCatalog();
  const userRoutes = new UserRouteResolver(store, routes);
  ensureMediaRoutes(store, routes);
  const events = new LifecycleEventBus(1_000, store.latestLifecycleSequence());
  const fakeAdapter = options.adapters ? options.fakeAdapter : (options.fakeAdapter ?? new FakeEngineAdapter());
  // Provider templates register a thin MediaProviderEngineAdapter per template
  // (id = template id), so media recipes resolve in the same adapter registry
  // as local media engines (§5.7).
  const mediaProviders = new MediaProviderRegistry([
    new OpenAICompatibleMediaProvider(),
    new FalProvider(),
    new ReplicateProvider(),
  ]);
  const providerAdapters = mediaProviders.list().map((provider) => new MediaProviderEngineAdapter(provider));
  // Engine-mode adapters are additive. Every real server mode supplies an
  // explicit local/chat adapter list, but connection-backed media recipes still
  // need the three provider-template adapters. Treating `options.adapters` as a
  // replacement made fal/Replicate/openai-media configurable in the UI while
  // leaving the packaged host unable to execute them.
  const configuredAdapters = options.adapters
    ?? (fakeAdapter ? [fakeAdapter, new OpenAICompatibleEngineAdapter()] : [new OpenAICompatibleEngineAdapter()]);
  const configuredAdapterIds = new Set(configuredAdapters.map((adapter) => adapter.id));
  const adapterList = [
    ...configuredAdapters,
    ...providerAdapters.filter((adapter) => !configuredAdapterIds.has(adapter.id)),
  ];
  const adapters = new EngineAdapterRegistry(adapterList);
  // Startup: cancel provider-side jobs orphaned by a crash (best-effort, async).
  // Only provider adapters are safe to `start()` at boot — local engine
  // `start()` would spawn processes (design doc §5.3 restart recovery).
  cancelOrphanedProviderJobs(store, routes, adapters);
  const resources = new ResourceGovernor(
    options.resourceMonitor ?? new SystemResourceMonitor(),
    options.resourcePolicy,
  );
  const lifecycle = new LifecycleManager({
    adapters,
    events,
    resources,
    ...(options.thermalGuard ? { thermalGuard: options.thermalGuard } : {}),
  });
  const scheduler = new InferenceScheduler(routes, lifecycle, events, {
    ...options.schedulerOptions,
    // The hosting plane owns exactly one local model and admits exactly one
    // local generation at a time, regardless of engine batching flags.
    gpuConcurrency: 1,
    recordUsage: async (record) => {
      store.recordRequestUsage(record);
      await options.schedulerOptions?.recordUsage?.(record);
    },
  });
  const agentRuns = new AgentRunCoordinator(
    store,
    scheduler,
    options.agentRuntime,
    options.safety ? () => options.safety!.collect().then(() => undefined) : undefined,
    options.agentQueueCapacity,
    options.agentConcurrency,
    options.agentConcurrencyPerOwner,
  );
  const mediaJobs = new MediaJobCoordinator({ store, artifacts, scheduler, routes, ...(security ? { security } : {}) });
  const mediaImageTimeoutMs = options.mediaImageTimeoutMs ?? 120_000;
  const context = options.contextManager ?? new ContextManager(store);
  const tailscale = options.tailscaleMonitor ?? new TailscaleMonitor();
  const tailscaleServe = options.tailscaleServeManager ?? new TailscaleServeManager();
  const startup = options.startupManager;
  const piPackages = options.piPackages;
  const modelCatalog = options.modelCatalog;
  const ninferRuntime = options.ninferRuntime;
  const safety = options.safety;
  const metrics = new MetricsRegistry();
  const unsubscribePersistence = events.subscribe((event) => {
    store.appendLifecycleEvent(event);
    if (event.type === "queue.updated" && event.data.lane === "gpu") store.recordGpuQueueEvent(event);
    // Media jobs never persist to `inference_requests` — they have their own
    // `media_jobs` records and event stream (§5.5).
    if (event.type === "queue.updated" && event.data.kind === "chat") store.recordQueueEvent(event);
  });
  const unsubscribeMetrics = events.subscribe((event) => metrics.observeLifecycleEvent(event));
  const pinnedDefault = routes.resolve("default").recipe;
  lifecycle.pin(pinnedDefault);
  const scheduleDefaultWarm = (label: string, ownerUserId?: string): void => {
    try {
      const warmup = scheduler.enqueueWarm("default", undefined, { label, ...(ownerUserId ? { ownerUserId } : {}) });
      void warmup.result.catch((error) => app.log.error({ error }, `${label} failed`));
    } catch (error) {
      // A route assignment is durable configuration, not an inference request.
      // If the work lane is momentarily full, the next Default call will load
      // the pinned recipe normally; saving the setting must remain instant.
      app.log.warn({ error }, `${label} could not be queued`);
    }
  };
  scheduleDefaultWarm("Default startup warm");
  const reconcileLocalModels = () => {
    const previous = lifecycle.pinnedRecipe();
    reconcileRecipeCatalog();
    const next = routes.resolve("default").recipe;
    if (sameRuntimeRecipe(previous, next)) return;
    lifecycle.pin(next);
    scheduleDefaultWarm("Reconciled Default warm");
  };
  const requestStarts = new WeakMap<object, number>();
  const principals = new WeakMap<object, AuthenticatedPrincipal>();
  const internalWorkContexts = new WeakMap<object, { runId?: string; ownerUserId?: string; sessionId?: string; forcedToolName?: string }>();
  const ownerUserId = (request: object): string => principals.get(request)?.user.id ?? LOCAL_OWNER_ID;
  app.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, performance.now());
    const publicPath = request.url.split("?")[0];
    const internalAgent = publicPath === "/v1/chat/completions" && validBearerToken(request.headers.authorization, options.internalAgentToken);
    if (authMode === "required" && publicPath !== "/health" && publicPath !== "/api/v1/pairing/redeem" && publicPath !== "/api/v1/pairing/bootstrap") {
      const principal = security?.authenticate(request.headers.authorization);
      if (!principal && !internalAgent) return reply.code(401).send({ error: "Valid device bearer token required" });
      if (principal) principals.set(request, principal);
    }
    if (internalAgent) internalWorkContexts.set(request, trustedInternalWorkContext(request.headers));
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStarts.get(request);
    if (startedAt !== undefined) metrics.observe("http_request_duration_ms", performance.now() - startedAt);
    metrics.increment("http_requests_total");
    metrics.increment(`http_responses_${reply.statusCode}_total`);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const path = request.url.split("?")[0];
    if (reply.statusCode < 400 || !path?.startsWith("/api/v1/") || typeof payload !== "string") return payload;
    try {
      const body = JSON.parse(payload) as Record<string, unknown>;
      if (typeof body.error !== "string") return payload;
      reply.header("content-type", "application/json; charset=utf-8");
      return JSON.stringify({ ...body, error: classifyHostError(body.error, reply.statusCode) });
    } catch { return payload; }
  });

  app.get("/health", async () => {
    const resourceSnapshot = await resources.snapshot();
    return {
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      hostContractVersion: HOST_CONTRACT_VERSION,
      engine: lifecycle.snapshot(),
      queueDepth: scheduler.queueDepth,
      resources: { ...resourceSnapshot, policy: resources.policy },
      recovery: { interruptedGpuWork: recoveredGpuWork, interruptedRequests: recoveredInterruptedRequests, interruptedAgentRuns: recoveredAgentRuns, interruptedToolApprovals: recoveredToolApprovals, interruptedMediaJobs: recoveredMediaJobs },
    };
  });
  app.get("/api/v1/me", async (request) => { const principal = principals.get(request); return { data: principal ? { authMode: "required", user: principal.user, device: principal.device, routeIds: principal.routeGrants, quota: principal.quota } : { authMode: "disabled" } }; });
  app.post("/api/v1/inference/warm", async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const publicRouteId = requirePublicRouteId(body.model);
      if (publicRouteId !== "default") throw new TypeError("Only the local Default route can be warmed");
      const principal = principals.get(request);
      if (principal && !security?.authorizeRoute(principal, publicRouteId)) return reply.code(403).send({ error: "Route access denied" });
      routes.resolve(publicRouteId);
      const warmup = scheduler.enqueueWarm(publicRouteId, undefined, { ...(principal ? { ownerUserId: principal.user.id } : {}), label: `${publicRouteId} warmup` });
      // Warming is speculative work and cold model activation can legitimately
      // take longer than an ordinary desktop request. Acknowledge admission
      // immediately; lifecycle and GPU-work state expose eventual completion.
      void warmup.result.catch(() => undefined);
      return reply.code(202).send({ data: { requestId: warmup.requestId, routeId: publicRouteId, status: "queued" } });
    } catch (error) {
      if (error instanceof InferenceAdmissionError) reply.header("retry-after", "2");
      return reply.code(error instanceof RouteNotFoundError ? 404 : error instanceof InferenceAdmissionError ? 429 : 400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/v1/pairing/bootstrap", async (request, reply) => {
    if (!isDirectLoopbackRequest(request)) return reply.code(403).send({ error: "Initial administration setup is only available directly on the host" });
    if (authMode !== "required" || !security) return reply.code(409).send({ error: "Device authentication is not enabled" });
    if (store.listUsers().length > 0) return reply.code(409).send({ error: "The host has already been initialized" });
    const administrator = security.createUser(`${hostname()} Administrator`, "administrator");
    const issued = security.issueDevice(administrator.id, `${hostname()} Desktop`);
    security.setRouteGrants(administrator.id, [...CHAT_ROUTE_IDS]);
    security.audit("security.bootstrapped", administrator.id, "user", administrator.id);
    return reply.code(201).send({ data: { user: administrator, device: issued.device, token: issued.token } });
  });

  registerOpenAIRoutes({
    app,
    scheduler,
    userRoutes,
    principals,
    internalWorkContexts,
    ...(security ? { security } : {}),
  });

  app.get("/api/v1/events", async (request) => {
    const query = request.query as { after?: string; limit?: string };
    const after = toNonNegativeInteger(query.after, 0);
    const limit = Math.min(toNonNegativeInteger(query.limit, 500), 1_000);
    return {
      protocolVersion: PROTOCOL_VERSION,
      latestSequence: events.latestSequence(),
      events: store.lifecycleEventsAfter(after, limit),
    };
  });
  app.get("/api/v1/connectivity/status", async () => ({ tailscale: await tailscale.status() }));
  app.post("/api/v1/pairing/redeem", async (request, reply) => { try { const body = requireRecord(request.body); const access = securityRequired(security); const redeemed = access.redeemPairingCode(requireString(body.code, "code"), requireString(body.displayName, "displayName"), requireString(body.deviceName, "deviceName")); access.setRouteGrants(redeemed.user.id, [...CHAT_ROUTE_IDS]); return reply.code(201).send({ data: redeemed }); } catch (error) { return reply.code(error instanceof SecurityPolicyError ? 403 : 400).send({ error: errorMessage(error) }); } });

  registerAgentRoutes({
    app,
    store,
    agentRuns,
    scheduler,
    context,
    principals,
    ...(security ? { security } : {}),
    contextTokensForRoute: (routeId, routeOwnerUserId) => userRoutes.contextTokens(routeId, routeOwnerUserId ?? LOCAL_OWNER_ID),
  });

  registerMediaRoutes({
    app,
    store,
    mediaJobs,
    artifacts,
    principals,
    ...(security ? { security } : {}),
    imageTimeoutMs: mediaImageTimeoutMs,
  });

  registerWorkspaceRoutes({
    app,
    store,
    artifacts,
    routes,
    context,
    ...(security ? { security } : {}),
    principals,
  });

  registerConsumerConnectionRoutes({
    app,
    store,
    routes,
    userRoutes,
    mediaProviders,
    principals,
    wellKnownMediaRouteIds: MEDIA_ROUTE_IDS,
    ...(security ? { security } : {}),
  });

  const administratorGuard = adminGuard(options.adminToken, authMode, principals);
  registerModelManagementRoutes({
    app,
    store,
    routes,
    adapters,
    lifecycle,
    scheduler,
    mediaJobs,
    principals,
    administratorGuard,
    configuredEngineRoot,
    mediaImageTimeoutMs,
    scheduleDefaultWarm,
  });

  app.get(
    "/api/v1/management/status",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request) => {
      reconcileLocalModels();
      const resourceSnapshot = await resources.snapshot();
      return {
        engine: lifecycle.snapshot(),
        residency: lifecycle.residencySnapshot(),
        queueDepth: scheduler.queueDepth,
        resources: { ...resourceSnapshot, policy: resources.policy },
        routes: routes.listRoutes(true),
        recipes: routes.listRecipes(),
        engines: store.listEngines(),
        cloudRoutes: userRoutes.configuration(ownerUserId(request)),
        isAdministrator: true,
        hostName: hostname(),
        engineRoot: store.getSetting<string>("engineRoot") ?? configuredEngineRoot,
        engineFolders: scanEngineFolders(store.getSetting<string>("engineRoot") ?? configuredEngineRoot, store.listEngines()),
        ...(ninferRuntime ? { ninferRuntime: await ninferRuntime.status() } : {}),
        recoveredInterruptedRequests,
        recoveredAgentRuns,
        recoveredToolApprovals,
        recoveredMediaJobs,
      };
    },
  );

  app.get("/api/v1/configuration", async (request) => {
    reconcileLocalModels();
    const owner = ownerUserId(request);
    const connections = userRoutes.connections(owner);
    const ownedRecipeIds = new Set(connections.flatMap((connection) => [
      ...connection.models.map((model) => model.recipeId),
      ...connection.mediaModels.map((model) => model.recipeId),
    ]));
    const defaultResolved = routes.resolve("default");
    return {
      hostName: hostname(),
      isAdministrator: authMode === "disabled" || principals.get(request)?.user.role === "administrator",
      routes: [
        ...userRoutes.publicRoutes(owner),
        ...routes.listRoutes(true).filter((route) => (MEDIA_ROUTE_IDS as readonly string[]).includes(route.id) || ownedRecipeIds.has(route.recipeId)),
      ],
      recipes: routes.listRecipes().filter((recipe) => recipe.id === defaultResolved.recipe.id || ownedRecipeIds.has(recipe.id)),
      cloudRoutes: userRoutes.configuration(owner),
    };
  });

  app.get(
    "/api/v1/management/requests",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(toNonNegativeInteger(query.limit, 100), 1_000);
      return { data: store.listInferenceRequests(limit) };
    },
  );

  app.get(
    "/api/v1/management/usage",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const query = request.query as { from?: string; to?: string; bucket?: string; ownerUserId?: string };
      const to = query.to ? parseUsageDate(query.to) : new Date();
      if (!to) return reply.code(400).send({ error: "Usage to must be an ISO date" });
      const from = query.from ? parseUsageDate(query.from) : new Date(to.getTime() - 7 * 86_400_000);
      if (!from) return reply.code(400).send({ error: "Usage from must be an ISO date" });
      if (from >= to) return reply.code(400).send({ error: "Usage range must start before it ends" });
      if (to.getTime() - from.getTime() > 366 * 86_400_000) return reply.code(400).send({ error: "Usage range cannot exceed 366 days" });
      if (query.bucket && query.bucket !== "hour" && query.bucket !== "day") return reply.code(400).send({ error: "Usage bucket must be hour or day" });
      const bucket = query.bucket === "hour" ? "hour" : "day";
      return { data: store.usageReport({ from: from.toISOString(), to: to.toISOString(), bucket, ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}) }) };
    },
  );

  app.get(
    "/api/v1/management/gpu-work",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request) => {
      const query = request.query as { limit?: string };
      return { data: store.listGpuWork(Math.min(toNonNegativeInteger(query.limit, 100), 1_000)) };
    },
  );

  app.get(
    "/api/v1/management/metrics",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async () => metrics.snapshot(),
  );

  app.get(
    "/api/v1/management/diagnostics",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async () => {
      const resourceSnapshot = await resources.snapshot();
      return redactSecrets({
        generatedAt: new Date().toISOString(),
        versions: {
          host: "0.0.0",
          protocol: PROTOCOL_VERSION,
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
        },
        engine: lifecycle.snapshot(),
        queueDepth: scheduler.queueDepth,
        resources: { ...resourceSnapshot, policy: resources.policy },
        routes: routes.listRoutes(),
        recipes: routes.listRecipes(),
        recentRequests: store.listInferenceRequests(100),
        recentGpuWork: store.listGpuWork(100),
        recentLifecycleEvents: store.lifecycleEventsAfter(
          Math.max(0, store.latestLifecycleSequence() - 100),
          100,
        ),
        metrics: metrics.snapshot(),
      });
    },
  );

  app.post(
    "/api/v1/management/instances/stop",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      try {
        const body = request.body === undefined ? {} : requireRecord(request.body);
        const mode = body.mode === undefined || body.mode === "graceful"
          ? "graceful"
          : body.mode === "force" ? "force" : undefined;
        if (!mode) throw new TypeError("mode must be graceful or force");
        const reason = body.reason === undefined ? "management-request" : requireString(body.reason, "reason");
        try {
          if (mode === "force") await scheduler.quiesce(reason);
          else await lifecycle.stop(reason, mode);
        } finally {
          if (reason === "desktop-quit") await options.releaseLocalRuntime?.(reason);
        }
        return { engine: lifecycle.snapshot() };
      } catch (error) {
        return reply.code(error instanceof TypeError ? 400 : 409).send({ error: errorMessage(error) });
      }
    },
  );

  registerRuntimeAdministrationRoutes({ app, tailscale, tailscaleServe, authMode, localPort: options.localPort ?? 8787, principals, administratorGuard, ...(startup ? { startup } : {}), ...(ninferRuntime ? { ninferRuntime } : {}), ...(security ? { security } : {}) });
  registerCatalogRoutes({ app, principals, administratorGuard, reconcileLocalModels, ...(piPackages ? { piPackages } : {}), ...(modelCatalog ? { modelCatalog } : {}), ...(security ? { security } : {}) });
  app.post("/api/v1/management/pairing-codes", { preHandler: administratorGuard }, async (request, reply) => { try { const body = requireRecord(request.body); const role = parseRole(body.intendedRole); const ttlSeconds = body.ttlSeconds === undefined ? 600 : requireInteger(body.ttlSeconds); const pairing = securityRequired(security).issuePairingCode(role, ttlSeconds); security?.audit("pairing-code.issued", principals.get(request)?.user.id, "pairing-code", pairing.id, { intendedRole: role, expiresAt: pairing.expiresAt }); return reply.code(201).send({ data: pairing }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/tool-policies", { preHandler: administratorGuard }, async () => ({ data: store.listToolPolicies() }));
  app.put("/api/v1/management/tool-policies/:subjectType/:subjectId/:toolName", { preHandler: administratorGuard }, async (request, reply) => { try { const params = request.params as { subjectType: string; subjectId: string; toolName: string }; if (params.subjectType !== "role" && params.subjectType !== "user") throw new TypeError("subjectType must be role or user"); const body = requireRecord(request.body); if (body.decision !== "allow" && body.decision !== "deny" && body.decision !== "ask") throw new TypeError("decision must be allow, deny, or ask"); const policy: ToolPolicyRecord = { subjectType: params.subjectType, subjectId: params.subjectId, toolName: params.toolName, decision: body.decision, updatedAt: new Date().toISOString() }; store.upsertToolPolicy(policy); security?.audit("tool-policy.updated", principals.get(request)?.user.id, "tool-policy", `${params.subjectType}:${params.subjectId}:${params.toolName}`, { decision: body.decision }); return { data: policy }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/users", { preHandler: administratorGuard }, async () => ({ data: store.listUsers() }));
  app.get("/api/v1/management/users/:userId/access", { preHandler: administratorGuard }, async (request, reply) => { const userId = (request.params as { userId: string }).userId; const user = store.getUser(userId); if (!user) return reply.code(404).send({ error: "User not found" }); return { data: { user, devices: store.listDevices(userId), routeIds: store.listUserRouteGrants(userId), quota: store.getUserQuota(userId) ?? DEFAULT_QUOTAS[user.role], currentDeviceId: principals.get(request)?.device?.id } }; });
  app.post("/api/v1/management/users", { preHandler: administratorGuard }, async (request, reply) => {
    try {
      const body = requireRecord(request.body); const user = securityRequired(security).createUser(requireString(body.displayName, "displayName"), parseRole(body.role));
      security?.audit("user.created", principals.get(request)?.user.id, "user", user.id, { role: user.role }); return reply.code(201).send({ data: user });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.patch("/api/v1/management/users/:userId", { preHandler: administratorGuard }, async (request, reply) => {
    try {
      const userId = (request.params as { userId: string }).userId; const body = requireRecord(request.body);
      const user = securityRequired(security).updateUser(userId, { ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}), ...(body.role !== undefined ? { role: parseRole(body.role) } : {}), ...(body.status === "active" || body.status === "disabled" ? { status: body.status } : {}) });
      security?.audit("user.updated", principals.get(request)?.user.id, "user", userId); return { data: user };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/users/:userId/devices", { preHandler: administratorGuard }, async (request, reply) => {
    try {
      const userId = (request.params as { userId: string }).userId; const body = requireRecord(request.body); const issued = securityRequired(security).issueDevice(userId, requireString(body.name, "name"));
      security?.audit("device.issued", principals.get(request)?.user.id, "device", issued.device.id, { userId }); return reply.code(201).send({ data: issued });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/devices/:deviceId", { preHandler: administratorGuard }, async (request, reply) => {
    const deviceId = (request.params as { deviceId: string }).deviceId; if (!store.revokeDevice(deviceId, new Date().toISOString())) return reply.code(404).send({ error: "Device not found or already revoked" });
    security?.audit("device.revoked", principals.get(request)?.user.id, "device", deviceId); return reply.code(204).send();
  });
  app.put("/api/v1/management/users/:userId/routes", { preHandler: administratorGuard }, async (request, reply) => {
    try { const userId = (request.params as { userId: string }).userId; const body = requireRecord(request.body); if (!Array.isArray(body.routeIds) || !body.routeIds.every((id) => typeof id === "string")) throw new TypeError("routeIds must be a string array");
      securityRequired(security).setRouteGrants(userId, body.routeIds); security?.audit("route-grants.updated", principals.get(request)?.user.id, "user", userId, { routeIds: body.routeIds }); return { data: { userId, routeIds: store.listUserRouteGrants(userId) } };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.put("/api/v1/management/users/:userId/quota", { preHandler: administratorGuard }, async (request, reply) => {
    try { const userId = (request.params as { userId: string }).userId; const body = requireRecord(request.body); const quota = { maxRequestsPerMinute: requireInteger(body.maxRequestsPerMinute), maxPromptChars: requireInteger(body.maxPromptChars), maxOutputTokens: requireInteger(body.maxOutputTokens), maxQueueDepth: requireInteger(body.maxQueueDepth) };
      securityRequired(security).setQuota(userId, quota); security?.audit("quota.updated", principals.get(request)?.user.id, "user", userId); return { data: quota };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/audit-events", { preHandler: administratorGuard }, async (request) => { const query = request.query as { limit?: string }; return { data: store.listAuditEvents(Math.min(toNonNegativeInteger(query.limit, 100), 1000)) }; });
  registerStorageRoutes({ app, store, artifacts, principals, administratorGuard, ...(storageDurability ? { storageDurability } : {}), ...(security ? { security } : {}) });
  app.get("/api/v1/management/snapshots", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); return { data: safety.listSnapshots() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/snapshots/:runId/restore", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const runId = (request.params as { runId: string }).runId; const result = await safety.restoreSnapshot(runId); security?.audit("snapshot.restored", principals.get(request)?.user.id, "snapshot", runId); return { data: result }; } catch (error) { return reply.code(error instanceof Error && error.message === "Snapshot not found" ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/trash", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); return { data: safety.listTrash() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/trash/:id/restore", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const id = (request.params as { id: string }).id; const entry = await safety.restoreTrash(id); security?.audit("trash.restored", principals.get(request)?.user.id, "trash", id); return { data: entry }; } catch (error) { return reply.code(error instanceof Error && error.message === "Trash entry not found" ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/trash", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const query = request.query as { workspaceRoot?: string }; const result = await safety.emptyTrash(typeof query.workspaceRoot === "string" && query.workspaceRoot ? query.workspaceRoot : undefined); security?.audit("trash.emptied", principals.get(request)?.user.id, "trash", undefined, { removed: result.removed, ...(typeof query.workspaceRoot === "string" && query.workspaceRoot ? { workspaceRoot: query.workspaceRoot } : {}) }); return { data: result }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/trash/gc", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const body = isRecord(request.body) ? request.body : {}; const maxAgeDays = typeof body.maxAgeDays === "number" && Number.isFinite(body.maxAgeDays) && body.maxAgeDays > 0 ? body.maxAgeDays : 30; const result = await safety.collect(maxAgeDays * 24 * 60 * 60 * 1000); security?.audit("safety.gc", principals.get(request)?.user.id, "safety", undefined, { maxAgeDays, ...result }); return { data: result }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/tool-actions", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const query = request.query as { limit?: string }; return { data: safety.listToolActions(Math.min(toNonNegativeInteger(query.limit, 200), 1000)) }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });

  app.addHook("onClose", async () => {
    await agentRuns.shutdown();
    await mediaJobs.shutdown();
    await lifecycle.cancelPreparations();
    await scheduler.shutdown();
    await options.releaseLocalRuntime?.("host-close");
    unsubscribeMetrics();
    unsubscribePersistence();
    store.close();
  });

  return {
    app,
    store,
    artifacts,
    ...(storageDurability ? { storageDurability } : {}),
    routes,
    events,
    lifecycle,
    scheduler,
    agentRuns,
    mediaJobs,
    context,
    metrics,
    ...(security ? { security } : {}),
    ...(fakeAdapter ? { fakeAdapter } : {}),
    ...(safety ? { safety } : {}),
  };
}

function seedDefaults(store: SqliteStore, recipes: Recipe[], routes: Route[]): void {
  if (store.listRecipes().length === 0) {
    for (const recipe of recipes) store.upsertRecipe(recipe);
  }
  if (store.listRoutes().length === 0) {
    for (const route of routes) store.upsertRoute(route);
  }
}

function ensureDefaultRoute(store: SqliteStore, recipes: Recipe[], routes: Route[]): void {
  const existing = store.listRoutes().find((route) => route.id === "default");
  const existingRecipe = existing ? store.listRecipes().find((recipe) => recipe.id === existing.recipeId) : undefined;
  if (existing && existingRecipe && isLocalTextRecipe(existingRecipe)) return;
  if (existing) store.deleteRoute(existing.id);
  const route = routes.find((candidate) => candidate.id === "default");
  if (!route) throw new Error("Host configuration must define a Default route");
  const recipe = recipes.find((candidate) => candidate.id === route.recipeId);
  if (!recipe) throw new Error(`Default route recipe is unavailable: ${route.recipeId}`);
  if (!isLocalTextRecipe(recipe)) throw new Error(`Default route recipe must use a local text engine: ${recipe.id}`);
  if (!store.listRecipes().some((candidate) => candidate.id === recipe.id)) store.upsertRecipe(recipe);
  store.upsertRoute(route);
}

function isLocalTextRecipe(recipe: Recipe): boolean {
  return recipe.capabilities.chatCompletions
    && (recipe.capabilities.modalities?.output.length ?? 0) === 0
    && recipe.adapter !== "openai-compatible";
}

function requirePublicRouteId(value: unknown): "default" | "fast" | "smart" {
  if (value === undefined) return "default";
  if (value !== "default" && value !== "fast" && value !== "smart") throw new TypeError("routeId must be default, fast, or smart");
  return value;
}

/** Host-boot follow-up to the restart risk (§5.3/§5.7): interrupted media jobs
 *  with a persisted providerJobId and a provider-template adapter get a
 *  provider-side cancel so an orphaned fal/Replicate job stops billing.
 *  Fire-and-forget and best-effort — never blocks boot or fails recovery. */
function cancelOrphanedProviderJobs(store: SqliteStore, routes: RouteResolver, adapters: EngineAdapterRegistry): void {
  for (const job of store.listMediaJobs({ status: "interrupted" })) {
    const providerJobId = job.providerJobId;
    if (!providerJobId) continue;
    void (async () => {
      try {
        const route = routes.listRoutes(true).find((entry) => entry.id === job.routeId);
        if (!route?.recipeId) return;
        const recipe = routes.listRecipes().find((entry) => entry.id === route.recipeId);
        if (!recipe) return;
        const adapter = adapters.get(recipe.adapter);
        if (!(adapter instanceof MediaProviderEngineAdapter)) return;
        const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
        const handle = await adapter.start(recipe, spec, new AbortController().signal);
        await adapter.cancel(handle, { id: providerJobId, modality: job.modality });
      } catch {
        // Best-effort: the job stays `interrupted` and the residual cost risk
        // is documented; recovery itself already completed above.
      }
    })();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameRuntimeRecipe(left: Recipe | undefined, right: Recipe): boolean {
  return left !== undefined
    && left.id === right.id
    && left.adapter === right.adapter
    && left.modelId === right.modelId
    && left.contextTokens === right.contextTokens
    && isDeepStrictEqual(left.configuration, right.configuration);
}

function parseUsageDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function validBearerToken(authorization: string | undefined, expected: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ") || !expected) return false;
  const actualHash = createHash("sha256").update(authorization.slice(7)).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function trustedInternalWorkContext(headers: Record<string, string | string[] | undefined>): { runId?: string; ownerUserId?: string; sessionId?: string; forcedToolName?: string } {
  const value = (name: string): string | undefined => {
    const candidate = headers[name];
    return typeof candidate === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : undefined;
  };
  const runId = value("x-fitz-run-id");
  const ownerUserId = value("x-fitz-owner-user-id");
  const sessionId = value("x-fitz-session-id");
  const requestedTool = value("x-fitz-forced-tool");
  const forcedToolName = requestedTool === "generate_image" || requestedTool === "generate_video" || requestedTool === "generate_audio"
    ? requestedTool
    : undefined;
  return { ...(runId ? { runId } : {}), ...(ownerUserId ? { ownerUserId } : {}), ...(sessionId ? { sessionId } : {}), ...(forcedToolName ? { forcedToolName } : {}) };
}

function adminGuard(expectedToken: string | undefined, authMode: "disabled" | "required", principals: WeakMap<object, AuthenticatedPrincipal>) {
  return async (request: { headers: Record<string, string | string[] | undefined> }, reply: any) => {
    if (authMode === "required") {
      if (principals.get(request)?.user.role !== "administrator") return reply.code(403).send({ error: "Administrator authorization required" });
      return;
    }
    if (!expectedToken) return;
    if (request.headers["x-fitz-admin-token"] !== expectedToken) {
      return reply.code(403).send({ error: "Administrator authorization required" });
    }
  };
}

function securityRequired(value: SecurityService | undefined): SecurityService { if (!value) throw new SecurityPolicyError("Authentication is disabled"); return value; }
function requireRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new TypeError("Body must be an object"); return value; }
function requireString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`); return value.trim(); }
function requireInteger(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError("Quota values must be positive integers"); return value as number; }
function parseRole(value: unknown): "administrator" | "agent" | "consumer" { if (value === undefined) return "consumer"; if (value === "administrator" || value === "agent" || value === "consumer") return value; throw new TypeError("Invalid role"); }

function toNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function canAccessOwner(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId; }
function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  const address = request.ip.startsWith("::ffff:") ? request.ip.slice("::ffff:".length) : request.ip;
  if (address !== "127.0.0.1" && address !== "::1") return false;
  const proxyHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];
  return proxyHeaders.every((name) => request.headers[name] === undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
