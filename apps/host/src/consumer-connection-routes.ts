import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { RecipeNotFoundError, type RouteResolver } from "@fitz/inference-core";
import type { HostAccessClass, InferenceExecutionClass, MediaModality, Recipe, Route } from "@fitz/protocol";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import {
  OpenAICompatibleClient,
  supportsChatCompletions,
  type OpenAICompatibleModel,
} from "@fitz/engine-openai-compatible";
import {
  FAL_DEFAULT_BASE_URL,
  REPLICATE_DEFAULT_BASE_URL,
  type MediaProviderRegistry,
  type ProviderModel,
} from "@fitz/media-providers";
import {
  LOCAL_OWNER_ID,
  type CloudRouteRole,
  type ConsumerConnectionRegistration,
  type ConsumerMediaModelRegistration,
  type ConsumerModelRegistration,
  type UserRouteResolver,
} from "./user-route-resolver.js";

const CONSUMER_ROUTE_PREFIX = "consumer--";
const CONSUMER_TEMPLATES = ["openai-compatible", "openai-media", "fal", "replicate"] as const;
const MEDIA_TEMPLATE_DEFAULT_BASE_URLS: Readonly<Record<string, string | undefined>> = {
  "openai-media": undefined,
  fal: FAL_DEFAULT_BASE_URL,
  replicate: REPLICATE_DEFAULT_BASE_URL,
};

export interface ConsumerConnectionRouteOptions {
  app: FastifyInstance;
  store: SqliteStore;
  routes: RouteResolver;
  userRoutes: UserRouteResolver;
  mediaProviders: MediaProviderRegistry;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  wellKnownMediaRouteIds: readonly string[];
  security?: SecurityService;
}

export function registerConsumerConnectionRoutes(options: ConsumerConnectionRouteOptions): void {
  const { app, store, routes, userRoutes, mediaProviders, principals, security } = options;
  const ownerUserId = (request: FastifyRequest): string => principals.get(request)?.user.id ?? LOCAL_OWNER_ID;

  app.get("/api/v1/cloud-routes", async (request) => ({ data: userRoutes.configuration(ownerUserId(request)) }));
  app.put("/api/v1/cloud-routes/:role", async (request, reply) => {
    try {
      const role = parseCloudRouteRole((request.params as { role: string }).role);
      const recipeId = requireString(requireRecord(request.body).recipeId, "recipeId");
      const binding = userRoutes.assign(ownerUserId(request), role, recipeId);
      security?.audit("cloud-route.assigned", principals.get(request)?.user.id, "cloud-route", role, { recipeId });
      return { data: binding };
    } catch (error) {
      return reply.code(error instanceof RecipeNotFoundError ? 404 : 400).send({ error: errorMessage(error) });
    }
  });
  app.delete("/api/v1/cloud-routes/:role", async (request, reply) => {
    try {
      const role = parseCloudRouteRole((request.params as { role: string }).role);
      userRoutes.clear(ownerUserId(request), role);
      security?.audit("cloud-route.cleared", principals.get(request)?.user.id, "cloud-route", role);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get(
    "/api/v1/connections",
    async (request) => ({ data: userRoutes.connections(ownerUserId(request)).map(publicConsumerConnection) }),
  );

  app.put(
    "/api/v1/connections/:connectionId",
    async (request, reply) => {
      const connectionId = requireIdentifier((request.params as { connectionId: string }).connectionId, "connectionId");
      try {
        const connectionOwnerUserId = ownerUserId(request);
        const body = requireRecord(request.body);
        const displayName = requireString(body.displayName, "displayName");
        const template = parseConsumerTemplate(body.template);
        const baseUrl = normalizeConsumerBaseUrl(
          body.baseUrl === undefined ? MEDIA_TEMPLATE_DEFAULT_BASE_URLS[template] : body.baseUrl,
        );
        const authType = body.authType === "none" ? "none" : body.authType === "bearer" ? "bearer" : undefined;
        if (!authType) throw new TypeError("authType must be none or bearer");
        const apiKey = authType === "bearer" ? requireString(body.apiKey, "apiKey") : undefined;
        const credentialEnv = consumerCredentialEnvironment(connectionOwnerUserId, connectionId);
        if (apiKey) process.env[credentialEnv] = apiKey;
        else delete process.env[credentialEnv];
        const costCentsPerJob = parseCostCentsPerJob(body.costCentsPerJob);
        const requestedModelIds = body.modelIds === undefined ? undefined : requireStringArray(body.modelIds, "modelIds");
        const executionClass = parseExecutionClass(body.executionClass ?? userRoutes.connections(connectionOwnerUserId).find((item) => item.id === connectionId)?.executionClass);
        if (template !== "openai-compatible" && executionClass !== "metered_cloud") {
          throw new TypeError("Media provider connections must use metered cloud execution");
        }
        const accessClass = accessClassFor(baseUrl, executionClass);

        const client = new OpenAICompatibleClient({ ...(apiKey ? { apiKey } : {}) });
        let discovered: OpenAICompatibleModel[] = [];
        let mediaDiscovery: ProviderModel[] = [];
        if (template === "openai-compatible") {
          discovered = await client.listModels(baseUrl, AbortSignal.timeout(15_000));
        } else {
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

        const previous = userRoutes.connections(connectionOwnerUserId).find((item) => item.id === connectionId);
        const previousRecipes = new Map((previous?.models ?? []).flatMap((model) => {
          try { return [[model.modelId, routes.resolveRecipe(model.recipeId)] as const]; }
          catch { return []; }
        }));
        if (previous) removeConsumerRegistration(previous, store, routes, options.wellKnownMediaRouteIds, false);
        const models = modelIds.map((modelId) => consumerModelRegistration(connectionOwnerUserId, connectionId, modelId));
        for (const model of models) {
          const previousRecipe = previousRecipes.get(model.modelId);
          const recipe: Recipe = {
            id: model.recipeId,
            playbookId: consumerPlaybookId(connectionOwnerUserId, connectionId),
            displayName: previousRecipe?.displayName ?? model.modelId,
            adapter: "openai-compatible",
            modelId: model.modelId,
            executionClass,
            contextTokens: previousRecipe?.contextTokens ?? 131_072,
            capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 8 },
            lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
            ...(executionClass === "self_hosted" && previousRecipe?.agentTopology ? { agentTopology: previousRecipe.agentTopology } : {}),
            configuration: {
              baseUrl,
              ...(authType === "bearer" ? { apiKeyEnv: credentialEnv } : {}),
              healthPath: consumerHealthPath(baseUrl),
            },
          };
          store.upsertRecipe(recipe);
          routes.upsertRecipe(recipe);
        }
        const mediaModels = saveMediaRecipes(store, routes, {
          connectionId,
          ownerUserId: connectionOwnerUserId,
          template,
          displayName,
          baseUrl,
          credentialEnv,
          authType,
          ...(costCentsPerJob !== undefined ? { costCentsPerJob } : {}),
          models: mediaDiscovery,
        });
        clearStaleMediaRouteAssignments(store, routes, options.wellKnownMediaRouteIds);
        const connection: ConsumerConnectionRegistration = {
          ownerUserId: connectionOwnerUserId,
          id: connectionId,
          displayName,
          baseUrl,
          template,
          executionClass,
          accessClass,
          authType,
          credentialEnv,
          models,
          mediaModels,
          updatedAt: new Date().toISOString(),
        };
        userRoutes.replaceConnection(connectionOwnerUserId, connection);
        security?.audit("consumer-connection.saved", principals.get(request)?.user.id, "consumer-connection", connectionId, {
          displayName,
          baseUrl,
          modelCount: models.length,
          mediaModelCount: mediaModels.length,
        });
        return { data: publicConsumerConnection(connection) };
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete(
    "/api/v1/connections/:connectionId",
    async (request, reply) => {
      const connectionId = requireIdentifier((request.params as { connectionId: string }).connectionId, "connectionId");
      const connectionOwnerUserId = ownerUserId(request);
      const connection = userRoutes.connections(connectionOwnerUserId).find((item) => item.id === connectionId);
      if (!connection) return reply.code(404).send({ error: "Connection not found" });
      removeConsumerRegistration(connection, store, routes, options.wellKnownMediaRouteIds);
      delete process.env[connection.credentialEnv];
      userRoutes.removeConnection(connectionOwnerUserId, connectionId);
      security?.audit("consumer-connection.removed", principals.get(request)?.user.id, "consumer-connection", connectionId);
      return reply.code(204).send();
    },
  );
}

export function discardLegacyConsumerConnections(store: SqliteStore): void {
  const value = store.getSetting<unknown>("consumerConnections");
  if (!Array.isArray(value)) return;
  const owned: unknown[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.ownerUserId === "string" && item.ownerUserId) {
      const executionClass = item.executionClass === "self_hosted" || item.executionClass === "metered_cloud"
        ? item.executionClass
        : "metered_cloud";
      const accessClass = item.accessClass === "same_device" || item.accessClass === "trusted_remote" || item.accessClass === "public_remote"
        ? item.accessClass
        : accessClassFor(typeof item.baseUrl === "string" ? item.baseUrl : "https://invalid.example", executionClass);
      for (const model of Array.isArray(item.models) ? item.models : []) {
        if (!isRecord(model) || typeof model.recipeId !== "string") continue;
        const recipe = store.listRecipes().find((candidate) => candidate.id === model.recipeId);
        if (!recipe) continue;
        const keepTopology = executionClass === "self_hosted";
        const { agentTopology: retiredTopology, ...withoutAgentTopology } = recipe;
        store.upsertRecipe({
          ...(keepTopology && retiredTopology ? recipe : withoutAgentTopology),
          executionClass,
        });
      }
      for (const model of Array.isArray(item.mediaModels) ? item.mediaModels : []) {
        if (!isRecord(model) || typeof model.recipeId !== "string") continue;
        const recipe = store.listRecipes().find((candidate) => candidate.id === model.recipeId);
        if (recipe) store.upsertRecipe({ ...recipe, executionClass: "metered_cloud" });
      }
      owned.push({ ...item, executionClass, accessClass });
      continue;
    }
    if (!isRecord(item)) continue;
    const models = [...(Array.isArray(item.models) ? item.models : []), ...(Array.isArray(item.mediaModels) ? item.mediaModels : [])];
    for (const model of models) {
      if (!isRecord(model)) continue;
      if (typeof model.routeId === "string") store.deleteRoute(model.routeId);
      if (typeof model.recipeId === "string") store.deleteRecipe(model.recipeId);
    }
  }
  store.setSetting("consumerConnections", owned);
  ensureRecipeExecutionClasses(store);
}

/** Materializes the v4 classification on every recipe, including native
 * recipes discovered by an engine reconciler after the legacy migration ran. */
export function ensureRecipeExecutionClasses(store: SqliteStore): void {
  const classes = new Map<string, InferenceExecutionClass>();
  const value = store.getSetting<unknown>("consumerConnections");
  for (const item of Array.isArray(value) ? value : []) {
    if (!isRecord(item)) continue;
    const executionClass: InferenceExecutionClass = item.executionClass === "self_hosted" ? "self_hosted" : "metered_cloud";
    for (const model of Array.isArray(item.models) ? item.models : []) {
      if (isRecord(model) && typeof model.recipeId === "string") classes.set(model.recipeId, executionClass);
    }
    for (const model of Array.isArray(item.mediaModels) ? item.mediaModels : []) {
      if (isRecord(model) && typeof model.recipeId === "string") classes.set(model.recipeId, "metered_cloud");
    }
  }
  for (const recipe of store.listRecipes()) {
    if (!recipe.executionClass) store.upsertRecipe({ ...recipe, executionClass: classes.get(recipe.id) ?? "self_hosted" });
  }
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

function requireBaseUrl(value: unknown): string {
  const baseUrl = requireString(value, "baseUrl");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("baseUrl must use http or https");
  if (url.username || url.password) throw new TypeError("baseUrl must not contain credentials");
  return url.toString().replace(/\/$/, "");
}

function consumerHealthPath(baseUrl: string): string {
  return /\/v1$/i.test(new URL(baseUrl).pathname.replace(/\/$/, "")) ? "/models" : "/v1/models";
}

function consumerCredentialEnvironment(ownerUserId: string, connectionId: string): string {
  return `FITZ_CONSUMER_${createHash("sha256").update(`${ownerUserId}:${connectionId}`).digest("hex").slice(0, 16).toUpperCase()}`;
}

function consumerModelRegistration(ownerUserId: string, connectionId: string, modelId: string): ConsumerModelRegistration {
  const suffix = createHash("sha256").update(modelId).digest("hex").slice(0, 16);
  return { modelId, recipeId: `consumer-recipe--${consumerNamespace(ownerUserId, connectionId)}--${suffix}` };
}

function consumerMediaRecipeId(ownerUserId: string, connectionId: string, modelId: string): string {
  const suffix = createHash("sha256").update(modelId).digest("hex").slice(0, 16);
  return `consumer-recipe--media--${consumerNamespace(ownerUserId, connectionId)}--${suffix}`;
}

function consumerMediaRouteId(ownerUserId: string, connectionId: string, modelId: string, modality: MediaModality): string {
  const suffix = createHash("sha256").update(`${modelId}:${modality}`).digest("hex").slice(0, 16);
  return `${CONSUMER_ROUTE_PREFIX}media--${consumerNamespace(ownerUserId, connectionId)}--${suffix}`;
}

function consumerNamespace(ownerUserId: string, connectionId: string): string {
  return `${createHash("sha256").update(ownerUserId).digest("hex").slice(0, 12)}--${connectionId}`;
}

function consumerPlaybookId(ownerUserId: string, connectionId: string): string {
  return `consumer-${consumerNamespace(ownerUserId, connectionId)}`;
}

function parseConsumerTemplate(value: unknown): string {
  if (value === undefined) return "openai-compatible";
  if (typeof value === "string" && (CONSUMER_TEMPLATES as readonly string[]).includes(value)) return value;
  throw new TypeError("template must be openai-compatible, openai-media, fal, or replicate");
}

function parseExecutionClass(value: unknown): InferenceExecutionClass {
  if (value === undefined || value === "metered_cloud") return "metered_cloud";
  if (value === "self_hosted") return value;
  throw new TypeError("executionClass must be self_hosted or metered_cloud");
}

function accessClassFor(baseUrl: string, executionClass: InferenceExecutionClass): HostAccessClass {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "same_device";
  return executionClass === "self_hosted" ? "trusted_remote" : "public_remote";
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

function saveMediaRecipes(
  store: SqliteStore,
  routes: RouteResolver,
  options: {
    ownerUserId: string;
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
    const recipeId = consumerMediaRecipeId(options.ownerUserId, options.connectionId, model.modelId);
    const recipe: Recipe = {
      id: recipeId,
      playbookId: consumerPlaybookId(options.ownerUserId, options.connectionId),
      displayName: model.modelId,
      adapter: options.template,
      modelId: model.modelId,
      executionClass: "metered_cloud",
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
      const routeId = consumerMediaRouteId(options.ownerUserId, options.connectionId, model.modelId, modality);
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

function parseCloudRouteRole(value: unknown): CloudRouteRole {
  if (value === "smart" || value === "fast") return value;
  throw new TypeError("Cloud route role must be smart or fast");
}

function removeConsumerRegistration(
  connection: ConsumerConnectionRegistration,
  store: SqliteStore,
  routes: RouteResolver,
  wellKnownMediaRouteIds: readonly string[],
  removeAssignments = true,
): void {
  const recipeIds = new Set([
    ...connection.models.map((model) => model.recipeId),
    ...(connection.mediaModels ?? []).map((model) => model.recipeId),
  ]);
  const consumerRouteIds = new Set((connection.mediaModels ?? []).map((model) => model.routeId));
  if (removeAssignments) {
    for (const route of routes.listRoutes()) {
      if (!recipeIds.has(route.recipeId) || consumerRouteIds.has(route.id)) continue;
      if (wellKnownMediaRouteIds.includes(route.id)) {
        const updated: Route = { ...route, recipeId: "", enabled: false };
        store.upsertRoute(updated);
        routes.upsertRoute(updated);
      } else {
        routes.deleteRoute(route.id);
        store.deleteRoute(route.id);
      }
    }
  }
  for (const model of connection.models) {
    routes.deleteRecipe(model.recipeId);
    store.deleteRecipe(model.recipeId);
  }
  for (const model of connection.mediaModels ?? []) {
    routes.deleteRoute(model.routeId);
    store.deleteRoute(model.routeId);
    routes.deleteRecipe(model.recipeId);
    store.deleteRecipe(model.recipeId);
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
    executionClass: connection.executionClass,
    accessClass: connection.accessClass,
    models: connection.models.map((model) => ({ id: model.modelId, recipeId: model.recipeId })),
    mediaModels: (connection.mediaModels ?? []).map((model) => ({
      id: model.modelId,
      routeId: model.routeId,
      recipeId: model.recipeId,
      modality: model.modality,
      template: model.template,
    })),
    updatedAt: connection.updatedAt,
  };
}

function clearStaleMediaRouteAssignments(store: SqliteStore, routes: RouteResolver, wellKnownMediaRouteIds: readonly string[]): void {
  const recipeIds = new Set(routes.listRecipes().map((recipe) => recipe.id));
  for (const route of routes.listRoutes(true)) {
    if (!wellKnownMediaRouteIds.includes(route.id)) continue;
    if (route.recipeId && !recipeIds.has(route.recipeId)) {
      const updated: Route = { ...route, recipeId: "", enabled: false };
      store.upsertRoute(updated);
      routes.upsertRoute(updated);
    }
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Body must be an object");
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value as string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
