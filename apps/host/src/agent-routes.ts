import type { FastifyInstance } from "fastify";
import { RouteNotFoundError, type InferenceScheduler } from "@fitz/inference-core";
import { parseChatCompletionRequest, PROTOCOL_VERSION, type AgentRunCheckpoint, type AgentRunRequest } from "@fitz/protocol";
import { SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import type { ContextManager } from "@fitz/context";
import { AgentCoordinatorClosedError, AgentQueueCapacityError, type AgentRunCoordinator } from "./agent-runs.js";

export interface RegisterAgentRoutesOptions {
  app: FastifyInstance;
  store: SqliteStore;
  agentRuns: AgentRunCoordinator;
  scheduler: InferenceScheduler;
  context: ContextManager;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  security?: SecurityService;
  contextTokensForRoute(routeId: string): number;
}

/** Owns durable agent-run creation, queue visibility, steering, cancellation,
 * replay, and live SSE delivery. */
export function registerAgentRoutes(options: RegisterAgentRoutesOptions): void {
  const { app, store, agentRuns, scheduler, context, principals, security, contextTokensForRoute } = options;

  app.post("/api/v1/agent/runs", async (request, reply) => {
    try {
      const body = parseAgentRunRequest(request.body);
      const principal = principals.get(request);
      const existing = body.clientRequestId ? store.agentRunForClientRequest(body.clientRequestId) : undefined;
      if (existing) {
        if (!canAccessOwner(principal, existing.ownerUserId)) return reply.code(409).send({ error: "Request identity is already in use" });
        return reply.code(200).send({ protocolVersion: PROTOCOL_VERSION, data: existing, idempotentReplay: true });
      }
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
        security?.enforceQuota(principal, promptChars, body.maxTokens ?? principal.quota.maxOutputTokens, agentRuns.queue(principal.user.id).length);
      }
      const executionRouteId = body.model;
      const durableRequest = { ...body, model: executionRouteId };
      const prepared = await context.prepare(durableRequest, contextTokensForRoute(executionRouteId));
      let run;
      try { run = agentRuns.start(prepared.request, principal?.user.id, body.messages, durableRequest); }
      catch (error) {
        const concurrent = body.clientRequestId ? store.agentRunForClientRequest(body.clientRequestId) : undefined;
        if (concurrent && canAccessOwner(principal, concurrent.ownerUserId)) return reply.code(200).send({ protocolVersion: PROTOCOL_VERSION, data: concurrent, idempotentReplay: true });
        throw error;
      }
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
      if (error instanceof AgentQueueCapacityError) reply.header("retry-after", "2");
      return reply.code(error instanceof AgentCoordinatorClosedError ? 503 : error instanceof SecurityPolicyError || error instanceof AgentQueueCapacityError ? 429 : error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) });
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

  app.get("/api/v1/work/queue", async (request) => {
    const principal = principals.get(request);
    const administrator = principal?.user.role === "administrator";
    const ownerUserId = administrator ? undefined : principal?.user.id;
    const tasks = agentRuns.queue(ownerUserId).map((item) => ({ id: item.runId, kind: "agent" as const, lane: "gpu" as const, routeId: item.routeId, status: item.status, position: item.position, depth: item.depth, enqueuedAt: item.createdAt, ...(item.ownerUserId ? { ownerUserId: item.ownerUserId } : {}), ...(item.sessionId ? { sessionId: item.sessionId } : {}), ...(item.sessionTitle ? { label: item.sessionTitle } : {}), ...(item.projectName ? { projectName: item.projectName } : {}) }));
      const inference = scheduler.snapshot()
        .filter((item) => !item.context.runId)
        .filter((item) => administrator || !item.context.ownerUserId || item.context.ownerUserId === ownerUserId)
        .map((item) => ({ id: item.id, kind: item.kind, lane: item.lane, routeId: item.routeId, status: item.status, position: item.position, enqueuedAt: item.enqueuedAt, ...item.context }));
    return {
      protocolVersion: PROTOCOL_VERSION,
      data: [...tasks, ...inference],
    };
  });

  app.delete("/api/v1/work/queue/:workId", async (request, reply) => {
    const workId = (request.params as { workId: string }).workId;
    const principal = principals.get(request);
    const run = agentRuns.get(workId);
    if (run && !canAccessOwner(principal, run.ownerUserId)) return reply.code(403).send({ error: "Queue item access denied" });
    const scheduled = scheduler.snapshot().find((item) => item.id === workId);
    if (scheduled?.context.ownerUserId && !canAccessOwner(principal, scheduled.context.ownerUserId)) return reply.code(403).send({ error: "Queue item access denied" });
    const cancelled = run ? agentRuns.cancel(workId) : scheduler.cancel(workId);
    if (!cancelled) return reply.code(404).send({ error: "Queue item not found" });
    return reply.code(204).send();
  });

  app.get("/api/v1/sessions/:sessionId/agent-run-state", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const session = store.getSession(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccessOwner(principals.get(request), session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
    return { protocolVersion: PROTOCOL_VERSION, data: agentRuns.getSessionRecovery(sessionId) ?? null };
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

  app.post("/api/v1/agent/runs/:runId/resume", async (request, reply) => {
    const sourceRunId = (request.params as { runId: string }).runId;
    const source = agentRuns.get(sourceRunId);
    if (!source) return reply.code(404).send({ error: "Run not found" });
    const principal = principals.get(request);
    if (!canAccessOwner(principal, source.ownerUserId)) return reply.code(403).send({ error: "Run access denied" });
    const existingResume = store.agentRunResumedFrom(sourceRunId);
    if (existingResume) return reply.code(200).send({ protocolVersion: PROTOCOL_VERSION, data: existingResume, resumedFrom: sourceRunId, idempotentReplay: true });
    if (!source.resumable || !source.checkpoint || !source.sessionId) return reply.code(409).send({ error: "Run is not resumable" });
    const confirmUnsafe = requireRecord(request.body ?? {}).confirmUnsafe === true;
    if (source.checkpoint.resumeSafety === "review-required" && !confirmUnsafe) return reply.code(409).send({ error: "The interrupted run had an unfinished tool or approval. Review is required before continuing.", requiresConfirmation: true, checkpoint: source.checkpoint });
    const durable = store.getAgentRunRequest(sourceRunId);
    if (!durable) return reply.code(409).send({ error: "The original run predates durable continuation support" });
    const recoveryInstruction = buildRecoveryInstruction(sourceRunId, source.checkpoint);
    const { clientRequestId: _sourceRequestId, ...resumeBase } = durable;
    const resumeRequest: AgentRunRequest = { ...resumeBase, sessionId: source.sessionId, messages: [{ role: "system", content: recoveryInstruction }] };
    try {
      if (principal && !security?.authorizeRoute(principal, resumeRequest.model)) return reply.code(403).send({ error: "Route access denied" });
      if (principal) security?.enforceQuota(principal, recoveryInstruction.length, resumeRequest.maxTokens ?? principal.quota.maxOutputTokens, agentRuns.queue(principal.user.id).length);
      const prepared = await context.prepare(resumeRequest, contextTokensForRoute(resumeRequest.model));
      if (!store.claimAgentRunResume(sourceRunId)) {
        const concurrentResume = store.agentRunResumedFrom(sourceRunId);
        if (concurrentResume) return reply.code(200).send({ protocolVersion: PROTOCOL_VERSION, data: concurrentResume, resumedFrom: sourceRunId, idempotentReplay: true });
        return reply.code(409).send({ error: "This run is already being resumed" });
      }
      try {
        const run = agentRuns.start(prepared.request, principal?.user.id ?? source.ownerUserId, [], resumeRequest, sourceRunId);
        security?.audit("agent-run.resumed", principal?.user.id, "agent-run", run.id, { sourceRunId, resumeSafety: source.checkpoint.resumeSafety });
        return reply.code(202).send({ protocolVersion: PROTOCOL_VERSION, data: run, resumedFrom: sourceRunId, checkpoint: source.checkpoint });
      } catch (error) { store.setAgentRunResumable(sourceRunId, true); throw error; }
    } catch (error) {
      if (error instanceof AgentQueueCapacityError) reply.header("retry-after", "2");
      return reply.code(error instanceof AgentCoordinatorClosedError ? 503 : error instanceof SecurityPolicyError || error instanceof AgentQueueCapacityError ? 429 : error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) });
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

function buildRecoveryInstruction(sourceRunId: string, checkpoint: AgentRunCheckpoint): string {
  const completed = checkpoint.completedTools.map((tool) => `- ${tool.toolName} (${tool.toolCallId})${tool.isError ? " failed" : " completed"}`).join("\n") || "- none";
  const inFlight = checkpoint.inFlightTools.map((tool) => `- ${tool.toolName} (${tool.toolCallId})`).join("\n") || "- none";
  return `Continue the interrupted Fitz task from durable checkpoint ${sourceRunId}:${checkpoint.sequence}.\n\nCompleted tool calls:\n${completed}\n\nTool calls that were in flight when execution stopped:\n${inFlight}\n\nRecovery rules:\n1. Inspect the current workspace/state before acting.\n2. Treat completed tool calls as already applied; do not blindly repeat mutations.\n3. Treat in-flight tool calls as having an unknown outcome; verify their effects before retrying.\n4. Continue toward the user's original goal and report the recovered result normally.`;
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
    ...(typeof source.clientRequestId === "string" && source.clientRequestId.trim() ? { clientRequestId: validateClientRequestId(source.clientRequestId) } : {}),
  };
}

function validateClientRequestId(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new TypeError("clientRequestId is invalid");
  return normalized;
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
