import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { FakeEngineAdapter } from "@fitz/engine-fake";
import {
  type EngineAdapter,
  EngineAdapterRegistry,
  InferenceScheduler,
  LifecycleEventBus,
  LifecycleManager,
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
  type Recipe,
  type Route,
  type AgentRunRequest,
  type SessionRecord,
  type ToolPolicyRecord,
} from "@fitz/protocol";
import { MetricsRegistry, redactSecrets } from "@fitz/observability";
import { DEFAULT_QUOTAS, SecurityPolicyError, SecurityService, type AuthenticatedPrincipal } from "@fitz/security";
import { SqliteStore } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import { DownloadNotFoundError, type ModelCatalogService } from "./model-catalog.js";
import { AgentRunCoordinator } from "./agent-runs.js";
import type { AgentRuntime } from "@fitz/agent-core";
import type { PiPackageService } from "@fitz/agent-pi";
import { ContextManager } from "@fitz/context";
import { TailscaleMonitor, TailscaleServeManager, WindowsStartupManager } from "@fitz/connectivity";
import { classifyArtifact, normalizeMimeType } from "@fitz/media";
import { OpenAICompatibleClient, OpenAICompatibleEngineAdapter, supportsChatCompletions } from "@fitz/engine-openai-compatible";
import type { AgentSafetyService } from "./agent-safety/index.js";

interface ConsumerModelRegistration { modelId: string; routeId: string; recipeId: string }
interface ConsumerConnectionRegistration {
  id: string;
  displayName: string;
  baseUrl: string;
  authType: "none" | "bearer";
  credentialEnv: string;
  models: ConsumerModelRegistration[];
  updatedAt: string;
}

const CONSUMER_ROUTE_PREFIX = "consumer--";
const PUBLIC_ROUTE_IDS = new Set(["fast", "default", "smart"]);
const LOCAL_CONNECTION_ID = "hosted--local";

export interface CreateHostOptions {
  store?: SqliteStore;
  fakeAdapter?: FakeEngineAdapter;
  adapters?: EngineAdapter[];
  initialRecipes?: Recipe[];
  initialRoutes?: Route[];
  resourceMonitor?: ResourceMonitor;
  resourcePolicy?: Partial<ResourcePolicy>;
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
  const events = new LifecycleEventBus(1_000, store.latestLifecycleSequence());
  const fakeAdapter = options.adapters ? options.fakeAdapter : (options.fakeAdapter ?? new FakeEngineAdapter());
  const adapterList = options.adapters ?? (fakeAdapter ? [fakeAdapter, new OpenAICompatibleEngineAdapter()] : [new OpenAICompatibleEngineAdapter()]);
  const adapters = new EngineAdapterRegistry(adapterList);
  const resources = new ResourceGovernor(
    options.resourceMonitor ?? new SystemResourceMonitor(),
    options.resourcePolicy,
  );
  const lifecycle = new LifecycleManager({ adapters, events, resources });
  const localRecipes = [...new Map(routes.listRoutes().filter((route) => PUBLIC_ROUTE_IDS.has(route.id)).map((route) => {
    const recipe = routes.resolve(route.id).recipe;
    return [recipe.id, recipe] as const;
  })).values()].filter((recipe) => recipe.adapter !== "openai-compatible");
  void Promise.allSettled(localRecipes.map((recipe) => lifecycle.prepare(recipe)));
  const scheduler = new InferenceScheduler(routes, lifecycle, events);
  const agentRuns = new AgentRunCoordinator(store, scheduler, options.agentRuntime, options.safety ? (runId) => void options.safety!.collect().catch(() => undefined) : undefined);
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
    if (event.type === "queue.updated") store.recordQueueEvent(event);
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
      recovery: { interruptedRequests: recoveredInterruptedRequests, interruptedAgentRuns: recoveredAgentRuns, interruptedToolApprovals: recoveredToolApprovals },
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
  app.get("/api/v1/artifacts/:artifactId/content", async (request, reply) => { const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId); if (!artifact) return reply.code(404).send({ error: "Artifact not found" }); const session = store.getSession(artifact.sessionId); if (!session || !canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Artifact access denied" }); const content = store.getArtifactContent(artifact.id); if (!content) return reply.code(404).send({ error: "Artifact content not found" }); return reply.header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox; default-src 'none'").header("content-disposition", `attachment; filename="${safeFilename(artifact.name)}"`).type(artifact.mimeType).send(Buffer.from(content)); });
  app.delete("/api/v1/artifacts/:artifactId", async (request, reply) => { const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId); if (!artifact) return reply.code(404).send({ error: "Artifact not found" }); const session = store.getSession(artifact.sessionId); const principal = principals.get(request); if (!session || !canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Artifact access denied" }); store.deleteArtifact(artifact.id); security?.audit("artifact.deleted", principal?.user.id, "artifact", artifact.id, { sessionId: artifact.sessionId, name: artifact.name }); return reply.code(204).send(); });
  app.post("/api/v1/sessions/:sessionId/tool-approvals", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = requireRecord(request.body); const toolName = requireString(body.toolName, "toolName"); const decision = store.resolveToolPolicy(principal?.user.id, principal?.user.role, toolName); const now = new Date().toISOString(); const approval = { id: randomUUID(), sessionId: session.id, toolCallId: requireString(body.toolCallId, "toolCallId"), toolName, status: decision === "allow" ? "approved" as const : decision === "deny" ? "denied" as const : "pending" as const, request: isRecord(body.request) ? body.request : {}, requestedAt: now, ...(typeof body.runId === "string" ? { runId: body.runId } : {}), ...(decision !== "ask" ? { resolvedAt: now } : {}) }; store.createToolApproval(approval); security?.audit("tool-approval.requested", principal?.user.id, "tool-approval", approval.id, { toolName, decision }); return reply.code(201).send({ data: approval }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId/tool-approvals", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const query = request.query as { status?: string }; return { data: store.listToolApprovals(session.id, parseApprovalStatus(query.status)) }; });
  app.post("/api/v1/tool-approvals/:approvalId/decision", async (request, reply) => { try { const approval = store.getToolApproval((request.params as { approvalId: string }).approvalId); if (!approval) return reply.code(404).send({ error: "Approval not found" }); const session = store.getSession(approval.sessionId); if (!session || !canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Approval access denied" }); const body = requireRecord(request.body); if (body.decision !== "approved" && body.decision !== "denied") throw new TypeError("decision must be approved or denied"); const principal = principals.get(request); if (!store.resolveToolApproval(approval.id, body.decision, principal?.user.id, typeof body.note === "string" ? body.note : undefined)) return reply.code(409).send({ error: "Approval is no longer pending" }); security?.audit("tool-approval.resolved", principal?.user.id, "tool-approval", approval.id, { decision: body.decision }); return { data: store.getToolApproval(approval.id) }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });

  app.get(
    "/api/v1/management/status",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async () => {
      const resourceSnapshot = await resources.snapshot();
      return {
        engine: lifecycle.snapshot(),
        queueDepth: scheduler.queueDepth,
        resources: { ...resourceSnapshot, policy: resources.policy },
        routes: routes.listRoutes(),
        recipes: routes.listRecipes(),
        engines: store.listEngines(),
        hostName: hostname(),
        engineRoot: store.getSetting<string>("engineRoot") ?? configuredEngineRoot,
        engineFolders: scanEngineFolders(store.getSetting<string>("engineRoot") ?? configuredEngineRoot, store.listEngines()),
        recoveredInterruptedRequests,
        recoveredAgentRuns,
        recoveredToolApprovals,
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
        const baseUrl = normalizeConsumerBaseUrl(body.baseUrl);
        const authType = body.authType === "none" ? "none" : body.authType === "bearer" ? "bearer" : undefined;
        if (!authType) throw new TypeError("authType must be none or bearer");
        const apiKey = authType === "bearer" ? requireString(body.apiKey, "apiKey") : undefined;
        const credentialEnv = consumerCredentialEnvironment(connectionId);
        if (apiKey) process.env[credentialEnv] = apiKey;
        else delete process.env[credentialEnv];
        const discovered = await new OpenAICompatibleClient({ ...(apiKey ? { apiKey } : {}) }).listModels(baseUrl, AbortSignal.timeout(15_000));
        const modelIds = [...new Set(discovered.filter(supportsChatCompletions).map((item) => item.id.trim()).filter(Boolean))];
        if (!modelIds.length) throw new Error("The API returned no chat-completion models");

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
        const connection: ConsumerConnectionRegistration = { id: connectionId, displayName, baseUrl, authType, credentialEnv, models, updatedAt: new Date().toISOString() };
        store.setSetting("consumerConnections", [...registrations.filter((item) => item.id !== connectionId), connection]);
        security?.audit("consumer-connection.saved", principals.get(request)?.user.id, "consumer-connection", connectionId, { displayName, baseUrl, modelCount: models.length });
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
    async () => ({ data: routes.listRoutes() }),
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

  app.put(
    "/api/v1/management/routes/:routeId",
    { preHandler: adminGuard(options.adminToken, authMode, principals) },
    async (request, reply) => {
      const routeId = (request.params as { routeId: string }).routeId;
      try {
        const route = parseRoute(request.body, routeId);
        const recipeExists = routes.listRecipes().some((recipe) => recipe.id === route.recipeId);
        if (!recipeExists) throw new RecipeNotFoundError(route.recipeId);
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
  app.get("/api/v1/management/users/:userId/access", { preHandler: administratorGuard }, async (request, reply) => { const userId = (request.params as { userId: string }).userId; const user = store.getUser(userId); if (!user) return reply.code(404).send({ error: "User not found" }); return { data: { user, devices: store.listDevices(userId), routeIds: store.listUserRouteGrants(userId), quota: store.getUserQuota(userId) ?? DEFAULT_QUOTAS[user.role], currentDeviceId: principals.get(request)?.device.id } }; });
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

function requirePublicRouteId(value: unknown): "fast" | "default" | "smart" {
  if (value === undefined) return "default";
  if (value !== "fast" && value !== "default" && value !== "smart") throw new TypeError("routeId must be fast, default, or smart");
  return value;
}

function removeConsumerRegistration(connection: ConsumerConnectionRegistration, store: SqliteStore, routes: RouteResolver, removeAssignments = true): void {
  const recipeIds = new Set(connection.models.map((model) => model.recipeId));
  if (removeAssignments) {
    for (const route of routes.listRoutes()) {
      if (!recipeIds.has(route.recipeId)) continue;
      routes.deleteRoute(route.id); store.deleteRoute(route.id);
    }
  }
  for (const model of connection.models) {
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
    models: connection.models.map((model) => ({ id: model.modelId, routeId: model.routeId, recipeId: model.recipeId })),
    updatedAt: connection.updatedAt,
  };
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
  if (typeof value.recipeId !== "string" || value.recipeId.length === 0) {
    throw new TypeError("recipeId must be a non-empty string");
  }
  if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  return {
    id: routeId,
    displayName: value.displayName,
    recipeId: value.recipeId,
    enabled: value.enabled,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.isDefault === "boolean" ? { isDefault: value.isDefault } : {}),
  };
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
function isTerminalRun(status: string | undefined): boolean { return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"; }
function isTerminalAgentEvent(type: string): boolean { return type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.interrupted"; }
function parseApprovalStatus(value: string | undefined): "pending" | "approved" | "denied" | "cancelled" | undefined { return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" ? value : undefined; }
function decodeBase64(value: unknown): Buffer { if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new TypeError("contentBase64 must be valid padded base64"); return Buffer.from(value, "base64"); }
function safeFilename(value: string): string { return value.replace(/[\r\n"\\/]/g, "_").slice(0, 160) || "artifact"; }

function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  const address = request.ip.startsWith("::ffff:") ? request.ip.slice("::ffff:".length) : request.ip;
  if (address !== "127.0.0.1" && address !== "::1") return false;
  const proxyHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host", "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];
  return proxyHeaders.every((name) => request.headers[name] === undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
