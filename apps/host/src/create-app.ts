import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import {
  type EngineAdapter,
  type MediaEngineAdapter,
  EngineAdapterRegistry,
  InferenceScheduler,
  LifecycleEventBus,
  LifecycleManager,
  GpuThermalGuard,
  RecipeNotFoundError,
  RouteNotFoundError,
  RouteResolver,
  ResourceGovernor,
  SystemResourceMonitor,
  type ResourceMonitor,
  type ResourcePolicy,
} from "@fitz/inference-core";
import {
  parseChatCompletionRequest,
  PROTOCOL_VERSION,
  type InferenceDelta,
  type ModelListResponse,
  type OpenAIErrorResponse,
  type EngineConnectionMode,
  type EngineRegistration,
  type EngineRuntime,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
  type MediaGenerationParams,
  type MediaJobRecord,
  type MediaJobStatus,
  type MediaModality,
  type ModalityCapabilities,
  type ModalityInput,
  type Recipe,
  type Route,
  type RouteKind,
  type VideoGenerationRequest,
  type VideoGenerationResponse,
  type AgentRunRequest,
  type SessionRecord,
  type ToolPolicyRecord,
} from "@fitz/protocol";
import { MetricsRegistry, redactSecrets } from "@fitz/observability";
import { DEFAULT_QUOTAS, SecurityPolicyError, SecurityService, type AuthenticatedPrincipal } from "@fitz/security";
import { SqliteStore, type MediaJobEventEnvelope } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import { DownloadNotFoundError, type ModelCatalogService } from "./model-catalog.js";
import { AgentRunCoordinator } from "./agent-runs.js";
import { MediaJobCoordinator } from "./media-jobs.js";
import type { AgentRuntime } from "@fitz/agent-core";
import type { PiPackageService } from "@fitz/agent-pi";
import { ContextManager } from "@fitz/context";
import { TailscaleMonitor, TailscaleServeManager, WindowsStartupManager } from "@fitz/connectivity";
import { classifyArtifact, normalizeMimeType } from "@fitz/media";
import { OpenAICompatibleClient, OpenAICompatibleEngineAdapter, supportsChatCompletions, type OpenAICompatibleModel } from "@fitz/engine-openai-compatible";
import {
  FAL_DEFAULT_BASE_URL,
  FalProvider,
  MediaProviderRegistry,
  OpenAICompatibleMediaProvider,
  REPLICATE_DEFAULT_BASE_URL,
  ReplicateProvider,
  type ProviderModel,
} from "@fitz/media-providers";
import { MediaProviderEngineAdapter } from "./media-provider-adapter.js";
import type { AgentSafetyService } from "./agent-safety/index.js";

const MEDIA_TOOL_NAMES = new Set(["generate_image", "generate_video", "generate_audio"]);

interface ConsumerModelRegistration { modelId: string; routeId: string; recipeId: string }
interface ConsumerMediaModelRegistration { modelId: string; recipeId: string; routeId: string; modality: MediaModality; template: string }
interface ConsumerConnectionRegistration {
  id: string;
  displayName: string;
  baseUrl: string;
  authType: "none" | "bearer";
  credentialEnv: string;
  template: string;
  models: ConsumerModelRegistration[];
  /** Media recipes/routes created for this connection (§5.7): one entry per
   *  (model, modality), one recipe per model. */
  mediaModels: ConsumerMediaModelRegistration[];
  updatedAt: string;
}

const CONSUMER_ROUTE_PREFIX = "consumer--";
const PUBLIC_ROUTE_IDS = new Set(["fast", "default", "smart"]);
const LOCAL_CONNECTION_ID = "hosted--local";
/** Exactly three well-known media route ids (§5.2); created disabled + unassigned. */
const MEDIA_ROUTE_IDS = ["image", "video", "audio"] as const;
const MEDIA_ROUTE_DISPLAY_NAMES: Record<(typeof MEDIA_ROUTE_IDS)[number], string> = {
  image: "Image generation",
  video: "Video generation",
  audio: "Audio generation",
};
/** Minimal probe prompts for the management media-test diagnostic (§5.10). */
const MEDIA_TEST_PROMPTS: Record<MediaModality, string> = {
  image: "A single red cube on a plain gray background, product-photo style.",
  video: "A red cube slowly rotating on a plain gray background.",
  audio: "A short ascending major scale played on a piano.",
};
/** Connection templates (§5.7): chat-only, or one of the media provider
 *  templates. `body.template` defaults to `openai-compatible`. */
const CONSUMER_TEMPLATES = ["openai-compatible", "openai-media", "fal", "replicate"] as const;
const MEDIA_TEMPLATES = ["openai-media", "fal", "replicate"] as const;
const MEDIA_TEMPLATE_DEFAULT_BASE_URLS: Readonly<Record<string, string | undefined>> = {
  "openai-media": undefined, // required — the user's own OpenAI-compatible media endpoint
  fal: FAL_DEFAULT_BASE_URL,
  replicate: REPLICATE_DEFAULT_BASE_URL,
};

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
  /** The host safety layer (policy engine, snapshots, trash, redaction). Optional so tests can run without it. */
  safety?: AgentSafetyService;
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
  const authMode = options.authMode ?? "disabled";
  const security = options.security ?? (authMode === "required" ? new SecurityService(store, options.authPepper ?? "") : undefined);
  const recoveredInterruptedRequests = store.recoverInterruptedRequests();
  const recoveredAgentRuns = store.recoverInterruptedAgentRuns();
  const recoveredToolApprovals = store.recoverInterruptedToolApprovals();
  const recoveredMediaJobs = store.recoverInterruptedMediaJobs();
  seedDefaults(
    store,
    options.initialRecipes ?? DEFAULT_RECIPES,
    options.initialRoutes ?? DEFAULT_ROUTES,
  );
  const storedEngineRoot = store.getSetting<string>("engineRoot");
  const legacyEngineRoot = join(homedir(), "Fitz", "engines");
  const previousEngineRoot = join(homedir(), "engines");
  const configuredEngineRoot = options.engineRoot ?? (
    !storedEngineRoot
      || resolve(storedEngineRoot) === resolve(legacyEngineRoot)
      || resolve(storedEngineRoot) === resolve(previousEngineRoot)
      ? join(homedir(), "llm", "engines")
      : storedEngineRoot
  );
  store.setSetting("engineRoot", configuredEngineRoot);
  migrateLegacyEngineRegistry(store);
  const routes = new RouteResolver(store.listRoutes(), store.listRecipes());
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
  const localRecipes = [...new Map(routes.listRoutes().filter((route) => PUBLIC_ROUTE_IDS.has(route.id)).map((route) => {
    const recipe = routes.resolve(route.id).recipe;
    return [recipe.id, recipe] as const;
  })).values()].filter((recipe) => recipe.adapter !== "openai-compatible");
  void Promise.allSettled(localRecipes.map((recipe) => lifecycle.prepare(recipe)));
  const scheduler = new InferenceScheduler(routes, lifecycle, events);
  const agentRuns = new AgentRunCoordinator(store, scheduler, options.agentRuntime, options.safety ? (runId) => void options.safety!.collect().catch(() => undefined) : undefined);
  const mediaJobs = new MediaJobCoordinator({ store, scheduler, routes, ...(security ? { security } : {}) });
  const mediaImageTimeoutMs = options.mediaImageTimeoutMs ?? 120_000;
  const context = options.contextManager ?? new ContextManager(store);
  const tailscale = options.tailscaleMonitor ?? new TailscaleMonitor();
  const tailscaleServe = options.tailscaleServeManager ?? new TailscaleServeManager();
  const startup = options.startupManager;
  const piPackages = options.piPackages;
  const modelCatalog = options.modelCatalog;
  const safety = options.safety;
  const metrics = new MetricsRegistry();
  const unsubscribePersistence = events.subscribe((event) => {
    store.appendLifecycleEvent(event);
    // Media jobs never persist to `inference_requests` — they have their own
    // `media_jobs` records and event stream (§5.5).
    if (event.type === "queue.updated" && event.data.kind !== "media") store.recordQueueEvent(event);
  });
  const unsubscribeMetrics = events.subscribe((event) => metrics.observeLifecycleEvent(event));
  const requestStarts = new WeakMap<object, number>();
  const principals = new WeakMap<object, AuthenticatedPrincipal>();
  const consumerConnections = (): ConsumerConnectionRegistration[] => store.getSetting<ConsumerConnectionRegistration[]>("consumerConnections") ?? [];
  const activeRoutes = (): Route[] => routes.listRoutes();
  const publicRoutes = (): Route[] => activeRoutes().filter((route) => PUBLIC_ROUTE_IDS.has(route.id));
  const resolveActiveRoute = (routeId: string) => routes.resolve(routeId);
  // Routes are global: exactly one fast/default/smart slot, each pointing at a single
  // recipe from any connection (local or cloud). Sessions may still carry a connectionId
  // from before this model, but resolution never depends on it. Legacy scoped route ids
  // (consumer--<connection>--route--<class> and consumer--<class>) collapse to the class.
  const normalizePublicRouteId = (routeId: string): string => {
    if (PUBLIC_ROUTE_IDS.has(routeId)) return routeId;
    const scoped = /^consumer--.+--route--(fast|default|smart)$/.exec(routeId);
    if (scoped) return scoped[1]!;
    const legacy = /^consumer--(fast|default|smart)$/.exec(routeId);
    if (legacy) return legacy[1]!;
    return routeId;
  };
  const resolveSessionRouteId = (_session: SessionRecord | undefined, requestedRouteId: string): string => normalizePublicRouteId(requestedRouteId);

  app.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, performance.now());
    const publicPath = request.url.split("?")[0];
    if (authMode === "required" && publicPath !== "/health" && publicPath !== "/api/v1/pairing/redeem" && publicPath !== "/api/v1/pairing/bootstrap") {
      const principal = security?.authenticate(request.headers.authorization);
      const internalAgent = publicPath === "/v1/chat/completions" && validBearerToken(request.headers.authorization, options.internalAgentToken);
      if (!principal && !internalAgent) return reply.code(401).send({ error: "Valid device bearer token required" });
      if (principal) principals.set(request, principal);
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStarts.get(request);
    if (startedAt !== undefined) metrics.observe("http_request_duration_ms", performance.now() - startedAt);
    metrics.increment("http_requests_total");
    metrics.increment(`http_responses_${reply.statusCode}_total`);
  });

  app.get("/health", async () => {
    const resourceSnapshot = await resources.snapshot();
    return {
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      engine: lifecycle.snapshot(),
      queueDepth: scheduler.queueDepth,
      resources: { ...resourceSnapshot, policy: resources.policy },
      recovery: { interruptedRequests: recoveredInterruptedRequests, interruptedAgentRuns: recoveredAgentRuns, interruptedToolApprovals: recoveredToolApprovals, interruptedMediaJobs: recoveredMediaJobs },
    };
  });
  app.get("/api/v1/me", async (request) => { const principal = principals.get(request); return { data: principal ? { authMode: "required", user: principal.user, device: principal.device, routeIds: principal.routeGrants, quota: principal.quota } : { authMode: "disabled" } }; });
  app.post("/api/v1/inference/warm", async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const publicRouteId = requirePublicRouteId(body.model);
      const principal = principals.get(request);
      if (principal && !security?.authorizeRoute(principal, publicRouteId)) return reply.code(403).send({ error: "Route access denied" });
      const resolved = resolveActiveRoute(publicRouteId);
      return { data: await lifecycle.warm(resolved.recipe) };
    } catch (error) { return reply.code(error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); }
  });

  app.post("/api/v1/pairing/bootstrap", async (request, reply) => {
    if (!isDirectLoopbackRequest(request)) return reply.code(403).send({ error: "Initial administration setup is only available directly on the host" });
    if (authMode !== "required" || !security) return reply.code(409).send({ error: "Device authentication is not enabled" });
    if (store.listUsers().length > 0) return reply.code(409).send({ error: "The host has already been initialized" });
    const administrator = security.createUser(`${hostname()} Administrator`, "administrator");
    const issued = security.issueDevice(administrator.id, `${hostname()} Desktop`);
    security.setRouteGrants(administrator.id, publicRoutes().map((route) => route.id));
    security.audit("security.bootstrapped", administrator.id, "user", administrator.id);
    return reply.code(201).send({ data: { user: administrator, device: issued.device, token: issued.token } });
  });

  app.get("/v1/models", async (request): Promise<ModelListResponse> => ({
    object: "list",
    data: publicRoutes().filter((route) => {
      const principal = principals.get(request);
      return !principal || security?.authorizeRoute(principal, route.id);
    }).map((route) => ({
      id: route.id,
      object: "model",
      created: 0,
      owned_by: "fitz",
      display_name: route.displayName,
      ...(route.description ? { description: route.description } : {}),
    })),
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    let body;
    let model: string;
    try {
      body = parseChatCompletionRequest(request.body);
      model = normalizePublicRouteId(body.model);
      const resolved = resolveActiveRoute(model);
      const principal = principals.get(request);
      if (principal && !security?.authorizeRoute(principal, model)) {
        return reply.code(403).send(openAIError(new SecurityPolicyError("Route access denied"), "permission_error"));
      }
      if (principal) {
        const promptChars = body.messages.reduce((total, message) => total + contentTextLength(message.content), 0);
        security?.enforceQuota(principal, promptChars, body.max_tokens ?? principal.quota.maxOutputTokens, scheduler.queueDepth);
      }
      if (!resolved.recipe.capabilities.chatCompletions) {
        throw new TypeError(`Route ${model} does not support chat completions`);
      }
      if (body.stream !== false && !resolved.recipe.capabilities.streaming) {
        throw new TypeError(`Route ${model} does not support streaming`);
      }
      if (body.tools?.length && !resolved.recipe.capabilities.toolCalls) {
        throw new TypeError(`Route ${model} does not support tool calls`);
      }
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send(openAIError(error, "invalid_request_error"));
    }

    const stream = scheduler.enqueue(model, {
      messages: body.messages,
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.stop !== undefined ? { stop: body.stop } : {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
      ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
      ...(body.parallel_tool_calls !== undefined ? { parallelToolCalls: body.parallel_tool_calls } : {}),
      ...(principals.get(request) ? { userId: principals.get(request)!.user.id } : body.user !== undefined ? { userId: body.user } : {}),
    });

    if (body.stream === false) {
      try {
        return await collectCompletion(stream.requestId, model, stream);
      } catch (error) {
        const statusCode = error instanceof RouteNotFoundError ? 404 : 502;
        return reply.code(statusCode).send(openAIError(error, "server_error"));
      }
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const created = Math.floor(Date.now() / 1_000);
    const completionId = `chatcmpl-${stream.requestId}`;
    const abort = () => stream.cancel();
    request.raw.once("aborted", abort);
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) abort();
    });

    writeSse(reply, streamChunk(completionId, created, model, { role: "assistant" }, null));
    try {
      for await (const delta of stream) {
        writeSse(
          reply,
          streamChunk(
            completionId,
            created,
            model,
            {
              ...(delta.text ? { content: delta.text } : {}),
              ...(delta.toolCalls?.length ? { tool_calls: delta.toolCalls } : {}),
            },
            delta.finishReason ?? null,
          ),
        );
      }
      reply.raw.write("data: [DONE]\n\n");
    } catch (error) {
      writeSse(reply, openAIError(error, "server_error"));
      reply.raw.write("data: [DONE]\n\n");
    } finally {
      reply.raw.end();
    }
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
  app.post("/api/v1/pairing/redeem", async (request, reply) => { try { const body = requireRecord(request.body); const access = securityRequired(security); const redeemed = access.redeemPairingCode(requireString(body.code, "code"), requireString(body.displayName, "displayName"), requireString(body.deviceName, "deviceName")); access.setRouteGrants(redeemed.user.id, publicRoutes().map((route) => route.id)); return reply.code(201).send({ data: redeemed }); } catch (error) { return reply.code(error instanceof SecurityPolicyError ? 403 : 400).send({ error: errorMessage(error) }); } });

  app.post("/api/v1/agent/runs", async (request, reply) => {
    try {
      const body = parseAgentRunRequest(request.body); const principal = principals.get(request);
      const session = body.sessionId ? store.getSession(body.sessionId) : undefined;
      if (body.sessionId) { if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); }
      if (principal && !security?.authorizeRoute(principal, body.model)) return reply.code(403).send({ error: "Route access denied" });
      if (principal) { const promptChars = body.messages.reduce((total, message) => total + contentTextLength(message.content), 0); security?.enforceQuota(principal, promptChars, body.maxTokens ?? principal.quota.maxOutputTokens, agentRuns.queue().length); }
      const executionRouteId = normalizePublicRouteId(body.model);
      const resolved = resolveActiveRoute(executionRouteId); const prepared = await context.prepare({ ...body, model: executionRouteId }, resolved.recipe.contextTokens); const run = agentRuns.start(prepared.request, principal?.user.id, body.messages); security?.audit("agent-run.created", principal?.user.id, "agent-run", run.id, { routeId: run.routeId, connectionId: session?.connectionId, publicRouteId: body.model, compacted: prepared.compacted });
      return reply.code(202).send({ protocolVersion: PROTOCOL_VERSION, data: run, queue: agentRuns.queue(principal?.user.role === "administrator" ? undefined : principal?.user.id).find((item) => item.runId === run.id), context: { compacted: prepared.compacted, estimatedInputTokens: prepared.estimatedInputTokens, budgetTokens: prepared.budgetTokens, estimatedContextTokens: prepared.estimatedContextTokens } });
    } catch (error) { return reply.code(error instanceof SecurityPolicyError ? 429 : error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/agent/runs", async (request) => { const principal = principals.get(request); const query = request.query as { limit?: string }; return { protocolVersion: PROTOCOL_VERSION, data: agentRuns.list(principal?.user.role === "administrator" ? undefined : principal?.user.id, Math.min(toNonNegativeInteger(query.limit, 100), 1000)) }; });
  app.get("/api/v1/agent/queue", async (request) => { const principal = principals.get(request); return { protocolVersion: PROTOCOL_VERSION, data: agentRuns.queue(principal?.user.role === "administrator" ? undefined : principal?.user.id) }; });
  app.get("/api/v1/agent/runs/:runId", async (request, reply) => { const run = agentRuns.get((request.params as { runId: string }).runId); if (!run) return reply.code(404).send({ error: "Run not found" }); if (!canAccessRun(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" }); return { protocolVersion: PROTOCOL_VERSION, data: run }; });
  app.delete("/api/v1/agent/runs/:runId", async (request, reply) => { const runId = (request.params as { runId: string }).runId; const run = agentRuns.get(runId); if (!run) return reply.code(404).send({ error: "Run not found" }); if (!canAccessRun(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" }); if (!agentRuns.cancel(runId)) return reply.code(409).send({ error: "Run is no longer active" }); return reply.code(202).send({ data: { id: runId, cancellationRequested: true } }); });
  app.post("/api/v1/agent/runs/:runId/steer", async (request, reply) => {
    try {
      const runId = (request.params as { runId: string }).runId;
      const run = agentRuns.get(runId);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (!canAccessRun(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
      const text = requireString(requireRecord(request.body).text, "text").trim();
      if (!text) throw new TypeError("text must not be empty");
      try {
        const steered = await agentRuns.steer(runId, text);
        if (!steered) return reply.code(409).send({ error: "This run cannot be steered right now" });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
      security?.audit("agent-run.steered", principals.get(request)?.user.id, "agent-run", runId, { routeId: run.routeId });
      return { data: { id: runId, steered: true } };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.get("/api/v1/agent/runs/:runId/events", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId; const run = agentRuns.get(runId); if (!run) return reply.code(404).send({ error: "Run not found" }); if (!canAccessRun(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
    const query = request.query as { after?: string; stream?: string }; const headerAfter = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined; const after = toNonNegativeInteger(query.after ?? headerAfter, 0);
    if (query.stream !== "true" && !String(request.headers.accept ?? "").includes("text/event-stream")) return { protocolVersion: PROTOCOL_VERSION, run: agentRuns.get(runId), events: agentRuns.eventsAfter(runId, after) };
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); let last = after;
    const send = (event: { sequence: number; type: string }) => { if (event.sequence <= last) return; last = event.sequence; reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    const unsubscribe = agentRuns.subscribe(runId, (event) => { send(event); if (isTerminalAgentEvent(event.type)) { unsubscribe(); reply.raw.end(); } }); for (const event of agentRuns.eventsAfter(runId, after)) send(event);
    if (isTerminalRun(agentRuns.get(runId)?.status)) { unsubscribe(); reply.raw.end(); } else request.raw.once("aborted", unsubscribe);
  });

  app.post("/api/v1/media/jobs", async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const routeId = typeof body.routeId === "string" ? body.routeId : typeof body.model === "string" ? body.model : undefined;
      if (!routeId) throw new TypeError("routeId is required");
      const modality = parseModality(body.modality);
      const principal = principals.get(request);
      const job = mediaJobs.submit({
        routeId,
        modality,
        params: parseMediaParams(body.params),
        ...(typeof body.sessionId === "string" && body.sessionId ? { sessionId: body.sessionId } : {}),
      }, principal);
      security?.audit("media-job.created", principal?.user.id, "media-job", job.id, { routeId, modality, status: job.status });
      return reply.code(202).send({ data: job });
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send({ error: errorMessage(error) });
    }
  });
  app.get("/api/v1/media/jobs", async (request) => {
    const principal = principals.get(request);
    const query = request.query as { sessionId?: string; status?: string; limit?: string };
    const status = parseMediaStatus(query.status);
    return {
      data: mediaJobs.list({
        ...(principal === undefined || principal.user.role === "administrator" ? {} : { ownerUserId: principal.user.id }),
        ...(typeof query.sessionId === "string" && query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(status ? { status } : {}),
        limit: Math.min(toNonNegativeInteger(query.limit, 100), 1000),
      }),
    };
  });
  app.get("/api/v1/media/jobs/:jobId", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    if (!canAccessMediaJob(principals.get(request), job)) return reply.code(403).send({ error: "Media job access denied" });
    return { data: job };
  });
  app.post("/api/v1/media/jobs/:jobId/cancel", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    if (!canAccessMediaJob(principals.get(request), job)) return reply.code(403).send({ error: "Media job access denied" });
    if (!mediaJobs.cancel(jobId)) return reply.code(409).send({ error: "Media job is no longer active" });
    security?.audit("media-job.cancelled", principals.get(request)?.user.id, "media-job", jobId);
    return reply.code(202).send({ data: { id: jobId, cancellationRequested: true } });
  });
  app.post("/api/v1/media/jobs/:jobId/retry", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const original = mediaJobs.get(jobId);
    if (!original) return reply.code(404).send({ error: "Media job not found" });
    const principal = principals.get(request);
    if (!canAccessMediaJob(principal, original)) return reply.code(403).send({ error: "Media job access denied" });
    if (!isTerminalMediaStatus(original.status)) return reply.code(409).send({ error: "Only terminal media jobs can be retried" });
    try {
      const retried = mediaJobs.submit({
        routeId: original.routeId,
        modality: original.modality,
        params: original.params,
        ...(original.sessionId ? { sessionId: original.sessionId } : {}),
        ...(!principal && original.createdByUserId ? { userId: original.createdByUserId } : {}),
      }, principal);
      security?.audit("media-job.retried", principal?.user.id, "media-job", retried.id, { originalJobId: original.id, routeId: original.routeId, modality: original.modality });
      return reply.code(202).send({ data: retried });
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send({ error: errorMessage(error) });
    }
  });
  app.get("/api/v1/media/jobs/:jobId/events", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    if (!canAccessMediaJob(principals.get(request), job)) return reply.code(403).send({ error: "Media job access denied" });
    const query = request.query as { after?: string; stream?: string };
    const headerAfter = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined;
    const after = toNonNegativeInteger(query.after ?? headerAfter, 0);
    if (query.stream !== "true" && !String(request.headers.accept ?? "").includes("text/event-stream")) {
      return { data: mediaJobs.eventsAfter(jobId, after) };
    }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    let last = after;
    const send = (event: MediaJobEventEnvelope) => { if (event.sequence <= last) return; last = event.sequence; reply.raw.write(`id: ${event.sequence}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
    const unsubscribe = mediaJobs.subscribe(jobId, (event) => { send(event); if (isTerminalMediaEvent(event.event.type)) { unsubscribe(); reply.raw.end(); } });
    for (const event of mediaJobs.eventsAfter(jobId, after)) send(event);
    if (isTerminalMediaStatus(mediaJobs.get(jobId)?.status)) { unsubscribe(); reply.raw.end(); } else request.raw.once("aborted", unsubscribe);
  });

  // OpenAI-shaped media gateway (§5.8): consumed by Fitz's own clients only.
  app.post("/v1/images/generations", async (request, reply) => {
    try {
      const body = parseImageGenerationRequest(request.body);
      const principal = principals.get(request);
      const job = mediaJobs.submit({
        routeId: body.model,
        modality: "image",
        params: {
          prompt: body.prompt,
          ...(body.size ? { size: body.size } : {}),
        },
      }, principal);
      security?.audit("media-job.created", principal?.user.id, "media-job", job.id, { routeId: body.model, modality: "image", gateway: "images" });
      const terminal = await awaitMediaJob(mediaJobs, job.id, mediaImageTimeoutMs);
      if (terminal.status === "completed" && terminal.artifactId) {
        const artifact = store.getArtifact(terminal.artifactId);
        const bytes = artifact ? store.getArtifactContent(artifact.id) : undefined;
        if (!artifact || !bytes) throw new Error("Generated artifact is missing");
        const response: ImageGenerationResponse = {
          created: Math.floor(Date.now() / 1000),
          data: body.response_format === "b64_json"
            ? [{ b64_json: Buffer.from(bytes).toString("base64") }]
            : [{ url: `${requestOrigin(request)}/api/v1/artifacts/${artifact.id}/content` }],
        };
        security?.audit("media-job.completed", principal?.user.id, "media-job", job.id, { artifactId: artifact.id, gateway: "images" });
        return response;
      }
      if (terminal.status === "failed") {
        return reply.code(502).send({ error: { message: mediaJobFailureMessage(store, terminal), type: "media_generation_failed", param: job.id, code: "media_generation_failed" } });
      }
      if (terminal.status === "cancelled") {
        return reply.code(409).send({ error: { message: "Image generation was cancelled", type: "media_generation_cancelled", param: job.id, code: "media_generation_cancelled" } });
      }
      return reply.code(502).send({ error: { message: `Image generation ended with status ${terminal.status}`, type: "media_generation_failed", param: job.id, code: "media_generation_failed" } });
    } catch (error) {
      if (error instanceof MediaGenerationTimeoutError) {
        return reply.code(504).send({ error: { message: `Image generation timed out; resume polling GET /api/v1/media/jobs/${error.jobId}`, type: "media_generation_timeout", param: error.jobId, code: "media_generation_timeout" } });
      }
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send(openAIError(error, "invalid_request_error"));
    }
  });
  app.post("/v1/videos/generations", async (request, reply) => {
    try {
      const body = parseVideoGenerationRequest(request.body);
      const principal = principals.get(request);
      const job = mediaJobs.submit({
        routeId: body.model,
        modality: "video",
        params: {
          prompt: body.prompt,
          ...(body.duration !== undefined ? { durationSeconds: body.duration } : {}),
          ...(body.resolution ? { size: body.resolution } : {}),
        },
      }, principal);
      security?.audit("media-job.created", principal?.user.id, "media-job", job.id, { routeId: body.model, modality: "video", gateway: "videos" });
      const response: VideoGenerationResponse = {
        id: job.id,
        object: "video.generation",
        status: job.status,
        createdAt: job.enqueuedAt,
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
        ...(job.artifactId ? { artifactId: job.artifactId } : {}),
        ...(job.errorCode ? { error: job.errorCode } : {}),
      };
      return reply.code(202).send(response);
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send(openAIError(error, "invalid_request_error"));
    }
  });
  app.post("/v1/audio/generations", async (_request, reply) => {
    // KD-6: audio generation is deferred; the endpoint exists so clients see a
    // stable shape instead of a route miss (§5.8).
    return reply.code(501).send({ error: { message: "Audio generation is not available yet", type: "not_implemented" } });
  });

  app.get("/api/v1/projects", async (request) => { const principal = principals.get(request); return { data: store.listProjects(principal?.user.role === "administrator" ? undefined : principal?.user.id) }; });
  app.post("/api/v1/projects", async (request, reply) => { try { const body = requireRecord(request.body); const principal = principals.get(request); const now = new Date().toISOString(); const project = { id: randomUUID(), name: requireString(body.name, "name"), createdAt: now, updatedAt: now, ...(principal ? { ownerUserId: principal.user.id } : {}), ...(typeof body.rootPath === "string" ? { rootPath: body.rootPath } : {}) }; store.createProject(project); security?.audit("project.created", principal?.user.id, "project", project.id); return reply.code(201).send({ data: project }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/projects/:projectId", async (request, reply) => { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); if (!canAccessOwner(principals.get(request), project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); return { data: project }; });
  app.patch("/api/v1/projects/:projectId", async (request, reply) => { try { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); if (!canAccessOwner(principals.get(request), project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); const body = requireRecord(request.body); const updated = { ...project, ...(typeof body.name === "string" ? { name: requireString(body.name, "name") } : {}), ...(typeof body.rootPath === "string" ? { rootPath: body.rootPath } : {}), updatedAt: new Date().toISOString() }; store.updateProject(updated); return { data: updated }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/projects/:projectId", async (request, reply) => { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); store.deleteProject(project.id); security?.audit("project.deleted", principal?.user.id, "project", project.id, { name: project.name }); return reply.code(204).send(); });
  app.get("/api/v1/projects/:projectId/sessions", async (request, reply) => { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); return { data: store.listSessions(project.id, principal?.user.role === "administrator" ? undefined : principal?.user.id) }; });
  app.post("/api/v1/projects/:projectId/sessions", async (request, reply) => { try { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); const body = requireRecord(request.body); const now = new Date().toISOString(); const routeId = requirePublicRouteId(body.routeId); const connectionId = typeof body.connectionId === "string" && body.connectionId.trim() ? body.connectionId.trim() : LOCAL_CONNECTION_ID; const session: SessionRecord = { id: randomUUID(), projectId: project.id, title: requireString(body.title, "title"), status: "active" as const, connectionId, routeId, createdAt: now, updatedAt: now, ...(principal ? { ownerUserId: principal.user.id } : {}) }; store.createSession(session); security?.audit("session.created", principal?.user.id, "session", session.id, { projectId: project.id, connectionId, routeId }); return reply.code(201).send({ data: session }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/chats", async (request) => { const principal = principals.get(request); return { data: store.listStandaloneSessions(principal?.user.role === "administrator" ? undefined : principal?.user.id) }; });
  app.post("/api/v1/chats", async (request, reply) => { try { const body = requireRecord(request.body); const principal = principals.get(request); const now = new Date().toISOString(); const routeId = requirePublicRouteId(body.routeId); const connectionId = typeof body.connectionId === "string" && body.connectionId.trim() ? body.connectionId.trim() : LOCAL_CONNECTION_ID; const session: SessionRecord = { id: randomUUID(), title: requireString(body.title, "title"), status: "active" as const, connectionId, routeId, createdAt: now, updatedAt: now, ...(principal ? { ownerUserId: principal.user.id } : {}) }; store.createSession(session); security?.audit("session.created", principal?.user.id, "session", session.id, { connectionId, routeId }); return reply.code(201).send({ data: session }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); return { data: session }; });
  app.patch("/api/v1/sessions/:sessionId", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = requireRecord(request.body); const updated: SessionRecord = { ...session, ...(typeof body.title === "string" ? { title: requireString(body.title, "title") } : {}), ...(body.status === "active" || body.status === "archived" ? { status: body.status } : {}), ...(typeof body.connectionId === "string" && body.connectionId.trim() ? { connectionId: body.connectionId.trim() } : {}), ...(body.routeId !== undefined ? { routeId: requirePublicRouteId(body.routeId) } : {}), updatedAt: new Date().toISOString() }; store.updateSession(updated); return { data: updated }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId/transcript", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const query = request.query as { after?: string; limit?: string }; return { data: store.transcriptAfter(session.id, toNonNegativeInteger(query.after, 0), Math.min(toNonNegativeInteger(query.limit, 1000), 1000)) }; });
  app.post("/api/v1/sessions/:sessionId/compact", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = isRecord(request.body) ? request.body : {}; const publicRouteId = typeof body.model === "string" ? requireString(body.model, "model") : session.routeId ?? "default"; const routeId = resolveSessionRouteId(session, publicRouteId); const resolved = resolveActiveRoute(routeId); const result = await context.compactSession(session.id, resolved.recipe.contextTokens); security?.audit("session.compacted", principal?.user.id, "session", session.id, { routeId, throughSequence: result.entry.content.throughSequence }); return { data: result }; } catch (error) { return reply.code(error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId/artifacts", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); return { data: store.listArtifacts(session.id) }; });
  app.post("/api/v1/sessions/:sessionId/artifacts", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = requireRecord(request.body); const name = requireString(body.name, "name"); const mimeType = normalizeMimeType(requireString(body.mimeType, "mimeType")); const content = decodeBase64(body.contentBase64); if (content.byteLength > 5_000_000) throw new TypeError("Artifact exceeds the 5000000 byte limit"); const artifact = { id: randomUUID(), sessionId: session.id, name, mimeType, kind: classifyArtifact(mimeType, name), byteSize: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"), createdAt: new Date().toISOString(), metadata: isRecord(body.metadata) ? body.metadata : {}, ...(principal ? { createdByUserId: principal.user.id } : {}) }; store.createArtifact(artifact, content); security?.audit("artifact.created", principal?.user.id, "artifact", artifact.id, { sessionId: session.id, mimeType, byteSize: artifact.byteSize }); return reply.code(201).send({ data: artifact }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/artifacts/:artifactId/content", async (request, reply) => {
    const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    const session = store.getSession(artifact.sessionId);
    if (!session || !canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Artifact access denied" });
    const content = store.getArtifactContent(artifact.id);
    if (!content) return reply.code(404).send({ error: "Artifact content not found" });
    const range = resolveByteRange(request.headers.range, content.byteLength);
    if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${content.byteLength}`).send();
    const base = () => reply.header("accept-ranges", "bytes").header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox; default-src 'none'").header("content-disposition", `attachment; filename="${safeFilename(artifact.name)}"`).type(artifact.mimeType);
    if (range === null) return base().send(Buffer.from(content));
    return base().code(206).header("content-range", `bytes ${range.start}-${range.end}/${content.byteLength}`).send(Buffer.from(content.subarray(range.start, range.end + 1)));
  });
  app.delete("/api/v1/artifacts/:artifactId", async (request, reply) => { const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId); if (!artifact) return reply.code(404).send({ error: "Artifact not found" }); const session = store.getSession(artifact.sessionId); const principal = principals.get(request); if (!session || !canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Artifact access denied" }); store.deleteArtifact(artifact.id); security?.audit("artifact.deleted", principal?.user.id, "artifact", artifact.id, { sessionId: artifact.sessionId, name: artifact.name }); return reply.code(204).send(); });
  app.post("/api/v1/sessions/:sessionId/tool-approvals", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = requireRecord(request.body); const toolName = requireString(body.toolName, "toolName"); const decision = store.resolveToolPolicy(principal?.user.id, principal?.user.role, toolName); const now = new Date().toISOString(); const approval = { id: randomUUID(), sessionId: session.id, toolCallId: requireString(body.toolCallId, "toolCallId"), toolName, status: decision === "allow" ? "approved" as const : decision === "deny" ? "denied" as const : "pending" as const, request: isRecord(body.request) ? body.request : {}, requestedAt: now, ...(typeof body.runId === "string" ? { runId: body.runId } : {}), ...(decision !== "ask" ? { resolvedAt: now } : {}) }; store.createToolApproval(approval); security?.audit("tool-approval.requested", principal?.user.id, "tool-approval", approval.id, { toolName, decision }); return reply.code(201).send({ data: approval }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId/tool-approvals", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const query = request.query as { status?: string }; return { data: store.listToolApprovals(session.id, parseApprovalStatus(query.status)) }; });
  app.post("/api/v1/tool-approvals/:approvalId/decision", async (request, reply) => {
    try {
      const approval = store.getToolApproval((request.params as { approvalId: string }).approvalId);
      if (!approval) return reply.code(404).send({ error: "Approval not found" });
      const session = store.getSession(approval.sessionId);
      if (!session || !canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Approval access denied" });
      const body = requireRecord(request.body);
      if (body.decision !== "approved" && body.decision !== "denied") throw new TypeError("decision must be approved or denied");
      const amendedRequest = body.decision === "approved" && MEDIA_TOOL_NAMES.has(approval.toolName) && isRecord(body.request)
        ? parseMediaApprovalRequest(approval.toolName, approval.request, body.request)
        : undefined;
      const principal = principals.get(request);
      if (!store.resolveToolApproval(approval.id, body.decision, principal?.user.id, typeof body.note === "string" ? body.note : undefined, amendedRequest)) return reply.code(409).send({ error: "Approval is no longer pending" });
      security?.audit("tool-approval.resolved", principal?.user.id, "tool-approval", approval.id, { decision: body.decision, amended: Boolean(amendedRequest) });
      return { data: store.getToolApproval(approval.id) };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });

  app.get(
    "/api/v1/management/status",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async () => {
      const resourceSnapshot = await resources.snapshot();
      return {
        engine: lifecycle.snapshot(),
        queueDepth: scheduler.queueDepth,
        resources: { ...resourceSnapshot, policy: resources.policy },
        routes: routes.listRoutes(true),
        recipes: routes.listRecipes(),
        engines: store.listEngines(),
        hostName: hostname(),
        engineRoot: store.getSetting<string>("engineRoot") ?? configuredEngineRoot,
        engineFolders: scanEngineFolders(store.getSetting<string>("engineRoot") ?? configuredEngineRoot, store.listEngines()),
        recoveredInterruptedRequests,
        recoveredAgentRuns,
        recoveredToolApprovals,
        recoveredMediaJobs,
      };
    },
  );

  app.get(
    "/api/v1/management/connections",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async () => ({ data: consumerConnections().map(publicConsumerConnection) }),
  );

  app.put(
    "/api/v1/management/connections/:connectionId",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const connectionId = requireIdentifier((request.params as { connectionId: string }).connectionId, "connectionId");
      try {
        const body = requireRecord(request.body);
        const displayName = requireString(body.displayName, "displayName");
        const template = parseConsumerTemplate(body.template);
        const baseUrl = normalizeConsumerBaseUrl(body.baseUrl === undefined ? MEDIA_TEMPLATE_DEFAULT_BASE_URLS[template] : body.baseUrl);
        const authType = body.authType === "none" ? "none" : body.authType === "bearer" ? "bearer" : undefined;
        if (!authType) throw new TypeError("authType must be none or bearer");
        const apiKey = authType === "bearer" ? requireString(body.apiKey, "apiKey") : undefined;
        const credentialEnv = consumerCredentialEnvironment(connectionId);
        if (apiKey) process.env[credentialEnv] = apiKey;
        else delete process.env[credentialEnv];
        const costCentsPerJob = parseCostCentsPerJob(body.costCentsPerJob);
        const requestedModelIds = body.modelIds === undefined ? undefined : requireStringArray(body.modelIds, "modelIds");

        const client = new OpenAICompatibleClient({ ...(apiKey ? { apiKey } : {}) });
        let discovered: OpenAICompatibleModel[] = [];
        let mediaDiscovery: ProviderModel[] = [];
        if (template === "openai-compatible") {
          discovered = await client.listModels(baseUrl, AbortSignal.timeout(15_000));
        } else {
          // Media templates run BOTH discovery paths and union the recipe sets
          // (§5.7 mixed connections): chat discovery failure is non-fatal, but
          // a media discovery with no media-capable models is an error.
          mediaDiscovery = await mediaProviders.get(template).discover(
            {
              id: connectionId,
              baseUrl,
              ...(authType === "bearer" ? { apiKeyEnv: credentialEnv } : {}),
              ...(requestedModelIds ? { modelIds: requestedModelIds } : {}),
            },
            AbortSignal.timeout(15_000),
          );
          if (!mediaDiscovery.length) throw new Error("The provider returned no media-capable models");
          try {
            discovered = await client.listModels(baseUrl, AbortSignal.timeout(15_000));
          } catch {
            discovered = [];
          }
        }
        const modelIds = [...new Set(discovered.filter(supportsChatCompletions).map((item) => item.id.trim()).filter(Boolean))];
        if (template === "openai-compatible" && !modelIds.length) throw new Error("The API returned no chat-completion models");

        const registrations = consumerConnections();
        const previous = registrations.find((item) => item.id === connectionId);
        if (previous) removeConsumerRegistration(previous, store, routes, false);
        const models = modelIds.map((modelId) => consumerModelRegistration(connectionId, modelId));
        for (const model of models) {
          const recipe: Recipe = {
            id: model.recipeId,
            playbookId: `consumer-${connectionId}`,
            displayName: model.modelId,
            adapter: "openai-compatible",
            modelId: model.modelId,
            contextTokens: 131_072,
            capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 8 },
            lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
            configuration: { baseUrl, ...(authType === "bearer" ? { apiKeyEnv: credentialEnv } : {}), healthPath: consumerHealthPath(baseUrl) },
          };
          const route: Route = { id: model.routeId, displayName: model.modelId, description: displayName, recipeId: model.recipeId, enabled: true };
          store.upsertRecipe(recipe); routes.upsertRecipe(recipe); store.upsertRoute(route); routes.upsertRoute(route);
        }
        const mediaModels = saveMediaRecipes(store, routes, {
          connectionId,
          template,
          displayName,
          baseUrl,
          credentialEnv,
          authType,
          ...(costCentsPerJob !== undefined ? { costCentsPerJob } : {}),
          models: mediaDiscovery,
        });
        // Re-save revalidation: a well-known media route whose recipe no longer
        // resolves (the model was removed from the connection) is de-assigned,
        // never left pointing at a deleted recipe (§5.7).
        clearStaleMediaRouteAssignments(store, routes);
        const connection: ConsumerConnectionRegistration = {
          id: connectionId, displayName, baseUrl, template, authType, credentialEnv, models, mediaModels, updatedAt: new Date().toISOString(),
        };
        store.setSetting("consumerConnections", [...registrations.filter((item) => item.id !== connectionId), connection]);
        security?.audit("consumer-connection.saved", principals.get(request)?.user.id, "consumer-connection", connectionId, { displayName, baseUrl, modelCount: models.length, mediaModelCount: mediaModels.length });
        return { data: publicConsumerConnection(connection) };
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete(
    "/api/v1/management/connections/:connectionId",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const connectionId = requireIdentifier((request.params as { connectionId: string }).connectionId, "connectionId");
      const registrations = consumerConnections();
      const connection = registrations.find((item) => item.id === connectionId);
      if (!connection) return reply.code(404).send({ error: "Connection not found" });
      removeConsumerRegistration(connection, store, routes);
      delete process.env[connection.credentialEnv];
      store.setSetting("consumerConnections", registrations.filter((item) => item.id !== connectionId));
      security?.audit("consumer-connection.removed", principals.get(request)?.user.id, "consumer-connection", connectionId);
      return reply.code(204).send();
    },
  );

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
        recentLifecycleEvents: store.lifecycleEventsAfter(
          Math.max(0, store.latestLifecycleSequence() - 100),
          100,
        ),
        metrics: metrics.snapshot(),
      });
    },
  );

  app.get(
    "/api/v1/management/routes",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    // includeDisabled: de-assigned media routes stay visible so they can be
    // re-assigned from the UI (§5.2).
    async () => ({ data: routes.listRoutes(true) }),
  );

  app.put(
    "/api/v1/management/engine-root",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      try {
        const body = requireRecord(request.body);
        const rootPath = requireString(body.rootPath, "rootPath");
        if (!isAbsolute(rootPath)) throw new TypeError("rootPath must be absolute");
        const resolvedRoot = resolve(rootPath);
        if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) throw new TypeError("rootPath must be an existing folder");
        store.setSetting("engineRoot", resolvedRoot);
        return { data: { rootPath: resolvedRoot } };
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.put(
    "/api/v1/management/engines/:folderName",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      try {
        const folderName = parseFolderName((request.params as { folderName: string }).folderName);
        const body = requireRecord(request.body);
        const engineRoot = store.getSetting<string>("engineRoot") ?? configuredEngineRoot;
        const rootPath = safeEnginePath(engineRoot, folderName);
        if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) throw new TypeError("Engine folder does not exist beneath the configured root");
        const connectionMode = parseConnectionMode(body.connectionMode);
        const runtime = parseEngineRuntime(body.runtime);
        const baseUrl = connectionMode === "external" ? requireBaseUrl(body.baseUrl) : "http://127.0.0.1";
        const healthPath = requireString(body.healthPath, "healthPath");
        if (!healthPath.startsWith("/") || healthPath.startsWith("//")) throw new TypeError("healthPath must be an absolute URL path");
        const launchArguments = requireStringArray(body.launchArguments, "launchArguments");
        const launchCommand = typeof body.launchCommand === "string" && body.launchCommand.trim() ? body.launchCommand.trim() : undefined;
        if (connectionMode === "managed" && !launchCommand) throw new TypeError("launchCommand is required for a managed engine");
        const workingDirectory = typeof body.workingDirectory === "string" && body.workingDirectory.trim() ? validateWorkingDirectory(rootPath, body.workingDirectory.trim()) : undefined;
        const wslDistribution = typeof body.wslDistribution === "string" && body.wslDistribution.trim() ? body.wslDistribution.trim() : undefined;
        const now = new Date().toISOString();
        const previous = store.getEngine(folderName);
        const engine: EngineRegistration = {
          id: folderName,
          folderName,
          displayName: requireString(body.displayName, "displayName"),
          connectionMode,
          runtime,
          baseUrl,
          healthPath,
          ...(launchCommand ? { launchCommand } : {}),
          launchArguments,
          ...(workingDirectory ? { workingDirectory } : {}),
          ...(wslDistribution ? { wslDistribution } : {}),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        store.upsertEngine(engine);
        return { data: { ...engine, rootPath } };
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.put(
    "/api/v1/management/recipes/:recipeId",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const recipeId = (request.params as { recipeId: string }).recipeId;
      try {
        const recipe = parseRecipe(request.body, recipeId);
        store.upsertRecipe(recipe);
        routes.upsertRecipe(recipe);
        // A media-capable recipe makes the well-known media routes assignable;
        // create the (disabled, unassigned) slots if they do not exist yet (§5.2).
        ensureMediaRoutes(store, routes);
        return { data: recipe };
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/v1/management/recipes/:recipeId/test",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const recipeId = (request.params as { recipeId: string }).recipeId;
      try {
        const recipe = routes.resolveRecipe(recipeId);
        if (!recipe.capabilities.chatCompletions) throw new TypeError(`Recipe ${recipeId} does not support chat completions`);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.raw.once("aborted", cancel);
        // Keep the probe prompt minimal but give reasoning-capable models enough room to
        // finish an answer: some providers count reasoning tokens against max_tokens, so a
        // tiny budget can end with `finish_reason: "length"` and no visible text. Sampling
        // temperature is left unset because reasoning models may reject non-default values.
        const stream = scheduler.enqueueRecipe(recipeId, {
          messages: [{ role: "user", content: "Say hi." }],
          maxTokens: 1024,
        }, controller.signal, { unloadAfterCompletion: true });
        let output = "";
        let reasoningLength = 0;
        let finishReason: string | undefined;
        let events = 0;
        try {
          for await (const delta of stream) {
            events += 1;
            if (delta.text) output += delta.text;
            if (delta.reasoning) reasoningLength += delta.reasoning.length;
            if (delta.finishReason) finishReason = delta.finishReason;
          }
        } finally {
          request.raw.off("aborted", cancel);
        }
        if (!output.trim()) {
          const detail = reasoningLength > 0
            ? `The model produced reasoning (${reasoningLength} characters) but no visible answer${finishReason ? `; the stream ended with finish reason "${finishReason}"` : ""}. It may be a reasoning model that needs a larger output budget.`
            : finishReason
              ? `The stream ended with finish reason "${finishReason}" after ${events} events but contained no visible text.`
              : `The provider returned an empty stream (${events} events, no text).`;
          throw new Error(`Recipe completed without returning text: ${detail}`);
        }
        return { data: { recipeId, working: true, unloaded: true, output: output.trim().slice(0, 500) } };
      } catch (error) {
        const statusCode = error instanceof RecipeNotFoundError ? 404 : 502;
        return reply.code(statusCode).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/v1/management/recipes/:recipeId/media-test",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const recipeId = (request.params as { recipeId: string }).recipeId;
      try {
        const recipe = routes.resolveRecipe(recipeId);
        const output = recipe.capabilities.modalities?.output ?? [];
        if (!output.length) throw new TypeError(`Recipe ${recipeId} does not generate media`);
        const route = resolveMediaTestRoute(routes, recipeId, output);
        if (!route) throw new TypeError(`Recipe ${recipeId} is not assigned to an enabled media route`);
        // Admin diagnostic probe: submitted without a principal so it is exempt
        // from per-user quota (design doc §5.10), exactly like the image gateway.
        const job = mediaJobs.submit({ routeId: route.id, modality: route.kind as MediaModality, params: { prompt: MEDIA_TEST_PROMPTS[route.kind as MediaModality] } });
        const terminal = await awaitMediaJob(mediaJobs, job.id, mediaImageTimeoutMs);
        if (terminal.status !== "completed") {
          throw new Error(`Media test failed (job ${job.id}): ${mediaJobFailureMessage(store, terminal)}`);
        }
        return {
          data: {
            recipeId,
            modality: terminal.modality,
            jobId: job.id,
            status: terminal.status,
            working: true,
            unloaded: true,
            ...(terminal.artifactId
              ? { artifactId: terminal.artifactId, artifactUrl: `${requestOrigin(request)}/api/v1/artifacts/${terminal.artifactId}/content` }
              : {}),
          },
        };
      } catch (error) {
        const statusCode = error instanceof RecipeNotFoundError ? 404 : error instanceof TypeError ? 400 : error instanceof MediaGenerationTimeoutError ? 504 : 502;
        return reply.code(statusCode).send({ error: errorMessage(error) });
      }
    },
  );

  app.put(
    "/api/v1/management/routes/:routeId",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const routeId = (request.params as { routeId: string }).routeId;
      try {
        const route = parseRoute(request.body, routeId);
        if (route.recipeId !== "") {
          // De-assignment (recipeId: "") deliberately references no recipe, so the
          // recipe-exists guard is skipped for it (§5.2).
          const recipe = routes.listRecipes().find((item) => item.id === route.recipeId);
          if (!recipe) throw new RecipeNotFoundError(route.recipeId);
          const kind = route.kind ?? "chat";
          if (kind !== "chat") {
            if (!recipe.capabilities.modalities?.output.includes(kind)) {
              throw new TypeError(`Recipe ${recipe.id} does not generate ${kind}; cannot assign it to the ${route.id} route`);
            }
            if (recipe.configuration.experimental === true && !(isRecord(request.body) && request.body.acceptExperimental === true)) {
              throw new TypeError(`Recipe ${recipe.id} is experimental; pass acceptExperimental: true to assign it explicitly`);
            }
          }
        }
        store.upsertRoute(route);
        routes.upsertRoute(route);
        return { data: route };
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/v1/management/instances/stop",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (_request, reply) => {
      try {
        await lifecycle.stop("management-request", "graceful");
        return { engine: lifecycle.snapshot() };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  const administratorGuard = adminGuard(options.adminToken, authMode, principals);
  app.get("/api/v1/management/connectivity/status", { preHandler: administratorGuard }, async () => { const tailscaleStatus = await tailscale.status(); try { return { data: { tailscale: tailscaleStatus, serve: { available: true, configuration: await tailscaleServe.status() } } }; } catch (error) { return { data: { tailscale: tailscaleStatus, serve: { available: false, message: errorMessage(error) } } }; } });
  app.post("/api/v1/management/connectivity/tailscale-serve", { preHandler: administratorGuard }, async (request, reply) => { try { if (authMode !== "required") return reply.code(409).send({ error: "Device authentication must be enabled before remote access" }); const body = requireRecord(request.body); const localPort = body.localPort === undefined ? options.localPort ?? 8787 : requireInteger(body.localPort); const httpsPort = body.httpsPort === undefined ? 443 : requireInteger(body.httpsPort); await tailscaleServe.enable(localPort, httpsPort); security?.audit("tailscale-serve.enabled", principals.get(request)?.user.id, "connectivity", "tailscale", { localPort, httpsPort }); return { data: await tailscaleServe.status() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/connectivity/tailscale-serve", { preHandler: administratorGuard }, async (request, reply) => { try { const query = request.query as { httpsPort?: string }; const httpsPort = toNonNegativeInteger(query.httpsPort, 443); await tailscaleServe.disable(httpsPort); security?.audit("tailscale-serve.disabled", principals.get(request)?.user.id, "connectivity", "tailscale", { httpsPort }); return reply.code(204).send(); } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/startup", { preHandler: administratorGuard }, async () => ({ data: startup ? await startup.status() : { available: false, configured: false, message: "Startup management is unavailable" } }));
  app.post("/api/v1/management/startup", { preHandler: administratorGuard }, async (request, reply) => { try { if (!startup) throw new Error("Startup management is unavailable"); const result = await startup.install(); security?.audit("host-startup.installed", principals.get(request)?.user.id, "host", "startup"); return { data: result }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/startup", { preHandler: administratorGuard }, async (request, reply) => { try { if (!startup) throw new Error("Startup management is unavailable"); const result = await startup.remove(); security?.audit("host-startup.removed", principals.get(request)?.user.id, "host", "startup"); return { data: result }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/pi/catalog", { preHandler: administratorGuard }, async (request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); const query = request.query as { query?: string; offset?: string; limit?: string; sort?: string; direction?: string; type?: unknown }; return { data: await piPackages.catalog(query.query ?? "", toNonNegativeInteger(query.offset, 0), Math.min(toNonNegativeInteger(query.limit, 30), 50), catalogSort(query.sort), catalogDirection(query.direction), catalogTypeFilter(query.type)) }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/pi/packages", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); return { data: await piPackages.installed() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/pi/skills", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); return { data: await piPackages.skills() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/pi/packages/install", { preHandler: administratorGuard }, async (request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); const source = requireString(requireRecord(request.body).source, "source"); await piPackages.install(source); security?.audit("pi-package.installed", principals.get(request)?.user.id, "pi-package", source); return reply.code(201).send({ data: { source } }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/pi/packages/update", { preHandler: administratorGuard }, async (request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); const source = requireString(requireRecord(request.body).source, "source"); await piPackages.update(source); security?.audit("pi-package.updated", principals.get(request)?.user.id, "pi-package", source); return { data: { source } }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.put("/api/v1/management/pi/packages/enabled", { preHandler: administratorGuard }, async (request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); const body = requireRecord(request.body); const source = requireString(body.source, "source"); if (typeof body.enabled !== "boolean") throw new TypeError("enabled must be boolean"); await piPackages.setEnabled(source, body.enabled); security?.audit(body.enabled ? "pi-package.enabled" : "pi-package.disabled", principals.get(request)?.user.id, "pi-package", source); return { data: { source, enabled: body.enabled } }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/pi/packages", { preHandler: administratorGuard }, async (request, reply) => { try { if (!piPackages) throw new Error("Pi package management is unavailable"); const source = requireString(requireRecord(request.body).source, "source"); await piPackages.remove(source); security?.audit("pi-package.removed", principals.get(request)?.user.id, "pi-package", source); return reply.code(204).send(); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/models/catalog", { preHandler: administratorGuard }, async (request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); const query = request.query as { query?: string; pipeline?: string; offset?: string; limit?: string; sort?: string; direction?: string; min_likes?: string; min_downloads?: string; released_within_weeks?: string }; return { data: await modelCatalog.search(query.query ?? "", toNonNegativeInteger(query.offset, 0), Math.min(toNonNegativeInteger(query.limit, 30), 50), query.pipeline ?? "text-generation", catalogSort(query.sort), catalogDirection(query.direction), toNonNegativeInteger(query.min_likes, 0), toNonNegativeInteger(query.min_downloads, 0), toNonNegativeInteger(query.released_within_weeks, 0)) }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/models/files", { preHandler: administratorGuard }, async (request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); const query = request.query as { repo?: string }; return { data: await modelCatalog.files(requireString(query.repo, "repo")) }; } catch (error) { return reply.code(error instanceof TypeError ? 400 : 503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/models/downloaded", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); return { data: await modelCatalog.downloaded() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/models/downloads", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); return { data: modelCatalog.list() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/models/download", { preHandler: administratorGuard }, async (request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); const body = requireRecord(request.body); const repo = requireString(body.repo, "repo"); const fileName = body.fileName === undefined ? undefined : requireString(body.fileName, "fileName"); const record = await modelCatalog.start(repo, fileName); security?.audit("model.download-started", principals.get(request)?.user.id, "model", `${repo}/${record.fileName}`); return reply.code(202).send({ data: record }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/models/downloads/:id", { preHandler: administratorGuard }, async (request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); const id = (request.params as { id: string }).id; return { data: modelCatalog.progress(id) }; } catch (error) { return reply.code(error instanceof DownloadNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/models/downloads/:id", { preHandler: administratorGuard }, async (request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); const id = (request.params as { id: string }).id; modelCatalog.cancel(id); security?.audit("model.download-cancelled", principals.get(request)?.user.id, "model", id); return reply.code(204).send(); } catch (error) { return reply.code(error instanceof DownloadNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/models/downloaded", { preHandler: administratorGuard }, async (request, reply) => { try { if (!modelCatalog) throw new Error("Model catalog is unavailable"); const body = requireRecord(request.body); const repoId = requireString(body.repoId, "repoId"); const fileName = requireString(body.fileName, "fileName"); await modelCatalog.removeDownloaded(repoId, fileName); security?.audit("model.removed", principals.get(request)?.user.id, "model", `${repoId}/${fileName}`); return reply.code(204).send(); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
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
  app.get("/api/v1/management/snapshots", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); return { data: safety.listSnapshots() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/snapshots/:runId/restore", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const runId = (request.params as { runId: string }).runId; const result = await safety.restoreSnapshot(runId); security?.audit("snapshot.restored", principals.get(request)?.user.id, "snapshot", runId); return { data: result }; } catch (error) { return reply.code(error instanceof Error && error.message === "Snapshot not found" ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/trash", { preHandler: administratorGuard }, async (_request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); return { data: safety.listTrash() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/trash/:id/restore", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const id = (request.params as { id: string }).id; const entry = await safety.restoreTrash(id); security?.audit("trash.restored", principals.get(request)?.user.id, "trash", id); return { data: entry }; } catch (error) { return reply.code(error instanceof Error && error.message === "Trash entry not found" ? 404 : 400).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/trash", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const query = request.query as { workspaceRoot?: string }; const result = await safety.emptyTrash(typeof query.workspaceRoot === "string" && query.workspaceRoot ? query.workspaceRoot : undefined); security?.audit("trash.emptied", principals.get(request)?.user.id, "trash", undefined, { removed: result.removed, ...(typeof query.workspaceRoot === "string" && query.workspaceRoot ? { workspaceRoot: query.workspaceRoot } : {}) }); return { data: result }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/trash/gc", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const body = isRecord(request.body) ? request.body : {}; const maxAgeDays = typeof body.maxAgeDays === "number" && Number.isFinite(body.maxAgeDays) && body.maxAgeDays > 0 ? body.maxAgeDays : 30; const result = await safety.collect(maxAgeDays * 24 * 60 * 60 * 1000); security?.audit("safety.gc", principals.get(request)?.user.id, "safety", undefined, { maxAgeDays, ...result }); return { data: result }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/tool-actions", { preHandler: administratorGuard }, async (request, reply) => { try { if (!safety) throw new Error("Safety layer is unavailable"); const query = request.query as { limit?: string }; return { data: safety.listToolActions(Math.min(toNonNegativeInteger(query.limit, 200), 1000)) }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });

  app.addHook("onClose", async () => {
    await lifecycle.cancelPreparations();
    await scheduler.shutdown();
    unsubscribeMetrics();
    unsubscribePersistence();
    store.close();
  });

  return {
    app,
    store,
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

/** Idempotent, create-only: creates the well-known media routes disabled with an
 *  empty recipeId. Existing media routes are never reset — their recipeId/enabled
 *  state is preserved on every boot, so an assignment survives restarts (§5.2). */
export function ensureMediaRoutes(store: SqliteStore, routes: RouteResolver): void {
  for (const id of MEDIA_ROUTE_IDS) {
    if (routes.listRoutes(true).some((route) => route.id === id)) continue;
    const route: Route = { id, displayName: MEDIA_ROUTE_DISPLAY_NAMES[id], recipeId: "", enabled: false, kind: id };
    store.upsertRoute(route);
    routes.upsertRoute(route);
  }
}

function migrateLegacyEngineRegistry(store: SqliteStore): void {
  if (store.getSetting<number>("engineRegistrySchema") === 2) return;
  for (const engine of store.listEngines()) store.deleteEngine(engine.id);
  store.setSetting("engineRegistrySchema", 2);
}

function scanEngineFolders(engineRoot: string, engines: EngineRegistration[]): Array<Record<string, unknown>> {
  if (!existsSync(engineRoot) || !statSync(engineRoot).isDirectory()) return [];
  const byFolder = new Map(engines.map((engine) => [engine.folderName, engine]));
  return readdirSync(engineRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const engine = byFolder.get(entry.name);
      return { folderName: entry.name, rootPath: safeEnginePath(engineRoot, entry.name), registered: Boolean(engine), ...(engine ? { engine } : {}) };
    });
}

function parseFolderName(value: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) throw new TypeError("folderName must name one direct child of the engine root");
  return value;
}

function parseConnectionMode(value: unknown): EngineConnectionMode {
  if (value !== "managed" && value !== "external") throw new TypeError("connectionMode must be managed or external");
  return value;
}

function parseEngineRuntime(value: unknown): EngineRuntime {
  if (value !== "windows" && value !== "wsl") throw new TypeError("runtime must be windows or wsl");
  return value;
}

function requireBaseUrl(value: unknown): string {
  const baseUrl = requireString(value, "baseUrl");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("baseUrl must use http or https");
  if (url.username || url.password) throw new TypeError("baseUrl must not contain credentials");
  return url.toString().replace(/\/$/, "");
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} must be an array of strings`);
  return value as string[];
}

function safeEnginePath(engineRoot: string, folderName: string): string {
  const root = resolve(engineRoot);
  const target = resolve(root, folderName);
  const child = relative(root, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new TypeError("Engine folder must be inside the configured engine root");
  return target;
}

function validateWorkingDirectory(engineRoot: string, workingDirectory: string): string {
  const root = resolve(engineRoot);
  const target = resolve(root, workingDirectory);
  const child = relative(root, target);
  if (child.startsWith("..") || isAbsolute(child)) throw new TypeError("workingDirectory must stay inside the engine folder");
  return child || ".";
}

function requireIdentifier(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (id.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new TypeError(`${name} contains unsupported characters`);
  return id;
}

function normalizeConsumerBaseUrl(value: unknown): string {
  const baseUrl = requireBaseUrl(value);
  const url = new URL(baseUrl);
  if (url.search || url.hash) throw new TypeError("baseUrl must not contain a query or fragment");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) throw new TypeError("Remote connections must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function consumerHealthPath(baseUrl: string): string {
  return /\/v1$/i.test(new URL(baseUrl).pathname.replace(/\/$/, "")) ? "/models" : "/v1/models";
}

function consumerCredentialEnvironment(connectionId: string): string {
  return `FITZ_CONSUMER_${createHash("sha256").update(connectionId).digest("hex").slice(0, 16).toUpperCase()}`;
}

function consumerModelRegistration(connectionId: string, modelId: string): ConsumerModelRegistration {
  const suffix = createHash("sha256").update(modelId).digest("hex").slice(0, 16);
  return { modelId, routeId: `${CONSUMER_ROUTE_PREFIX}${connectionId}--${suffix}`, recipeId: `consumer-recipe--${connectionId}--${suffix}` };
}

/** Media registrations are per (model, modality): one recipe per model, one
 *  `consumer--*` route per modality. Ids are prefixed with `media` so a model
 *  that is both chat- and media-capable never collides with its chat
 *  recipe/route (§5.7 mixed connections). */
function consumerMediaRecipeId(connectionId: string, modelId: string): string {
  const suffix = createHash("sha256").update(modelId).digest("hex").slice(0, 16);
  return `consumer-recipe--media--${connectionId}--${suffix}`;
}

function consumerMediaRouteId(connectionId: string, modelId: string, modality: MediaModality): string {
  const suffix = createHash("sha256").update(`${modelId}:${modality}`).digest("hex").slice(0, 16);
  return `${CONSUMER_ROUTE_PREFIX}media--${connectionId}--${suffix}`;
}

function parseConsumerTemplate(value: unknown): string {
  if (value === undefined) return "openai-compatible";
  if (typeof value === "string" && (CONSUMER_TEMPLATES as readonly string[]).includes(value)) return value;
  throw new TypeError("template must be openai-compatible, openai-media, fal, or replicate");
}

function parseCostCentsPerJob(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("costCentsPerJob must be a non-negative number");
  }
  return value;
}

function mediaConsumerHealthPath(template: string, baseUrl: string): string {
  return template === "fal" || template === "replicate" ? "/health" : consumerHealthPath(baseUrl);
}

/** Create the media recipes (one per ProviderModel) and consumer routes (one
 *  per modality) for a connection, returning the mediaModels registrations.
 *  Cloud media recipes declare `evictionPolicy: "immediate"` (§5.5). */
function saveMediaRecipes(
  store: SqliteStore,
  routes: RouteResolver,
  options: {
    connectionId: string;
    template: string;
    displayName: string;
    baseUrl: string;
    credentialEnv: string;
    authType: "none" | "bearer";
    costCentsPerJob?: number;
    models: ProviderModel[];
  },
): ConsumerMediaModelRegistration[] {
  const registrations: ConsumerMediaModelRegistration[] = [];
  for (const model of options.models) {
    const recipeId = consumerMediaRecipeId(options.connectionId, model.modelId);
    const recipe: Recipe = {
      id: recipeId,
      playbookId: `consumer-${options.connectionId}`,
      displayName: model.modelId,
      adapter: options.template,
      modelId: model.modelId,
      contextTokens: 131_072,
      capabilities: {
        chatCompletions: false,
        streaming: true,
        toolCalls: false,
        responseFormat: false,
        minP: false,
        maxConcurrentGenerations: 1,
        modalities: {
          input: ["text"],
          output: model.modalities,
          ...(model.limits ? { limits: model.limits } : {}),
        },
      },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "immediate", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: {
        baseUrl: options.baseUrl,
        modelId: model.modelId,
        healthPath: mediaConsumerHealthPath(options.template, options.baseUrl),
        ...(options.authType === "bearer" ? { apiKeyEnv: options.credentialEnv } : {}),
        ...(options.costCentsPerJob !== undefined ? { costCentsPerJob: options.costCentsPerJob } : {}),
      },
    };
    store.upsertRecipe(recipe);
    routes.upsertRecipe(recipe);
    for (const modality of model.modalities) {
      const routeId = consumerMediaRouteId(options.connectionId, model.modelId, modality);
      const route: Route = {
        id: routeId,
        displayName: model.modelId,
        description: options.displayName,
        recipeId,
        enabled: true,
        kind: modality,
      };
      store.upsertRoute(route);
      routes.upsertRoute(route);
      registrations.push({ modelId: model.modelId, recipeId, routeId, modality, template: options.template });
    }
  }
  return registrations;
}

function requirePublicRouteId(value: unknown): "fast" | "default" | "smart" {
  if (value === undefined) return "default";
  if (value !== "fast" && value !== "default" && value !== "smart") throw new TypeError("routeId must be fast, default, or smart");
  return value;
}

function removeConsumerRegistration(connection: ConsumerConnectionRegistration, store: SqliteStore, routes: RouteResolver, removeAssignments = true): void {
  const recipeIds = new Set([
    ...connection.models.map((model) => model.recipeId),
    ...(connection.mediaModels ?? []).map((model) => model.recipeId),
  ]);
  const consumerRouteIds = new Set([
    ...connection.models.map((model) => model.routeId),
    ...(connection.mediaModels ?? []).map((model) => model.routeId),
  ]);
  if (removeAssignments) {
    for (const route of routes.listRoutes()) {
      if (!recipeIds.has(route.recipeId) || consumerRouteIds.has(route.id)) continue;
      if ((MEDIA_ROUTE_IDS as readonly string[]).includes(route.id)) {
        // Well-known media routes are de-assigned, never deleted (§5.2/§5.7).
        const updated: Route = { ...route, recipeId: "", enabled: false };
        store.upsertRoute(updated); routes.upsertRoute(updated);
      } else {
        routes.deleteRoute(route.id); store.deleteRoute(route.id);
      }
    }
  }
  for (const model of connection.models) {
    routes.deleteRoute(model.routeId); store.deleteRoute(model.routeId);
    routes.deleteRecipe(model.recipeId); store.deleteRecipe(model.recipeId);
  }
  for (const model of connection.mediaModels ?? []) {
    routes.deleteRoute(model.routeId); store.deleteRoute(model.routeId);
    routes.deleteRecipe(model.recipeId); store.deleteRecipe(model.recipeId);
  }
}

function publicConsumerConnection(connection: ConsumerConnectionRegistration): Record<string, unknown> {
  return {
    id: connection.id,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
    authType: connection.authType,
    hasCredential: connection.authType === "bearer",
    template: connection.template ?? "openai-compatible",
    models: connection.models.map((model) => ({ id: model.modelId, routeId: model.routeId, recipeId: model.recipeId })),
    mediaModels: (connection.mediaModels ?? []).map((model) => ({ id: model.modelId, routeId: model.routeId, recipeId: model.recipeId, modality: model.modality, template: model.template })),
    updatedAt: connection.updatedAt,
  };
}

/** Re-save revalidation (§5.7): a well-known media route whose recipeId no
 *  longer resolves (the connection's model set shrank) is de-assigned. Runs
 *  after every connection save, after the new recipes are written. */
function clearStaleMediaRouteAssignments(store: SqliteStore, routes: RouteResolver): void {
  const recipeIds = new Set(routes.listRecipes().map((recipe) => recipe.id));
  for (const route of routes.listRoutes(true)) {
    if (!(MEDIA_ROUTE_IDS as readonly string[]).includes(route.id)) continue;
    if (route.recipeId && !recipeIds.has(route.recipeId)) {
      const updated: Route = { ...route, recipeId: "", enabled: false };
      store.upsertRoute(updated);
      routes.upsertRoute(updated);
    }
  }
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

async function collectCompletion(
  requestId: string,
  model: string,
  stream: AsyncIterable<InferenceDelta>,
): Promise<Record<string, unknown>> {
  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason = "stop";
  const toolCalls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  for await (const delta of stream) {
    content += delta.text;
    for (const call of delta.toolCalls ?? []) {
      const current = toolCalls.get(call.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      toolCalls.set(call.index, current);
    }
    if (delta.promptTokens !== undefined) promptTokens = delta.promptTokens;
    if (delta.completionTokens !== undefined) completionTokens = delta.completionTokens;
    if (delta.finishReason) finishReason = delta.finishReason;
  }
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function streamChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(reply: { raw: { write(chunk: string): unknown } }, value: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(value)}\n\n`);
}

function openAIError(error: unknown, type: string): OpenAIErrorResponse {
  return { error: { message: errorMessage(error), type } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validBearerToken(authorization: string | undefined, expected: string | undefined): boolean {
  if (!authorization?.startsWith("Bearer ") || !expected) return false;
  const actualHash = createHash("sha256").update(authorization.slice(7)).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
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

/** Shared catalog query params: sort keys and direction, both stores. */
const CATALOG_SORT_KEYS = ["downloads", "updated", "name", "likes"] as const;
type CatalogSortKey = (typeof CATALOG_SORT_KEYS)[number];
function catalogSort(value: unknown): CatalogSortKey {
  return typeof value === "string" && (CATALOG_SORT_KEYS as readonly string[]).includes(value) ? value as CatalogSortKey : "downloads";
}
function catalogDirection(value: unknown): "asc" | "desc" {
  return value === "asc" ? "asc" : "desc";
}

const CATALOG_TYPES = ["extension", "skill", "prompt", "theme"] as const;
type CatalogType = (typeof CATALOG_TYPES)[number];
/** Normalizes the repeated `type` query param into the Pi package type filter. */
function catalogTypeFilter(value: unknown): CatalogType[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((entry): entry is CatalogType => typeof entry === "string" && (CATALOG_TYPES as readonly string[]).includes(entry));
}

function parseRoute(value: unknown, routeId: string): Route {
  if (!isRecord(value)) throw new TypeError("Route body must be an object");
  if (typeof value.displayName !== "string" || value.displayName.length === 0) {
    throw new TypeError("displayName must be a non-empty string");
  }
  if (typeof value.recipeId !== "string") {
    throw new TypeError("recipeId must be a string");
  }
  const kind = parseRouteKind(value.kind, routeId);
  // De-assignment: an empty recipeId on a media route persists the route as
  // disabled (it stays visible, never deleted). Chat routes keep the current
  // non-empty-recipeId requirement (§5.2).
  const deassigned = kind !== undefined && kind !== "chat" && value.recipeId.length === 0;
  if ((kind === "chat" || kind === undefined) && value.recipeId.length === 0) {
    throw new TypeError("recipeId must be a non-empty string");
  }
  if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  return {
    id: routeId,
    displayName: value.displayName,
    recipeId: value.recipeId,
    enabled: deassigned ? false : value.enabled,
    ...(kind ? { kind } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
  };
}

function parseRouteKind(value: unknown, routeId: string): RouteKind | undefined {
  if (value === "chat" || value === "image" || value === "video" || value === "audio") return value;
  if (value === undefined) return (MEDIA_ROUTE_IDS as readonly string[]).includes(routeId) ? (routeId as RouteKind) : undefined;
  throw new TypeError("kind must be chat, image, video, or audio");
}

function parseRecipe(value: unknown, recipeId: string): Recipe {
  const body = requireRecord(value);
  const capabilities = requireRecord(body.capabilities);
  const lifecycle = requireRecord(body.lifecycle);
  const configuration = requireRecord(body.configuration);
  const booleanCapability = (name: string): boolean => {
    const capability = capabilities[name];
    if (typeof capability !== "boolean") throw new TypeError(`capabilities.${name} must be a boolean`);
    return capability;
  };
  const loadPolicy = lifecycle.loadPolicy;
  if (loadPolicy !== "onDemand" && loadPolicy !== "manual") throw new TypeError("lifecycle.loadPolicy is invalid");
  const evictionPolicy = lifecycle.evictionPolicy;
  if (evictionPolicy !== "immediate" && evictionPolicy !== "idle-ttl" && evictionPolicy !== "never" && evictionPolicy !== "manual") throw new TypeError("lifecycle.evictionPolicy is invalid");
  return {
    id: recipeId,
    playbookId: requireString(body.playbookId, "playbookId"),
    displayName: requireString(body.displayName, "displayName"),
    adapter: requireString(body.adapter, "adapter"),
    modelId: requireString(body.modelId, "modelId"),
    contextTokens: requireInteger(body.contextTokens),
    capabilities: {
      chatCompletions: booleanCapability("chatCompletions"), streaming: booleanCapability("streaming"), toolCalls: booleanCapability("toolCalls"),
      responseFormat: booleanCapability("responseFormat"), minP: booleanCapability("minP"), maxConcurrentGenerations: requireInteger(capabilities.maxConcurrentGenerations),
      ...(isRecord(capabilities.modalities) ? { modalities: parseModalities(capabilities.modalities) } : {}),
    },
    lifecycle: {
      loadPolicy, evictionPolicy, idleTtlSeconds: nonNegativeInteger(lifecycle.idleTtlSeconds, "lifecycle.idleTtlSeconds"), minimumResidencySeconds: nonNegativeInteger(lifecycle.minimumResidencySeconds, "lifecycle.minimumResidencySeconds"),
    },
    configuration,
  };
}

function nonNegativeInteger(value: unknown, name: string): number { if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative integer`); return value as number; }
function contentTextLength(content: string | Array<{ type: string; text?: string }>): number { if (typeof content === "string") return content.length; return content.reduce((total, part) => total + (part.type === "text" ? (part.text ?? "").length : 0), 0); }

function parseAgentRunRequest(value: unknown): AgentRunRequest { const parsed = parseChatCompletionRequest(value); const source = requireRecord(value); const accessMode = source.accessMode === "ask" || source.accessMode === "read-only" ? source.accessMode : "full"; return { model: parsed.model, messages: parsed.messages, ...(parsed.max_tokens !== undefined ? { maxTokens: parsed.max_tokens } : {}), ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}), ...(typeof source.sessionId === "string" ? { sessionId: source.sessionId } : {}), accessMode }; }
function canAccessRun(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId; }
function canAccessOwner(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId; }
function canAccessMediaJob(principal: AuthenticatedPrincipal | undefined, job: MediaJobRecord): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === job.createdByUserId; }

/** Absolute URLs returned by media APIs must retain a non-default host port.
 *  Fastify's `request.hostname` intentionally strips it, while the HTTP Host
 *  header preserves the authority the client can actually reach. Invalid or
 *  absent Host headers fall back to Fastify's normalized hostname. */
function requestOrigin(request: FastifyRequest): string {
  const authority = request.headers.host?.trim();
  if (authority) {
    try {
      return new URL(`${request.protocol}://${authority}`).origin;
    } catch {
      // Fall through to the normalized hostname for malformed Host headers.
    }
  }
  return `${request.protocol}://${request.hostname}`;
}
function isTerminalMediaStatus(status: string | undefined): boolean { return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"; }
function isTerminalMediaEvent(type: string): boolean { return type === "completed" || type === "failed" || type === "cancelled"; }
/** Human-readable failure text for a terminal media job: the failed event's
 *  message (the record's `errorCode` holds the machine code, e.g.
 *  `artifact_too_large`). */
function mediaJobFailureMessage(store: SqliteStore, job: MediaJobRecord): string {
  const events = store.mediaJobEventsAfter(job.id, 0);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "failed") return event.error;
  }
  return job.errorCode ?? `Media generation ended with status ${job.status}`;
}

/** Pick the enabled route to probe for a recipe's media-test: prefer a
 *  well-known media route (image/video/audio) so the probe exercises the
 *  standard single-assignment path, falling back to a consumer media route
 *  when the recipe is only assigned there (§5.10). */
function resolveMediaTestRoute(routes: RouteResolver, recipeId: string, output: MediaModality[]): Route | undefined {
  const candidates = routes.listRoutes(true).filter(
    (route) => route.enabled && route.recipeId === recipeId && route.kind !== "chat" && output.includes(route.kind as MediaModality),
  );
  return candidates.find((route) => (MEDIA_ROUTE_IDS as readonly string[]).includes(route.id)) ?? candidates[0];
}
function parseModality(value: unknown): MediaModality { if (value === "image" || value === "video" || value === "audio") return value; throw new TypeError("modality must be image, video, or audio"); }
function parseMediaStatus(value: string | undefined): MediaJobStatus | undefined { return value === "queued" || value === "started" || value === "progressing" || value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted" ? value : undefined; }
function parseMediaParams(value: unknown): MediaGenerationParams {
  const body = requireRecord(value);
  const prompt = requireString(body.prompt, "prompt");
  return {
    prompt,
    ...(typeof body.negativePrompt === "string" ? { negativePrompt: body.negativePrompt } : {}),
    ...(Array.isArray(body.refs)
      ? { refs: body.refs.map((ref) => { if (!isRecord(ref)) throw new TypeError("params.refs entries must be objects"); if (typeof ref.artifactId === "string" && ref.artifactId) return { artifactId: ref.artifactId }; if (typeof ref.url === "string" && ref.url) return { url: ref.url }; throw new TypeError("params.refs entries must have artifactId or url"); }) }
      : {}),
    ...(typeof body.size === "string" ? { size: body.size } : {}),
    ...(typeof body.durationSeconds === "number" ? { durationSeconds: body.durationSeconds } : {}),
    ...(typeof body.fps === "number" ? { fps: body.fps } : {}),
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    ...(typeof body.sampler === "string" ? { sampler: body.sampler } : {}),
    ...(typeof body.steps === "number" ? { steps: body.steps } : {}),
    ...(typeof body.guidance === "number" ? { guidance: body.guidance } : {}),
  };
}

/** Raised when the synchronous image gateway's bounded await expires (§5.8);
 *  the job keeps running and the 504 envelope carries its id for native polling. */
class MediaGenerationTimeoutError extends Error {
  constructor(readonly jobId: string) {
    super(`Image generation timed out (job ${jobId})`);
    this.name = "MediaGenerationTimeoutError";
  }
}

/** Resolves with the terminal job record, subscribing to the coordinator's event
 *  stream (falling back to a status read when the job is already terminal) and
 *  rejecting with `MediaGenerationTimeoutError` after `timeoutMs`. Uses only the
 *  coordinator's public API — no store or scheduler access. */
async function awaitMediaJob(coordinator: MediaJobCoordinator, id: string, timeoutMs: number): Promise<MediaJobRecord> {
  const current = coordinator.get(id);
  if (current && isTerminalMediaStatus(current.status)) return current;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new MediaGenerationTimeoutError(id));
    }, timeoutMs);
    unsubscribe = coordinator.subscribe(id, (event) => {
      if (!isTerminalMediaEvent(event.event.type) || settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      const job = coordinator.get(id);
      if (job) resolve(job);
      else reject(new Error(`Media job ${id} disappeared while awaiting completion`));
    });
  });
}

function parseImageGenerationRequest(value: unknown): ImageGenerationRequest {
  const body = requireRecord(value);
  const model = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");
  const n = body.n === undefined ? 1 : body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new TypeError("n must be a positive integer");
  if (n !== 1) throw new TypeError("n must be 1 in this version");
  return {
    model,
    prompt,
    ...(body.size !== undefined ? { size: requireString(body.size, "size") } : {}),
    ...(body.response_format === "url" || body.response_format === "b64_json" ? { response_format: body.response_format } : {}),
    ...(typeof body.user === "string" && body.user ? { user: body.user } : {}),
  };
}

function parseVideoGenerationRequest(value: unknown): VideoGenerationRequest {
  const body = requireRecord(value);
  const model = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");
  const duration = body.duration;
  if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)) {
    throw new TypeError("duration must be a positive number");
  }
  return {
    model,
    prompt,
    ...(duration !== undefined ? { duration } : {}),
    ...(body.resolution !== undefined ? { resolution: requireString(body.resolution, "resolution") } : {}),
    ...(typeof body.user === "string" && body.user ? { user: body.user } : {}),
  };
}
function parseModalities(value: Record<string, unknown>): ModalityCapabilities {
  const input = value.input;
  const output = value.output;
  if (!Array.isArray(input) || !input.every((item) => item === "text" || item === "image" || item === "video" || item === "audio")) throw new TypeError("capabilities.modalities.input is invalid");
  if (!Array.isArray(output) || !output.every((item) => item === "image" || item === "video" || item === "audio")) throw new TypeError("capabilities.modalities.output is invalid");
  const limits = isRecord(value.limits)
    ? {
        ...(typeof value.limits.maxDurationSeconds === "number" ? { maxDurationSeconds: value.limits.maxDurationSeconds } : {}),
        ...(typeof value.limits.maxResolution === "string" ? { maxResolution: value.limits.maxResolution } : {}),
        ...(typeof value.limits.maxRefs === "number" ? { maxRefs: value.limits.maxRefs } : {}),
        ...(typeof value.limits.maxFrames === "number" ? { maxFrames: value.limits.maxFrames } : {}),
      }
    : undefined;
  return { input: input as ModalityInput[], output: output as MediaModality[], ...(limits ? { limits } : {}) };
}
function isTerminalRun(status: string | undefined): boolean { return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"; }
function isTerminalAgentEvent(type: string): boolean { return type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.interrupted"; }
function parseApprovalStatus(value: string | undefined): "pending" | "approved" | "denied" | "cancelled" | undefined { return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" ? value : undefined; }
function decodeBase64(value: unknown): Buffer { if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new TypeError("contentBase64 must be valid padded base64"); return Buffer.from(value, "base64"); }
function safeFilename(value: string): string { return value.replace(/[\r\n"\\/]/g, "_").slice(0, 160) || "artifact"; }
/** RFC 7233 single-range resolution for the artifact content endpoint: returns
 *  `{ start, end }` for a satisfiable range, `"unsatisfiable"` when the range
 *  cannot be satisfied (respond 416 with a `Content-Range: bytes * /<total>`
 *  header), or `null` to serve the full body (200). Absent/malformed headers,
 *  `bytes=*`, and multi-range sets (multipart/byteranges is out of scope for
 *  v1; RFC 7233 §3.1 permits ignoring them) all resolve to `null`. Suffix
 *  (`bytes=-N`) and open-ended (`bytes=N-`) ranges are supported; an end
 *  beyond the body clamps to the last byte. */
function resolveByteRange(header: string | undefined, total: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  if (total === 0) return "unsatisfiable";
  const spec = /^bytes=(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!spec || spec === "*" || spec.includes(",")) return null;
  if (spec.startsWith("-")) {
    const suffix = Number(spec.slice(1));
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const separator = spec.indexOf("-");
  if (separator === -1) return null;
  const start = Number(spec.slice(0, separator));
  if (!Number.isSafeInteger(start) || start < 0 || start >= total) return "unsatisfiable";
  const endText = spec.slice(separator + 1);
  const end = endText === "" ? total - 1 : Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, total - 1) };
}

function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  const address = request.ip.startsWith("::ffff:") ? request.ip.slice("::ffff:".length) : request.ip;
  if (address !== "127.0.0.1" && address !== "::1") return false;
  const proxyHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];
  return proxyHeaders.every((name) => request.headers[name] === undefined);
}

/** Accept only the editable, typed portion of a media approval. Routing and
 * billing metadata remain host-owned even when the user revises the prompt. */
function parseMediaApprovalRequest(toolName: string, original: Readonly<Record<string, unknown>>, value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const prompt = requireString(value.prompt, "prompt");
  const result: Record<string, unknown> = { prompt };
  const optionalNumber = (name: string, options: { integer?: boolean; minimum?: number } = {}): void => {
    const candidate = value[name];
    if (candidate === undefined || candidate === null || candidate === "") return;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || (options.integer && !Number.isInteger(candidate)) || (options.minimum !== undefined && candidate < options.minimum)) throw new TypeError(`${name} is invalid`);
    result[name] = candidate;
  };
  const optionalString = (name: string): void => {
    const candidate = value[name];
    if (candidate === undefined || candidate === null || candidate === "") return;
    if (typeof candidate !== "string") throw new TypeError(`${name} must be a string`);
    result[name] = candidate;
  };
  if (toolName === "generate_image") {
    optionalString("size");
    optionalNumber("seed", { integer: true, minimum: 0 });
    optionalString("negative_prompt");
  } else if (toolName === "generate_video") {
    optionalNumber("duration_seconds", { minimum: 0.1 });
    optionalString("resolution");
    optionalNumber("fps", { integer: true, minimum: 1 });
  } else if (toolName === "generate_audio") {
    optionalNumber("duration_seconds", { minimum: 0.1 });
  }
  if (Array.isArray(value.refs)) {
    if (!value.refs.every((item) => typeof item === "string")) throw new TypeError("refs must contain strings");
    result.refs = value.refs.slice(0, 32);
  }
  for (const protectedField of ["route_id", "estimated_credit_cost_cents"]) if (original[protectedField] !== undefined) result[protectedField] = original[protectedField];
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
