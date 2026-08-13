import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { AgentSafetyService } from "./agent-safety/index.js";

export interface SafetyAdministrationRouteOptions {
  app: FastifyInstance;
  safety?: AgentSafetyService;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
}

/** Registers snapshot, trash, and recorded tool-action recovery surfaces. */
export function registerSafetyAdministrationRoutes(options: SafetyAdministrationRouteOptions): void {
  const { app, safety, security, principals, administratorGuard: preHandler } = options;

  app.get("/api/v1/management/snapshots", { preHandler }, async (_request, reply) => {
    try { return { data: requiredSafety(safety).listSnapshots() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/snapshots/:runId/restore", { preHandler }, async (request, reply) => {
    try {
      const runId = (request.params as { runId: string }).runId;
      const result = await requiredSafety(safety).restoreSnapshot(runId);
      security?.audit("snapshot.restored", principals.get(request)?.user.id, "snapshot", runId);
      return { data: result };
    } catch (error) { return reply.code(error instanceof Error && error.message === "Snapshot not found" ? 404 : 400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/trash", { preHandler }, async (_request, reply) => {
    try { return { data: requiredSafety(safety).listTrash() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/trash/:id/restore", { preHandler }, async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      const entry = await requiredSafety(safety).restoreTrash(id);
      security?.audit("trash.restored", principals.get(request)?.user.id, "trash", id);
      return { data: entry };
    } catch (error) { return reply.code(error instanceof Error && error.message === "Trash entry not found" ? 404 : 400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/trash", { preHandler }, async (request, reply) => {
    try {
      const query = request.query as { workspaceRoot?: string };
      const workspaceRoot = typeof query.workspaceRoot === "string" && query.workspaceRoot ? query.workspaceRoot : undefined;
      const result = await requiredSafety(safety).emptyTrash(workspaceRoot);
      security?.audit("trash.emptied", principals.get(request)?.user.id, "trash", undefined, { removed: result.removed, ...(workspaceRoot ? { workspaceRoot } : {}) });
      return { data: result };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/trash/gc", { preHandler }, async (request, reply) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const maxAgeDays = typeof body.maxAgeDays === "number" && Number.isFinite(body.maxAgeDays) && body.maxAgeDays > 0 ? body.maxAgeDays : 30;
      const result = await requiredSafety(safety).collect(maxAgeDays * 24 * 60 * 60 * 1_000);
      security?.audit("safety.gc", principals.get(request)?.user.id, "safety", undefined, { maxAgeDays, ...result });
      return { data: result };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/tool-actions", { preHandler }, async (request, reply) => {
    try {
      const query = request.query as { limit?: string };
      return { data: requiredSafety(safety).listToolActions(Math.min(toNonNegativeInteger(query.limit, 200), 1_000)) };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
}

function requiredSafety(value: AgentSafetyService | undefined): AgentSafetyService { if (!value) throw new Error("Safety layer is unavailable"); return value; }
function toNonNegativeInteger(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const number = Number.parseInt(value, 10); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
