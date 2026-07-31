import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
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
  type Recipe,
  type Route,
  type AgentRunRequest,
  type SessionRecord,
  type ToolPolicyRecord,
} from "@fitz/protocol";
import { MetricsRegistry, redactSecrets } from "@fitz/observability";
import { SecurityPolicyError, SecurityService, type AuthenticatedPrincipal } from "@fitz/security";
import { SqliteStore } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import { AgentRunCoordinator } from "./agent-runs.js";
import type { AgentRuntime } from "@fitz/agent-core";
import { ContextManager } from "@fitz/context";
import { TailscaleMonitor, TailscaleServeManager } from "@fitz/connectivity";
import { classifyArtifact, normalizeMimeType } from "@fitz/media";

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
  security?: SecurityService;
  agentRuntime?: AgentRuntime;
  contextManager?: ContextManager;
  tailscaleMonitor?: TailscaleMonitor;
  tailscaleServeManager?: TailscaleServeManager;
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
    bodyLimit: 2 * 1024 * 1024,
  });
  const store = options.store ?? SqliteStore.memory();
  const authMode = options.authMode ?? "disabled";
  const security = options.security ?? (authMode === "required" ? new SecurityService(store, options.authPepper ?? "") : undefined);
  const recoveredInterruptedRequests = store.recoverInterruptedRequests();
  const recoveredAgentRuns = store.recoverInterruptedAgentRuns();
  seedDefaults(
    store,
    options.initialRecipes ?? DEFAULT_RECIPES,
    options.initialRoutes ?? DEFAULT_ROUTES,
  );
  const routes = new RouteResolver(store.listRoutes(), store.listRecipes());
  const events = new LifecycleEventBus(1_000, store.latestLifecycleSequence());
  const fakeAdapter = options.adapters ? options.fakeAdapter : (options.fakeAdapter ?? new FakeEngineAdapter());
  const adapterList = options.adapters ?? (fakeAdapter ? [fakeAdapter] : []);
  const adapters = new EngineAdapterRegistry(adapterList);
  const resources = new ResourceGovernor(
    options.resourceMonitor ?? new SystemResourceMonitor(),
    options.resourcePolicy,
  );
  const lifecycle = new LifecycleManager({ adapters, events, resources });
  const scheduler = new InferenceScheduler(routes, lifecycle, events);
  const agentRuns = new AgentRunCoordinator(store, scheduler, options.agentRuntime);
  const context = options.contextManager ?? new ContextManager(store);
  const tailscale = options.tailscaleMonitor ?? new TailscaleMonitor();
  const tailscaleServe = options.tailscaleServeManager ?? new TailscaleServeManager();
  const metrics = new MetricsRegistry();
  const unsubscribePersistence = events.subscribe((event) => {
    store.appendLifecycleEvent(event);
    if (event.type === "queue.updated") store.recordQueueEvent(event);
  });
  const unsubscribeMetrics = events.subscribe((event) => metrics.observeLifecycleEvent(event));
  const requestStarts = new WeakMap<object, number>();
  const principals = new WeakMap<object, AuthenticatedPrincipal>();

  app.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, performance.now());
    if (authMode === "required" && request.url.split("?")[0] !== "/health" && request.url.split("?")[0] !== "/api/v1/pairing/redeem") {
      const principal = security?.authenticate(request.headers.authorization);
      if (!principal) return reply.code(401).send({ error: "Valid device bearer token required" });
      principals.set(request, principal);
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
      recovery: { interruptedRequests: recoveredInterruptedRequests, interruptedAgentRuns: recoveredAgentRuns },
    };
  });

  app.get("/v1/models", async (request): Promise<ModelListResponse> => ({
    object: "list",
    data: routes.listRoutes().filter((route) => {
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
    try {
      body = parseChatCompletionRequest(request.body);
      const resolved = routes.resolve(body.model);
      const principal = principals.get(request);
      if (principal && !security?.authorizeRoute(principal, body.model)) {
        return reply.code(403).send(openAIError(new SecurityPolicyError("Route access denied"), "permission_error"));
      }
      if (principal) {
        const promptChars = body.messages.reduce((total, message) => total + JSON.stringify(message.content).length, 0);
        security?.enforceQuota(principal, promptChars, body.max_tokens ?? principal.quota.maxOutputTokens, scheduler.queueDepth);
      }
      if (!resolved.recipe.capabilities.chatCompletions) {
        throw new TypeError(`Route ${body.model} does not support chat completions`);
      }
      if (body.stream !== false && !resolved.recipe.capabilities.streaming) {
        throw new TypeError(`Route ${body.model} does not support streaming`);
      }
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send(openAIError(error, "invalid_request_error"));
    }

    const stream = scheduler.enqueue(body.model, {
      messages: body.messages,
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.stop !== undefined ? { stop: body.stop } : {}),
      ...(principals.get(request) ? { userId: principals.get(request)!.user.id } : body.user !== undefined ? { userId: body.user } : {}),
    });

    if (body.stream === false) {
      try {
        return await collectCompletion(stream.requestId, body.model, stream);
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

    writeSse(reply, streamChunk(completionId, created, body.model, { role: "assistant" }, null));
    try {
      for await (const delta of stream) {
        writeSse(
          reply,
          streamChunk(
            completionId,
            created,
            body.model,
            delta.text ? { content: delta.text } : {},
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
  app.post("/api/v1/pairing/redeem", async (request, reply) => { try { const body = requireRecord(request.body); const redeemed = securityRequired(security).redeemPairingCode(requireString(body.code, "code"), requireString(body.displayName, "displayName"), requireString(body.deviceName, "deviceName")); return reply.code(201).send({ data: redeemed }); } catch (error) { return reply.code(error instanceof SecurityPolicyError ? 403 : 400).send({ error: errorMessage(error) }); } });

  app.post("/api/v1/agent/runs", async (request, reply) => {
    try {
      const body = parseAgentRunRequest(request.body); const principal = principals.get(request);
      if (body.sessionId) { const session = store.getSession(body.sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); }
      if (principal && !security?.authorizeRoute(principal, body.model)) return reply.code(403).send({ error: "Route access denied" });
      if (principal) { const promptChars = body.messages.reduce((total, message) => total + message.content.length, 0); security?.enforceQuota(principal, promptChars, body.maxTokens ?? principal.quota.maxOutputTokens, scheduler.queueDepth); }
      const resolved = routes.resolve(body.model); const prepared = await context.prepare(body, resolved.recipe.contextTokens); const run = agentRuns.start(prepared.request, principal?.user.id, body.messages); security?.audit("agent-run.created", principal?.user.id, "agent-run", run.id, { routeId: run.routeId, compacted: prepared.compacted });
      return reply.code(202).send({ protocolVersion: PROTOCOL_VERSION, data: run, context: { compacted: prepared.compacted, estimatedInputTokens: prepared.estimatedInputTokens, budgetTokens: prepared.budgetTokens } });
    } catch (error) { return reply.code(error instanceof SecurityPolicyError ? 429 : error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/agent/runs", async (request) => { const principal = principals.get(request); const query = request.query as { limit?: string }; return { protocolVersion: PROTOCOL_VERSION, data: agentRuns.list(principal?.user.role === "administrator" ? undefined : principal?.user.id, Math.min(toNonNegativeInteger(query.limit, 100), 1000)) }; });
  app.get("/api/v1/agent/runs/:runId", async (request, reply) => { const run = agentRuns.get((request.params as { runId: string }).runId); if (!run) return reply.code(404).send({ error: "Run not found" }); if (!canAccessRun(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" }); return { protocolVersion: PROTOCOL_VERSION, data: run }; });
  app.delete("/api/v1/agent/runs/:runId", async (request, reply) => { const runId = (request.params as { runId: string }).runId; const run = agentRuns.get(runId); if (!run) return reply.code(404).send({ error: "Run not found" }); if (!canAccessRun(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" }); if (!agentRuns.cancel(runId)) return reply.code(409).send({ error: "Run is no longer active" }); return reply.code(202).send({ data: { id: runId, cancellationRequested: true } }); });
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
  app.get("/api/v1/projects/:projectId/sessions", async (request, reply) => { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); return { data: store.listSessions(project.id, principal?.user.role === "administrator" ? undefined : principal?.user.id) }; });
  app.post("/api/v1/projects/:projectId/sessions", async (request, reply) => { try { const project = store.getProject((request.params as { projectId: string }).projectId); if (!project) return reply.code(404).send({ error: "Project not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" }); const body = requireRecord(request.body); const now = new Date().toISOString(); const session = { id: randomUUID(), projectId: project.id, title: requireString(body.title, "title"), status: "active" as const, createdAt: now, updatedAt: now, ...(principal ? { ownerUserId: principal.user.id } : {}) }; store.createSession(session); security?.audit("session.created", principal?.user.id, "session", session.id, { projectId: project.id }); return reply.code(201).send({ data: session }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); return { data: session }; });
  app.patch("/api/v1/sessions/:sessionId", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = requireRecord(request.body); const updated: SessionRecord = { ...session, ...(typeof body.title === "string" ? { title: requireString(body.title, "title") } : {}), ...(body.status === "active" || body.status === "archived" ? { status: body.status } : {}), updatedAt: new Date().toISOString() }; store.updateSession(updated); return { data: updated }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/sessions/:sessionId/transcript", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const query = request.query as { after?: string; limit?: string }; return { data: store.transcriptAfter(session.id, toNonNegativeInteger(query.after, 0), Math.min(toNonNegativeInteger(query.limit, 1000), 1000)) }; });
  app.get("/api/v1/sessions/:sessionId/artifacts", async (request, reply) => { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); return { data: store.listArtifacts(session.id) }; });
  app.post("/api/v1/sessions/:sessionId/artifacts", async (request, reply) => { try { const session = store.getSession((request.params as { sessionId: string }).sessionId); if (!session) return reply.code(404).send({ error: "Session not found" }); const principal = principals.get(request); if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" }); const body = requireRecord(request.body); const name = requireString(body.name, "name"); const mimeType = normalizeMimeType(requireString(body.mimeType, "mimeType")); const content = decodeBase64(body.contentBase64); if (content.byteLength > 1_500_000) throw new TypeError("Artifact exceeds the 1500000 byte limit"); const artifact = { id: randomUUID(), sessionId: session.id, name, mimeType, kind: classifyArtifact(mimeType, name), byteSize: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"), createdAt: new Date().toISOString(), metadata: isRecord(body.metadata) ? body.metadata : {}, ...(principal ? { createdByUserId: principal.user.id } : {}) }; store.createArtifact(artifact, content); security?.audit("artifact.created", principal?.user.id, "artifact", artifact.id, { sessionId: session.id, mimeType, byteSize: artifact.byteSize }); return reply.code(201).send({ data: artifact }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/artifacts/:artifactId/content", async (request, reply) => { const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId); if (!artifact) return reply.code(404).send({ error: "Artifact not found" }); const session = store.getSession(artifact.sessionId); if (!session || !canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Artifact access denied" }); const content = store.getArtifactContent(artifact.id); if (!content) return reply.code(404).send({ error: "Artifact content not found" }); return reply.header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox; default-src 'none'").header("content-disposition", `attachment; filename="${safeFilename(artifact.name)}"`).type(artifact.mimeType).send(Buffer.from(content)); });
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
        recoveredInterruptedRequests,
        recoveredAgentRuns,
      };
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
  app.post("/api/v1/management/connectivity/tailscale-serve", { preHandler: administratorGuard }, async (request, reply) => { try { const body = requireRecord(request.body); const localPort = body.localPort === undefined ? 8787 : requireInteger(body.localPort); const httpsPort = body.httpsPort === undefined ? 443 : requireInteger(body.httpsPort); await tailscaleServe.enable(localPort, httpsPort); security?.audit("tailscale-serve.enabled", principals.get(request)?.user.id, "connectivity", "tailscale", { localPort, httpsPort }); return { data: await tailscaleServe.status() }; } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.delete("/api/v1/management/connectivity/tailscale-serve", { preHandler: administratorGuard }, async (request, reply) => { try { const query = request.query as { httpsPort?: string }; const httpsPort = toNonNegativeInteger(query.httpsPort, 443); await tailscaleServe.disable(httpsPort); security?.audit("tailscale-serve.disabled", principals.get(request)?.user.id, "connectivity", "tailscale", { httpsPort }); return reply.code(204).send(); } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); } });
  app.post("/api/v1/management/pairing-codes", { preHandler: administratorGuard }, async (request, reply) => { try { const body = requireRecord(request.body); const role = parseRole(body.intendedRole); const ttlSeconds = body.ttlSeconds === undefined ? 600 : requireInteger(body.ttlSeconds); const pairing = securityRequired(security).issuePairingCode(role, ttlSeconds); security?.audit("pairing-code.issued", principals.get(request)?.user.id, "pairing-code", pairing.id, { intendedRole: role, expiresAt: pairing.expiresAt }); return reply.code(201).send({ data: pairing }); } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/tool-policies", { preHandler: administratorGuard }, async () => ({ data: store.listToolPolicies() }));
  app.put("/api/v1/management/tool-policies/:subjectType/:subjectId/:toolName", { preHandler: administratorGuard }, async (request, reply) => { try { const params = request.params as { subjectType: string; subjectId: string; toolName: string }; if (params.subjectType !== "role" && params.subjectType !== "user") throw new TypeError("subjectType must be role or user"); const body = requireRecord(request.body); if (body.decision !== "allow" && body.decision !== "deny" && body.decision !== "ask") throw new TypeError("decision must be allow, deny, or ask"); const policy: ToolPolicyRecord = { subjectType: params.subjectType, subjectId: params.subjectId, toolName: params.toolName, decision: body.decision, updatedAt: new Date().toISOString() }; store.upsertToolPolicy(policy); security?.audit("tool-policy.updated", principals.get(request)?.user.id, "tool-policy", `${params.subjectType}:${params.subjectId}:${params.toolName}`, { decision: body.decision }); return { data: policy }; } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); } });
  app.get("/api/v1/management/users", { preHandler: administratorGuard }, async () => ({ data: store.listUsers() }));
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

  app.addHook("onClose", async () => {
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

async function collectCompletion(
  requestId: string,
  model: string,
  stream: AsyncIterable<InferenceDelta>,
): Promise<Record<string, unknown>> {
  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason = "stop";
  for await (const delta of stream) {
    content += delta.text;
    if (delta.promptTokens !== undefined) promptTokens = delta.promptTokens;
    if (delta.completionTokens !== undefined) completionTokens = delta.completionTokens;
    if (delta.finishReason) finishReason = delta.finishReason;
  }
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
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

function parseAgentRunRequest(value: unknown): AgentRunRequest { const parsed = parseChatCompletionRequest(value); const source = requireRecord(value); return { model: parsed.model, messages: parsed.messages, ...(parsed.max_tokens !== undefined ? { maxTokens: parsed.max_tokens } : {}), ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}), ...(typeof source.sessionId === "string" ? { sessionId: source.sessionId } : {}) }; }
function canAccessRun(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId; }
function canAccessOwner(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean { return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId; }
function isTerminalRun(status: string | undefined): boolean { return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted"; }
function isTerminalAgentEvent(type: string): boolean { return type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.interrupted"; }
function parseApprovalStatus(value: string | undefined): "pending" | "approved" | "denied" | "cancelled" | undefined { return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" ? value : undefined; }
function decodeBase64(value: unknown): Buffer { if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new TypeError("contentBase64 must be valid padded base64"); return Buffer.from(value, "base64"); }
function safeFilename(value: string): string { return value.replace(/[\r\n"\\/]/g, "_").slice(0, 160) || "artifact"; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
