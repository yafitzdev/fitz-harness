import type { FastifyInstance } from "fastify";
import { RouteNotFoundError } from "@fitz/inference-core";
import { parseChatCompletionRequest, PROTOCOL_VERSION, type AgentRunRequest } from "@fitz/protocol";
import { SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import type { ContextManager } from "@fitz/context";
import type { AgentRunCoordinator } from "./agent-runs.js";

export interface RegisterAgentRoutesOptions {
  app: FastifyInstance;
  store: SqliteStore;
  agentRuns: AgentRunCoordinator;
  context: ContextManager;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  security?: SecurityService;
  normalizeRouteId(routeId: string): string;
  contextTokensForRoute(routeId: string): number;
}

/** Owns durable agent-run creation, queue visibility, steering, cancellation,
 * replay, and live SSE delivery. */
export function registerAgentRoutes(options: RegisterAgentRoutesOptions): void {
  const { app, store, agentRuns, context, principals, security, normalizeRouteId, contextTokensForRoute } = options;

  app.post("/api/v1/agent/runs", async (request, reply) => {
    try {
      const body = parseAgentRunRequest(request.body);
      const principal = principals.get(request);
      const session = body.sessionId ? store.getSession(body.sessionId) : undefined;
      if (body.sessionId) {
        if (!session) return reply.code(404).send({ error: "Session not found" });
        if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
      }
      if (principal && !security?.authorizeRoute(principal, body.model)) {
        return reply.code(403).send({ error: "Route access denied" });
      }
      if (principal) {
        const promptChars = body.messages.reduce((total, message) => total + contentTextLength(message.content), 0);
        security?.enforceQuota(principal, promptChars, body.maxTokens ?? principal.quota.maxOutputTokens, agentRuns.queue().length);
      }
      const executionRouteId = normalizeRouteId(body.model);
      const prepared = await context.prepare({ ...body, model: executionRouteId }, contextTokensForRoute(executionRouteId));
      const run = agentRuns.start(prepared.request, principal?.user.id, body.messages);
      security?.audit("agent-run.created", principal?.user.id, "agent-run", run.id, {
        routeId: run.routeId,
        connectionId: session?.connectionId,
        publicRouteId: body.model,
        compacted: prepared.compacted,
      });
      return reply.code(202).send({
        protocolVersion: PROTOCOL_VERSION,
        data: run,
        queue: agentRuns.queue(principal?.user.role === "administrator" ? undefined : principal?.user.id).find((item) => item.runId === run.id),
        context: {
          compacted: prepared.compacted,
          estimatedInputTokens: prepared.estimatedInputTokens,
          budgetTokens: prepared.budgetTokens,
          estimatedContextTokens: prepared.estimatedContextTokens,
        },
      });
    } catch (error) {
      return reply.code(error instanceof SecurityPolicyError ? 429 : error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/agent/runs", async (request) => {
    const principal = principals.get(request);
    const query = request.query as { limit?: string };
    return {
      protocolVersion: PROTOCOL_VERSION,
      data: agentRuns.list(
        principal?.user.role === "administrator" ? undefined : principal?.user.id,
        Math.min(toNonNegativeInteger(query.limit, 100), 1000),
      ),
    };
  });

  app.get("/api/v1/agent/queue", async (request) => {
    const principal = principals.get(request);
    return {
      protocolVersion: PROTOCOL_VERSION,
      data: agentRuns.queue(principal?.user.role === "administrator" ? undefined : principal?.user.id),
    };
  });

  app.get("/api/v1/agent/runs/:runId", async (request, reply) => {
    const run = agentRuns.get((request.params as { runId: string }).runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!canAccessOwner(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
    return { protocolVersion: PROTOCOL_VERSION, data: run };
  });

  app.delete("/api/v1/agent/runs/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = agentRuns.get(runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!canAccessOwner(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
    if (!agentRuns.cancel(runId)) return reply.code(409).send({ error: "Run is no longer active" });
    return reply.code(202).send({ data: { id: runId, cancellationRequested: true } });
  });

  app.post("/api/v1/agent/runs/:runId/steer", async (request, reply) => {
    try {
      const runId = (request.params as { runId: string }).runId;
      const run = agentRuns.get(runId);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (!canAccessOwner(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
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
    const runId = (request.params as { runId: string }).runId;
    const run = agentRuns.get(runId);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!canAccessOwner(principals.get(request), run.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
    const query = request.query as { after?: string; stream?: string };
    const headerAfter = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined;
    const after = toNonNegativeInteger(query.after ?? headerAfter, 0);
    if (query.stream !== "true" && !String(request.headers.accept ?? "").includes("text/event-stream")) {
      return { protocolVersion: PROTOCOL_VERSION, run: agentRuns.get(runId), events: agentRuns.eventsAfter(runId, after) };
    }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    let last = after;
    const send = (event: { sequence: number; type: string }) => {
      if (event.sequence <= last) return;
      last = event.sequence;
      reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = agentRuns.subscribe(runId, (event) => {
      send(event);
      if (isTerminalAgentEvent(event.type)) {
        unsubscribe();
        reply.raw.end();
      }
    });
    for (const event of agentRuns.eventsAfter(runId, after)) send(event);
    if (isTerminalRun(agentRuns.get(runId)?.status)) {
      unsubscribe();
      reply.raw.end();
    } else {
      request.raw.once("aborted", unsubscribe);
    }
  });
}

function parseAgentRunRequest(value: unknown): AgentRunRequest {
  const parsed = parseChatCompletionRequest(value);
  const source = requireRecord(value);
  const accessMode = source.accessMode === "ask" || source.accessMode === "read-only" ? source.accessMode : "full";
  return {
    model: parsed.model,
    messages: parsed.messages,
    ...(parsed.max_tokens !== undefined ? { maxTokens: parsed.max_tokens } : {}),
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(typeof source.sessionId === "string" ? { sessionId: source.sessionId } : {}),
    accessMode,
  };
}

function contentTextLength(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, part) => total + (part.type === "text" ? (part.text ?? "").length : 0), 0);
}

function canAccessOwner(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean {
  return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId;
}

function isTerminalRun(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function isTerminalAgentEvent(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled" || type === "run.interrupted";
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Request body must be an object");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function toNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
