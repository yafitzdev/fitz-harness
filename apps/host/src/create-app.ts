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
  LOCAL_MAIN_CONTEXT_TOKENS,
  LOCAL_WORKER_CONTEXT_TOKENS,
  PROTOCOL_VERSION,
  type AgentEffort,
  type AgentTopologyPresentation,
  type Recipe,
  type Route,
  type SessionQueryService,
} from "@fitz/protocol";
import { MetricsRegistry, redactSecrets } from "@fitz/observability";
import { SecurityPolicyError, SecurityService, type AuthenticatedPrincipal } from "@fitz/security";
import { ArtifactRepository, MemoryBlobStore, SqliteSessionQueryService, SqliteStore, type StorageDurabilityService } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import type { ModelCatalogService } from "./model-catalog.js";
import type { NInferRuntimeManager } from "./ninfer-runtime.js";
import { AgentRunCoordinator } from "./agent-runs.js";
import { MediaJobCoordinator } from "./media-jobs.js";
import type { AgentRuntime } from "@fitz/agent-core";
import type { PiPackageService } from "@fitz/agent-pi";
import { ContextManager } from "@fitz/context";
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
import { registerSecurityAdministrationRoutes } from "./security-administration-routes.js";
import { registerSafetyAdministrationRoutes } from "./safety-administration-routes.js";
import { registerHostingRoutes } from "./hosting-routes.js";
import type { HostingService } from "./hosting-service.js";
import { discardLegacyConsumerConnections, ensureRecipeExecutionClasses, registerConsumerConnectionRoutes } from "./consumer-connection-routes.js";
import {
  ensureMediaRoutes,
  MEDIA_ROUTE_IDS,
  registerModelManagementRoutes,
  scanEngineFolders,
} from "./model-management-routes.js";
import { CHAT_ROUTE_IDS, hasCloudRouteBinding, LOCAL_OWNER_ID, UserRouteResolver } from "./user-route-resolver.js";
import { contextTokensForAgentRequest } from "./route-context.js";
import { CLOUD_SUBAGENT_EFFORT_BUDGETS } from "./agent-effort-policy.js";
import { ConversationTurnService } from "./conversation-turns.js";
import { LspRegistry, type LspService } from "@fitz/lsp";

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
  /** Ephemeral credential accepted only by the dev supervisor shutdown route. */
  devSessionToken?: string;
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
  hostingService?: HostingService;
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
  /** Host-owned read-only language-server registry. Providers are configured outside model requests. */
  lsp?: LspService;
  /** Shared read-only session query service used by routes and the agent runtime. */
  sessionQuery?: SessionQueryService;
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
  lsp: LspService;
  sessionQuery: SessionQueryService;
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
  const lsp = options.lsp ?? new LspRegistry();
  const sessionQuery = options.sessionQuery ?? new SqliteSessionQueryService(store, { artifacts });
  const authMode = options.authMode ?? "disabled";
  const security = options.security ?? (authMode === "required" ? new SecurityService(store, options.authPepper ?? "") : undefined);
  const recoveredInterruptedRequests = store.recoverInterruptedRequests();
  const recoveredGpuWork = store.recoverInterruptedGpuWork();
  const recoveredInferenceEvidence = store.recoverInterruptedInferenceEvidence();
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
  discardLegacyRecipeAgentTopologies(store);
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
  ensureRecipeExecutionClasses(store);
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
    // One local model remains resident. Recipes opt into small batched
    // generation through maxConcurrentGenerations; other engines stay serial.
    gpuConcurrency: options.schedulerOptions?.gpuConcurrency ?? 3,
    // High Smart may dispatch six Fast workers and two Smart peers together.
    cloudConcurrency: options.schedulerOptions?.cloudConcurrency ?? 8,
    recordUsage: async (record) => {
      store.recordRequestUsage(record);
      await options.schedulerOptions?.recordUsage?.(record);
    },
    recordEvidence: (record) => {
      store.recordInferenceEvidence(record);
      options.schedulerOptions?.recordEvidence?.(record);
    },
    recordEvidenceDelta: (evidenceId, sequence, delta, timestamp) => {
      store.recordInferenceEvidenceDelta(evidenceId, sequence, delta, timestamp);
      options.schedulerOptions?.recordEvidenceDelta?.(evidenceId, sequence, delta, timestamp);
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
  const conversationTurns = new ConversationTurnService(store, context);
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
  const internalWorkContexts = new WeakMap<object, { runId?: string; ownerUserId?: string; sessionId?: string }>();
  const ownerUserId = (request: object): string => principals.get(request)?.user.id ?? LOCAL_OWNER_ID;
  app.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, performance.now());
    const publicPath = request.url.split("?")[0];
    const internalAgent = publicPath === "/v1/chat/completions" && validBearerToken(request.headers.authorization, options.internalAgentToken);
    const devSupervisor = publicPath === "/__fitz/dev/shutdown" && validBearerToken(request.headers.authorization, options.devSessionToken);
    if (authMode === "required" && publicPath === "/health") {
      const principal = security?.authenticate(request.headers.authorization);
      if (principal) principals.set(request, principal);
    }
    if (authMode === "required" && !devSupervisor && publicPath !== "/health" && publicPath !== "/api/v1/pairing/bootstrap") {
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

  app.get("/health", async (request) => {
    const contract = { status: "ok", protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION };
    // Unauthenticated health checks only expose protocol compatibility. The
    // detailed engine/resource snapshot is operationally sensitive and is
    // returned only to an authenticated Fitz device.
    if (authMode === "required" && !principals.get(request)) return contract;
    const resourceSnapshot = await resources.snapshot();
    return {
      ...contract,
      engine: lifecycle.snapshot(),
      queueDepth: scheduler.queueDepth,
      resources: { ...resourceSnapshot, policy: resources.policy },
      recovery: { interruptedGpuWork: recoveredGpuWork, interruptedRequests: recoveredInterruptedRequests, interruptedInferenceEvidence: recoveredInferenceEvidence, interruptedAgentRuns: recoveredAgentRuns, interruptedToolApprovals: recoveredToolApprovals, interruptedMediaJobs: recoveredMediaJobs },
    };
  });
  if (options.devSessionToken) {
    app.post("/__fitz/dev/shutdown", async (request, reply) => {
      if (!validBearerToken(request.headers.authorization, options.devSessionToken)) {
        return reply.code(401).send({ error: "Valid dev session credential required" });
      }
      reply.raw.once("finish", () => {
        setImmediate(() => { void app.close().catch((error) => app.log.error({ error }, "Dev supervisor shutdown failed")); });
      });
      return reply.code(202).send({ status: "shutting-down" });
    });
  }
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
  registerAgentRoutes({
    app,
    store,
    agentRuns,
    scheduler,
    context,
    artifacts,
    principals,
    ...(security ? { security } : {}),
    contextTokensForRequest: (agentRequest, routeOwnerUserId) => contextTokensForAgentRequest(
      store,
      agentRequest,
      routeOwnerUserId ?? LOCAL_OWNER_ID,
      (recipe) => lifecycle.localAgentTopology(recipe),
    ),
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
    sessionQuery,
    routes,
    context,
    conversationTurns,
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
        chatDefaults: options.hostingService?.configuration().defaults ?? { route: "default", effort: "normal" },
        agentTopologies: agentTopologyPresentations(userRoutes, lifecycle, ownerUserId(request)),
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
    const principal = principals.get(request);
    const sharedRoutes = routes.listRoutes(true).filter((route) => {
      if (ownedRecipeIds.has(route.recipeId)) return true;
      if (!(MEDIA_ROUTE_IDS as readonly string[]).includes(route.id)) return false;
      return authMode === "disabled" || (principal !== undefined && security?.authorizeRoute(principal, route.id) === true);
    });
    const visibleRecipeIds = new Set([
      defaultResolved.recipe.id,
      ...ownedRecipeIds,
      ...sharedRoutes.map((route) => route.recipeId),
    ]);
    return {
      hostName: hostname(),
      isAdministrator: authMode === "disabled" || principals.get(request)?.user.role === "administrator",
      chatDefaults: options.hostingService?.configuration().defaults ?? { route: "default", effort: "normal" },
      agentTopologies: agentTopologyPresentations(userRoutes, lifecycle, owner),
      routes: [
        ...userRoutes.publicRoutes(owner),
        ...sharedRoutes,
      ],
      recipes: routes.listRecipes().filter((recipe) => visibleRecipeIds.has(recipe.id)),
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

  registerRuntimeAdministrationRoutes({ app, principals, administratorGuard, ...(ninferRuntime ? { ninferRuntime } : {}), ...(security ? { security } : {}) });
  if (options.hostingService) registerHostingRoutes({ app, hosting: options.hostingService, principals, administratorGuard, ...(security ? { security } : {}) });
  registerCatalogRoutes({ app, principals, administratorGuard, reconcileLocalModels, ...(piPackages ? { piPackages } : {}), ...(modelCatalog ? { modelCatalog } : {}), ...(security ? { security } : {}) });
  registerSecurityAdministrationRoutes({ app, store, principals, administratorGuard, ...(options.hostingService ? { hosting: options.hostingService } : {}), ...(security ? { security } : {}) });
  registerStorageRoutes({ app, store, artifacts, principals, administratorGuard, ...(storageDurability ? { storageDurability } : {}), ...(security ? { security } : {}) });
  registerSafetyAdministrationRoutes({ app, principals, administratorGuard, ...(safety ? { safety } : {}), ...(security ? { security } : {}) });

  app.addHook("onClose", async () => {
    await lsp.dispose();
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
    lsp,
    sessionQuery,
  };
}

function agentTopologyPresentations(
  routes: UserRouteResolver,
  lifecycle: LifecycleManager,
  ownerUserId: string,
): Record<string, AgentTopologyPresentation> {
  const result: Record<string, AgentTopologyPresentation> = {};
  for (const route of routes.publicRoutes(ownerUserId)) {
    try {
      const resolved = routes.resolve(route.id, ownerUserId, route.id === "fast");
      if (routes.executionClass(route.id, ownerUserId, route.id === "fast") === "self_hosted") {
        const topology = lifecycle.localAgentTopology(resolved.recipe);
        result[route.id] = {
          orchestratorContextTokens: topology.orchestratorContextTokens,
          workerContextTokens: topology.workerContextTokens,
          workerCounts: effortWorkerCounts(() => topology.workerCount),
        };
        continue;
      }
      result[route.id] = {
        orchestratorContextTokens: Math.min(LOCAL_MAIN_CONTEXT_TOKENS, resolved.recipe.contextTokens),
        workerContextTokens: Math.min(LOCAL_WORKER_CONTEXT_TOKENS, resolved.recipe.contextTokens),
        workerCounts: effortWorkerCounts((effort) => cloudWorkerCount(route.id, effort, hasCloudRouteBinding(routes.store, ownerUserId, "fast"))),
      };
    } catch { /* A transiently invalid route is omitted from the capability display. */ }
  }
  return result;
}

function effortWorkerCounts(resolve: (effort: AgentEffort) => number): Record<AgentEffort, number> {
  return { light: resolve("light"), normal: resolve("normal"), high: resolve("high") };
}

function cloudWorkerCount(routeId: string, effort: AgentEffort, hasFastRoute: boolean): number {
  const budget = CLOUD_SUBAGENT_EFFORT_BUDGETS[effort];
  if (routeId === "fast") return budget.fast.fast;
  if (routeId !== "smart") return 0;
  return budget.smart.smart + (hasFastRoute ? budget.smart.fast : 0);
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
  if (existing && existingRecipe && isLocalTextRecipe(existingRecipe)) {
    if (existing.displayName !== "Local") store.upsertRoute({ ...existing, displayName: "Local" });
    return;
  }
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

/** One-way compatibility migration. Agent allocation is runtime policy, so a
 * legacy recipe topology must never survive long enough to affect resolution
 * or be written back by an unrelated recipe edit. */
function discardLegacyRecipeAgentTopologies(store: SqliteStore): void {
  for (const recipe of store.listRecipes()) {
    const persisted = recipe as Recipe & { agentTopology?: unknown };
    if (!("agentTopology" in persisted)) continue;
    const { agentTopology: _legacy, ...current } = persisted;
    store.upsertRecipe(current);
  }
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

function trustedInternalWorkContext(headers: Record<string, string | string[] | undefined>): { runId?: string; ownerUserId?: string; sessionId?: string } {
  const value = (name: string): string | undefined => {
    const candidate = headers[name];
    return typeof candidate === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : undefined;
  };
  const runId = value("x-fitz-run-id");
  const ownerUserId = value("x-fitz-owner-user-id");
  const sessionId = value("x-fitz-session-id");
  return { ...(runId ? { runId } : {}), ...(ownerUserId ? { ownerUserId } : {}), ...(sessionId ? { sessionId } : {}) };
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

function toNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function canAccessOwner(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId; }
function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  const address = request.ip.startsWith("::ffff:") ? request.ip.slice("::ffff:".length) : request.ip;
  if (address !== "127.0.0.1" && address !== "::1") return false;
  const proxyHeaders = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-user-profile-pic",
  ];
  return proxyHeaders.every((name) => request.headers[name] === undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
