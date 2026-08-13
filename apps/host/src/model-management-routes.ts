import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import {
  type EngineAdapterRegistry,
  InferenceAdmissionError,
  type InferenceScheduler,
  type LifecycleManager,
  RecipeNotFoundError,
  type RouteResolver,
  isMediaEngineAdapter,
} from "@fitz/inference-core";
import type {
  EngineConnectionMode,
  EngineRegistration,
  EngineRuntime,
  MediaModality,
  ModalityCapabilities,
  ModalityInput,
  Recipe,
  Route,
  RouteKind,
} from "@fitz/protocol";
import type { AuthenticatedPrincipal } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import {
  MediaCoordinatorClosedError,
  MediaJobAdmissionError,
  type MediaJobCoordinator,
} from "./media-jobs.js";
import {
  awaitMediaJob,
  MediaGenerationTimeoutError,
  mediaJobFailureMessage,
  requestOrigin,
} from "./media-routes.js";

export const MEDIA_ROUTE_IDS = ["image", "video", "audio"] as const;

const MEDIA_ROUTE_DISPLAY_NAMES: Record<(typeof MEDIA_ROUTE_IDS)[number], string> = {
  image: "Image generation",
  video: "Video generation",
  audio: "Audio generation",
};

const MEDIA_TEST_PROMPTS: Record<MediaModality, string> = {
  image: "A single red cube on a plain gray background, product-photo style.",
  video: "A red cube slowly rotating on a plain gray background.",
  audio: "A short ascending major scale played on a piano.",
};

export interface ModelManagementRouteOptions {
  app: FastifyInstance;
  store: SqliteStore;
  routes: RouteResolver;
  adapters: EngineAdapterRegistry;
  lifecycle: LifecycleManager;
  scheduler: InferenceScheduler;
  mediaJobs: MediaJobCoordinator;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
  configuredEngineRoot: string;
  mediaImageTimeoutMs: number;
  scheduleDefaultWarm: (label: string, ownerUserId?: string) => void;
}

export function registerModelManagementRoutes(options: ModelManagementRouteOptions): void {
  const {
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
  } = options;
  const preHandler = administratorGuard;

  app.get(
    "/api/v1/management/routes",
    { preHandler },
    async () => ({ data: routes.listRoutes(true) }),
  );

  app.put(
    "/api/v1/management/engines/:folderName",
    { preHandler },
    async (request, reply) => {
      try {
        const folderName = parseFolderName((request.params as { folderName: string }).folderName);
        const body = requireRecord(request.body);
        const engineRoot = store.getSetting<string>("engineRoot") ?? configuredEngineRoot;
        const rootPath = safeEnginePath(engineRoot, folderName);
        if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
          throw new TypeError("Engine folder does not exist beneath the configured root");
        }
        const connectionMode = parseConnectionMode(body.connectionMode);
        const runtime = parseEngineRuntime(body.runtime);
        const baseUrl = connectionMode === "external" ? requireBaseUrl(body.baseUrl) : "http://127.0.0.1";
        const healthPath = requireString(body.healthPath, "healthPath");
        if (!healthPath.startsWith("/") || healthPath.startsWith("//")) {
          throw new TypeError("healthPath must be an absolute URL path");
        }
        const launchArguments = requireStringArray(body.launchArguments, "launchArguments");
        const launchCommand = typeof body.launchCommand === "string" && body.launchCommand.trim()
          ? body.launchCommand.trim()
          : undefined;
        if (connectionMode === "managed" && !launchCommand) {
          throw new TypeError("launchCommand is required for a managed engine");
        }
        const workingDirectory = typeof body.workingDirectory === "string" && body.workingDirectory.trim()
          ? validateWorkingDirectory(rootPath, body.workingDirectory.trim())
          : undefined;
        const runtimeId = runtime === "linux-managed" ? requireString(body.runtimeId, "runtimeId") : undefined;
        const now = new Date().toISOString();
        const previous = store.listEngines().find((candidate) => candidate.folderName === folderName);
        const engine: EngineRegistration = {
          id: previous?.id ?? folderName,
          folderName,
          displayName: requireString(body.displayName, "displayName"),
          connectionMode,
          runtime,
          baseUrl,
          healthPath,
          ...(launchCommand ? { launchCommand } : {}),
          launchArguments,
          ...(workingDirectory ? { workingDirectory } : {}),
          ...(runtimeId ? { runtimeId } : {}),
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
    { preHandler },
    async (request, reply) => {
      const recipeId = (request.params as { recipeId: string }).recipeId;
      try {
        const recipe = parseRecipe(request.body, recipeId);
        store.upsertRecipe(recipe);
        routes.upsertRecipe(recipe);
        ensureMediaRoutes(store, routes);
        return { data: recipe };
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/v1/management/recipes/:recipeId/test",
    { preHandler },
    async (request, reply) => {
      const recipeId = (request.params as { recipeId: string }).recipeId;
      try {
        const recipe = routes.resolveRecipe(recipeId);
        if (!recipe.capabilities.chatCompletions) {
          throw new TypeError(`Recipe ${recipeId} does not support chat completions`);
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        request.raw.once("aborted", cancel);
        const stream = scheduler.enqueueRecipe(
          recipeId,
          { messages: [{ role: "user", content: "Say hi." }], maxTokens: 1024 },
          controller.signal,
          {
            unloadAfterCompletion: true,
            context: {
              ...(principals.get(request) ? { ownerUserId: principals.get(request)!.user.id } : {}),
              label: `${recipe.displayName} test`,
            },
          },
        );
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
        if (error instanceof InferenceAdmissionError) reply.header("retry-after", "2");
        const statusCode = error instanceof RecipeNotFoundError
          ? 404
          : error instanceof InferenceAdmissionError ? 429 : 502;
        return reply.code(statusCode).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/v1/management/recipes/:recipeId/media-test",
    { preHandler },
    async (request, reply) => {
      const recipeId = (request.params as { recipeId: string }).recipeId;
      try {
        const recipe = routes.resolveRecipe(recipeId);
        const output = recipe.capabilities.modalities?.output ?? [];
        if (!output.length) throw new TypeError(`Recipe ${recipeId} does not generate media`);
        const route = resolveMediaTestRoute(routes, recipeId, output);
        if (!route) throw new TypeError(`Recipe ${recipeId} is not assigned to an enabled media route`);
        const job = await mediaJobs.submit({
          routeId: route.id,
          modality: route.kind as MediaModality,
          params: { prompt: MEDIA_TEST_PROMPTS[route.kind as MediaModality] },
        });
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
        if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
        const statusCode = error instanceof RecipeNotFoundError
          ? 404
          : error instanceof MediaCoordinatorClosedError
            ? 503
            : error instanceof MediaJobAdmissionError
              ? 429
              : error instanceof TypeError
                ? 400
                : error instanceof MediaGenerationTimeoutError ? 504 : 502;
        return reply.code(statusCode).send({ error: errorMessage(error) });
      }
    },
  );

  app.put(
    "/api/v1/management/routes/:routeId",
    { preHandler },
    async (request, reply) => {
      const routeId = (request.params as { routeId: string }).routeId;
      try {
        const route = parseRoute(request.body, routeId);
        const kind = route.kind ?? "chat";
        if (kind === "chat" && routeId !== "default") {
          throw new TypeError("Default is the only host-owned text route");
        }
        if (route.recipeId !== "") {
          const recipe = routes.listRecipes().find((item) => item.id === route.recipeId);
          if (!recipe) throw new RecipeNotFoundError(route.recipeId);
          if (kind !== "chat") {
            if (!recipe.capabilities.modalities?.output.includes(kind)) {
              throw new TypeError(`Recipe ${recipe.id} does not generate ${kind}; cannot assign it to the ${route.id} route`);
            }
          } else {
            const adapter = adapters.get(recipe.adapter);
            if (isMediaEngineAdapter(adapter) || (adapter.executionLocation?.(recipe) ?? "local") !== "local") {
              throw new TypeError("The Default route must use a local text engine");
            }
          }
        }
        store.upsertRoute(route);
        routes.upsertRoute(route);
        if (route.id === "default") {
          const recipe = routes.resolve("default").recipe;
          lifecycle.pin(recipe);
          scheduleDefaultWarm("Updated Default warm", principals.get(request)?.user.id);
        }
        return { data: route };
      } catch (error) {
        return reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );
}

export function ensureMediaRoutes(store: SqliteStore, routes: RouteResolver): void {
  for (const id of MEDIA_ROUTE_IDS) {
    if (routes.listRoutes(true).some((route) => route.id === id)) continue;
    const route: Route = {
      id,
      displayName: MEDIA_ROUTE_DISPLAY_NAMES[id],
      recipeId: "",
      enabled: false,
      kind: id,
    };
    store.upsertRoute(route);
    routes.upsertRoute(route);
  }
}

export function scanEngineFolders(engineRoot: string, engines: EngineRegistration[]): Array<Record<string, unknown>> {
  if (!existsSync(engineRoot) || !statSync(engineRoot).isDirectory()) return [];
  const byFolder = new Map(engines.map((engine) => [engine.folderName, engine]));
  return readdirSync(engineRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const engine = byFolder.get(entry.name);
      return {
        folderName: entry.name,
        rootPath: safeEnginePath(engineRoot, entry.name),
        registered: Boolean(engine),
        ...(engine ? { engine } : {}),
      };
    });
}

function parseFolderName(value: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new TypeError("folderName must name one direct child of the engine root");
  }
  return value;
}

function parseConnectionMode(value: unknown): EngineConnectionMode {
  if (value !== "managed" && value !== "external") {
    throw new TypeError("connectionMode must be managed or external");
  }
  return value;
}

function parseEngineRuntime(value: unknown): EngineRuntime {
  if (value !== "linux-managed") throw new TypeError("runtime must be linux-managed");
  return value;
}

function requireBaseUrl(value: unknown): string {
  const baseUrl = requireString(value, "baseUrl");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("baseUrl must use http or https");
  if (url.username || url.password) throw new TypeError("baseUrl must not contain credentials");
  return url.toString().replace(/\/$/, "");
}

function safeEnginePath(engineRoot: string, folderName: string): string {
  const root = resolve(engineRoot);
  const target = resolve(root, folderName);
  const child = relative(root, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new TypeError("Engine folder must be inside the configured engine root");
  }
  return target;
}

function validateWorkingDirectory(engineRoot: string, workingDirectory: string): string {
  const root = resolve(engineRoot);
  const target = resolve(root, workingDirectory);
  const child = relative(root, target);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new TypeError("workingDirectory must stay inside the engine folder");
  }
  return child || ".";
}

function parseRoute(value: unknown, routeId: string): Route {
  if (!isRecord(value)) throw new TypeError("Route body must be an object");
  if (typeof value.displayName !== "string" || value.displayName.length === 0) {
    throw new TypeError("displayName must be a non-empty string");
  }
  if (typeof value.recipeId !== "string") throw new TypeError("recipeId must be a string");
  const kind = parseRouteKind(value.kind, routeId);
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
  if (value === undefined) {
    return (MEDIA_ROUTE_IDS as readonly string[]).includes(routeId) ? routeId as RouteKind : undefined;
  }
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
  if (loadPolicy !== "onDemand" && loadPolicy !== "manual") {
    throw new TypeError("lifecycle.loadPolicy is invalid");
  }
  const evictionPolicy = lifecycle.evictionPolicy;
  if (evictionPolicy !== "immediate" && evictionPolicy !== "idle-ttl" && evictionPolicy !== "never" && evictionPolicy !== "manual") {
    throw new TypeError("lifecycle.evictionPolicy is invalid");
  }
  return {
    id: recipeId,
    playbookId: requireString(body.playbookId, "playbookId"),
    displayName: requireString(body.displayName, "displayName"),
    adapter: requireString(body.adapter, "adapter"),
    modelId: requireString(body.modelId, "modelId"),
    contextTokens: requireInteger(body.contextTokens),
    capabilities: {
      chatCompletions: booleanCapability("chatCompletions"),
      streaming: booleanCapability("streaming"),
      toolCalls: booleanCapability("toolCalls"),
      responseFormat: booleanCapability("responseFormat"),
      minP: booleanCapability("minP"),
      maxConcurrentGenerations: requireInteger(capabilities.maxConcurrentGenerations),
      ...(isRecord(capabilities.modalities) ? { modalities: parseModalities(capabilities.modalities) } : {}),
    },
    lifecycle: {
      loadPolicy,
      evictionPolicy,
      idleTtlSeconds: nonNegativeInteger(lifecycle.idleTtlSeconds, "lifecycle.idleTtlSeconds"),
      minimumResidencySeconds: nonNegativeInteger(lifecycle.minimumResidencySeconds, "lifecycle.minimumResidencySeconds"),
    },
    configuration,
  };
}

function resolveMediaTestRoute(routes: RouteResolver, recipeId: string, output: MediaModality[]): Route | undefined {
  const candidates = routes.listRoutes(true).filter(
    (route) => route.enabled
      && route.recipeId === recipeId
      && route.kind !== "chat"
      && output.includes(route.kind as MediaModality),
  );
  return candidates.find((route) => (MEDIA_ROUTE_IDS as readonly string[]).includes(route.id)) ?? candidates[0];
}

function parseModalities(value: Record<string, unknown>): ModalityCapabilities {
  const input = value.input;
  const output = value.output;
  if (!Array.isArray(input) || !input.every((item) => item === "text" || item === "image" || item === "video" || item === "audio")) {
    throw new TypeError("capabilities.modalities.input is invalid");
  }
  if (!Array.isArray(output) || !output.every((item) => item === "image" || item === "video" || item === "audio")) {
    throw new TypeError("capabilities.modalities.output is invalid");
  }
  const limits = isRecord(value.limits)
    ? {
        ...(typeof value.limits.maxDurationSeconds === "number" ? { maxDurationSeconds: value.limits.maxDurationSeconds } : {}),
        ...(typeof value.limits.maxFps === "number" ? { maxFps: value.limits.maxFps } : {}),
        ...(typeof value.limits.maxResolution === "string" ? { maxResolution: value.limits.maxResolution } : {}),
        ...(typeof value.limits.maxRefs === "number" ? { maxRefs: value.limits.maxRefs } : {}),
        ...(typeof value.limits.maxFrames === "number" ? { maxFrames: value.limits.maxFrames } : {}),
      }
    : undefined;
  return { input: input as ModalityInput[], output: output as MediaModality[], ...(limits ? { limits } : {}) };
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

function requireInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError("Quota values must be positive integers");
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value as number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
