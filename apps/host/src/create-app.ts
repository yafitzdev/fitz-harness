import { randomUUID } from "node:crypto";
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
} from "@fitz/protocol";
import { MetricsRegistry, redactSecrets } from "@fitz/observability";
import { SqliteStore } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";

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
}

export interface HostRuntime {
  app: FastifyInstance;
  store: SqliteStore;
  routes: RouteResolver;
  events: LifecycleEventBus;
  lifecycle: LifecycleManager;
  scheduler: InferenceScheduler;
  metrics: MetricsRegistry;
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
  const recoveredInterruptedRequests = store.recoverInterruptedRequests();
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
  const metrics = new MetricsRegistry();
  const unsubscribePersistence = events.subscribe((event) => {
    store.appendLifecycleEvent(event);
    if (event.type === "queue.updated") store.recordQueueEvent(event);
  });
  const unsubscribeMetrics = events.subscribe((event) => metrics.observeLifecycleEvent(event));
  const requestStarts = new WeakMap<object, number>();

  app.addHook("onRequest", async (request) => {
    requestStarts.set(request, performance.now());
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
      recovery: { interruptedRequests: recoveredInterruptedRequests },
    };
  });

  app.get("/v1/models", async (): Promise<ModelListResponse> => ({
    object: "list",
    data: routes.listRoutes().map((route) => ({
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
      if (!resolved.recipe.capabilities.chatCompletions) {
        throw new TypeError(`Route ${body.model} does not support chat completions`);
      }
      if (body.stream !== false && !resolved.recipe.capabilities.streaming) {
        throw new TypeError(`Route ${body.model} does not support streaming`);
      }
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : 400;
      return reply.code(statusCode).send(openAIError(error, "invalid_request_error"));
    }

    const stream = scheduler.enqueue(body.model, {
      messages: body.messages,
      ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.stop !== undefined ? { stop: body.stop } : {}),
      ...(body.user !== undefined ? { userId: body.user } : {}),
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

  app.get(
    "/api/v1/management/status",
    { preHandler: adminGuard(options.adminToken) },
    async () => {
      const resourceSnapshot = await resources.snapshot();
      return {
        engine: lifecycle.snapshot(),
        queueDepth: scheduler.queueDepth,
        resources: { ...resourceSnapshot, policy: resources.policy },
        routes: routes.listRoutes(),
        recipes: routes.listRecipes(),
        recoveredInterruptedRequests,
      };
    },
  );

  app.get(
    "/api/v1/management/requests",
    { preHandler: adminGuard(options.adminToken) },
    async (request) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(toNonNegativeInteger(query.limit, 100), 1_000);
      return { data: store.listInferenceRequests(limit) };
    },
  );

  app.get(
    "/api/v1/management/metrics",
    { preHandler: adminGuard(options.adminToken) },
    async () => metrics.snapshot(),
  );

  app.get(
    "/api/v1/management/diagnostics",
    { preHandler: adminGuard(options.adminToken) },
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
    { preHandler: adminGuard(options.adminToken) },
    async () => ({ data: routes.listRoutes() }),
  );

  app.put(
    "/api/v1/management/routes/:routeId",
    { preHandler: adminGuard(options.adminToken) },
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
    { preHandler: adminGuard(options.adminToken) },
    async (_request, reply) => {
      try {
        await lifecycle.stop("management-request", "graceful");
        return { engine: lifecycle.snapshot() };
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

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
    metrics,
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

function adminGuard(expectedToken?: string) {
  return async (request: { headers: Record<string, string | string[] | undefined> }, reply: any) => {
    if (!expectedToken) return;
    if (request.headers["x-fitz-admin-token"] !== expectedToken) {
      return reply.code(403).send({ error: "Administrator authorization required" });
    }
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
