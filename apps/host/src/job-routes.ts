import type { FastifyInstance } from "fastify";
import { isJobKind, isJobStatus, PROTOCOL_VERSION, type JobKind, type JobRecord, type JobStatus } from "@fitz/protocol";
import type { AuthenticatedPrincipal } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";

export interface RegisterJobRoutesOptions {
  app: FastifyInstance;
  store: SqliteStore;
  principals: WeakMap<object, AuthenticatedPrincipal>;
}

/** Read-only control-plane view over every durable background job. Source
 * endpoints remain responsible for admission/cancellation; this endpoint is a
 * stable place for dashboards, diagnostics, and future maintenance workers to
 * discover work without branching on the execution engine. */
export function registerJobRoutes(options: RegisterJobRoutesOptions): void {
  const { app, store, principals } = options;

  app.get("/api/v1/jobs", async (request) => {
    const principal = principals.get(request);
    const query = request.query as { ownerUserId?: string; sessionId?: string; kind?: string; status?: string; limit?: string };
    const kind = parseKind(query.kind);
    const status = parseStatus(query.status);
    const administrator = principal?.user.role === "administrator";
    return {
      protocolVersion: PROTOCOL_VERSION,
      data: store.listJobs({
        ...(!administrator && principal ? { ownerUserId: principal.user.id } : {}),
        ...(administrator && query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        limit: Math.min(toNonNegativeInteger(query.limit, 100), 1000),
      }),
    };
  });

  app.get("/api/v1/jobs/:jobId", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = store.getJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (!canAccessJob(principals.get(request), job)) return reply.code(403).send({ error: "Job access denied" });
    return { protocolVersion: PROTOCOL_VERSION, data: job };
  });

  app.get("/api/v1/jobs/:jobId/events", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = store.getJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (!canAccessJob(principals.get(request), job)) return reply.code(403).send({ error: "Job access denied" });
    const query = request.query as { after?: string; limit?: string };
    const headerAfter = request.headers["last-event-id"];
    const after = toNonNegativeInteger(query.after ?? (typeof headerAfter === "string" ? headerAfter : undefined), 0);
    const events = store.jobEventsAfter(jobId, after, Math.min(toNonNegativeInteger(query.limit, 1000), 1000));
    return {
      protocolVersion: PROTOCOL_VERSION,
      data: events,
      ...(events.length > 0 ? { nextSequence: events.at(-1)!.sequence } : { nextSequence: after }),
    };
  });
}

function canAccessJob(principal: AuthenticatedPrincipal | undefined, job: JobRecord): boolean {
  return !principal || principal.user.role === "administrator" || principal.user.id === job.ownerUserId;
}

function parseKind(value: string | undefined): JobKind | undefined {
  return value && isJobKind(value) ? value : undefined;
}

function parseStatus(value: string | undefined): JobStatus | undefined {
  return value && isJobStatus(value) ? value : undefined;
}

function toNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
