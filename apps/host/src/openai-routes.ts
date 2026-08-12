import type { FastifyInstance } from "fastify";
import {
  InferenceAdmissionError,
  type InferenceScheduler,
  type ResolvedRoute,
  RouteNotFoundError,
} from "@fitz/inference-core";
import {
  parseChatCompletionRequest,
  type InferenceDelta,
  type ModelListResponse,
  type OpenAIErrorResponse,
} from "@fitz/protocol";
import { SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import { writeSse, writeSseDone } from "./stream-response.js";
import { LOCAL_OWNER_ID, type UserRouteResolver } from "./user-route-resolver.js";

interface InternalWorkContext {
  runId?: string;
  ownerUserId?: string;
  sessionId?: string;
  forcedToolName?: string;
}

export interface OpenAIRouteOptions {
  app: FastifyInstance;
  scheduler: InferenceScheduler;
  userRoutes: UserRouteResolver;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  internalWorkContexts: WeakMap<object, InternalWorkContext>;
  security?: SecurityService;
}

/** Owns Fitz's public OpenAI-compatible model and completion transport. */
export function registerOpenAIRoutes(options: OpenAIRouteOptions): void {
  const { app, scheduler, userRoutes, principals, internalWorkContexts, security } = options;

  app.get("/v1/models", async (request): Promise<ModelListResponse> => ({
    object: "list",
    data: userRoutes.publicRoutes(principals.get(request)?.user.id ?? LOCAL_OWNER_ID).filter((route) => {
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
    let resolved: ResolvedRoute;
    try {
      body = parseChatCompletionRequest(request.body);
      model = body.model;
      const principal = principals.get(request);
      const internalContext = internalWorkContexts.get(request);
      const ownerUserId = principal?.user.id ?? internalContext?.ownerUserId ?? LOCAL_OWNER_ID;
      resolved = userRoutes.resolve(model, ownerUserId, Boolean(internalContext));
      if (principal && !security?.authorizeRoute(principal, model)) {
        return reply.code(403).send(openAIError(new SecurityPolicyError("Route access denied"), "permission_error"));
      }
      if (principal) {
        const promptChars = body.messages.reduce((total, message) => total + contentTextLength(message.content), 0);
        security?.enforceQuota(principal, promptChars, body.max_tokens ?? principal.quota.maxOutputTokens, scheduler.snapshot().filter((item) => item.context.ownerUserId === principal.user.id).length);
      }
      if (!resolved.recipe.capabilities.chatCompletions) throw new TypeError(`Route ${model} does not support chat completions`);
      if (body.stream !== false && !resolved.recipe.capabilities.streaming) throw new TypeError(`Route ${model} does not support streaming`);
      if (body.tools?.length && !resolved.recipe.capabilities.toolCalls) throw new TypeError(`Route ${model} does not support tool calls`);
      const forcedToolName = internalWorkContexts.get(request)?.forcedToolName;
      if (forcedToolName && !body.tools?.some((tool) => tool.function.name === forcedToolName)) throw new TypeError(`Forced tool ${forcedToolName} is unavailable`);
    } catch (error) {
      const statusCode = error instanceof RouteNotFoundError ? 404 : error instanceof SecurityPolicyError ? 429 : 400;
      return reply.code(statusCode).send(openAIError(error, "invalid_request_error"));
    }

    const principal = principals.get(request);
    const internalContext = internalWorkContexts.get(request);
    let stream: ReturnType<InferenceScheduler["enqueueResolved"]>;
    try {
      stream = scheduler.enqueueResolved(model, resolved.recipe.id, {
        messages: body.messages,
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
        ...(body.stop !== undefined ? { stop: body.stop } : {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
        // Media-command runs no longer force a specific function tool_choice here:
        // thinking-mode providers reject forced tool_choice with a 400. Determinism
        // is handled by the agent runtime instead — the run exposes only the
        // generate_<modality> tool (activeTools allowlist) and the prompt is
        // rewritten into an explicit tool-call instruction.
        ...(body.tool_choice !== undefined ? { toolChoice: body.tool_choice } : {}),
        ...(body.parallel_tool_calls !== undefined ? { parallelToolCalls: body.parallel_tool_calls } : {}),
        ...(principal ? { userId: principal.user.id } : internalContext?.ownerUserId ? { userId: internalContext.ownerUserId } : body.user !== undefined ? { userId: body.user } : {}),
      }, undefined, { ...(principal ? { ownerUserId: principal.user.id } : {}), ...internalContext, label: `${model} completion` });
    } catch (error) {
      if (error instanceof InferenceAdmissionError) reply.header("retry-after", "2");
      return reply.code(error instanceof InferenceAdmissionError ? 429 : 502).send(openAIError(error, error instanceof InferenceAdmissionError ? "resource_busy" : "server_error"));
    }

    if (body.stream === false) {
      try {
        return await collectCompletion(stream.requestId, model, stream);
      } catch (error) {
        return reply.code(error instanceof RouteNotFoundError ? 404 : 502).send(openAIError(error, "server_error"));
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
    const responseController = new AbortController();
    const abort = () => {
      if (responseController.signal.aborted) return;
      responseController.abort();
      stream.cancel();
    };
    const onClose = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.once("aborted", abort);
    reply.raw.once("close", onClose);

    try {
      await writeSse(reply.raw, streamChunk(completionId, created, model, { role: "assistant" }, null), responseController.signal);
      for await (const delta of stream) {
        await writeSse(reply.raw, streamChunk(completionId, created, model, {
          ...(delta.text ? { content: delta.text } : {}),
          ...(delta.toolCalls?.length ? { tool_calls: delta.toolCalls } : {}),
        }, delta.finishReason ?? null), responseController.signal);
      }
      await writeSseDone(reply.raw, responseController.signal);
    } catch (error) {
      if (!responseController.signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
        await writeSse(reply.raw, openAIError(error, "server_error")).catch(() => undefined);
        await writeSseDone(reply.raw).catch(() => undefined);
      }
    } finally {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", onClose);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });
}

async function collectCompletion(requestId: string, model: string, stream: AsyncIterable<InferenceDelta>): Promise<Record<string, unknown>> {
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
    choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) }, finish_reason: finishReason }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

function streamChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

function openAIError(error: unknown, type: string): OpenAIErrorResponse {
  return { error: { message: error instanceof Error ? error.message : String(error), type } };
}

function contentTextLength(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, part) => total + (part.type === "text" ? (part.text ?? "").length : 0), 0);
}
