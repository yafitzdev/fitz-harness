import type { FastifyInstance, FastifyRequest } from "fastify";
import { RouteNotFoundError } from "@fitz/inference-core";
import {
  isActiveMediaJobStatus,
  isTerminalMediaJobStatus,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
  type MediaGenerationParams,
  type MediaJobRecord,
  type MediaJobStatus,
  type MediaModality,
  type OpenAIErrorResponse,
  type VideoGenerationRequest,
  type VideoGenerationResponse,
} from "@fitz/protocol";
import { SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import type { ArtifactRepository, MediaJobEventEnvelope, SqliteStore } from "@fitz/storage";
import { MediaCoordinatorClosedError, MediaJobAdmissionError, MediaJobCoordinator } from "./media-jobs.js";

export interface RegisterMediaRoutesOptions {
  app: FastifyInstance;
  store: SqliteStore;
  mediaJobs: MediaJobCoordinator;
  artifacts: ArtifactRepository;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  security?: SecurityService;
  imageTimeoutMs: number;
}

/** Owns the durable media-job API and the OpenAI-shaped media gateways. */
export function registerMediaRoutes(options: RegisterMediaRoutesOptions): void {
  const { app, store, artifacts, mediaJobs, principals, security, imageTimeoutMs } = options;

  app.post("/api/v1/media/jobs", async (request, reply) => {
    let clientRequestId: string | undefined;
    let principal: AuthenticatedPrincipal | undefined;
    try {
      const body = requireRecord(request.body);
      const routeId = typeof body.routeId === "string" ? body.routeId : typeof body.model === "string" ? body.model : undefined;
      if (!routeId) throw new TypeError("routeId is required");
      const modality = parseModality(body.modality);
      principal = principals.get(request);
      clientRequestId = body.clientRequestId === undefined ? undefined : validateClientRequestId(body.clientRequestId);
      const existing = clientRequestId ? store.mediaJobForClientRequest(clientRequestId) : undefined;
      if (existing) {
        if (!canAccessMediaJob(principal, existing)) return reply.code(409).send({ error: "Request identity is already in use" });
        return reply.code(200).send({ data: existing, idempotentReplay: true });
      }
      const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : undefined;
      if (sessionId) {
        const session = store.getSession(sessionId);
        if (!session) return reply.code(404).send({ error: "Session not found" });
        if (principal && principal.user.role !== "administrator" && session.ownerUserId !== principal.user.id) {
          return reply.code(403).send({ error: "Session access denied" });
        }
      }
      const job = await mediaJobs.submit({
        routeId,
        modality,
        params: parseMediaParams(body.params),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(sessionId ? { sessionId } : {}),
      }, principal);
      security?.audit("media-job.created", principal?.user.id, "media-job", job.id, { routeId, modality, status: job.status });
      return reply.code(202).send({ data: job });
    } catch (error) {
      const concurrent = clientRequestId ? store.mediaJobForClientRequest(clientRequestId) : undefined;
      if (concurrent) {
        if (!canAccessMediaJob(principal, concurrent)) return reply.code(409).send({ error: "Request identity is already in use" });
        return reply.code(200).send({ data: concurrent, idempotentReplay: true });
      }
      const statusCode = mediaSubmissionStatus(error);
      if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
      return reply.code(statusCode).send({ error: errorMessage(error), ...(error instanceof MediaJobAdmissionError ? { data: { jobId: error.jobId } } : {}) });
    }
  });

  app.get("/api/v1/media/jobs", async (request) => {
    const principal = principals.get(request);
    const query = request.query as { sessionId?: string; status?: string; limit?: string; includeLineage?: string };
    const status = parseMediaStatus(query.status);
    const list = query.includeLineage === "true" ? mediaJobs.listWithLineage.bind(mediaJobs) : mediaJobs.list.bind(mediaJobs);
    return {
      data: list({
        ...(principal === undefined || principal.user.role === "administrator" ? {} : { ownerUserId: principal.user.id }),
        ...(typeof query.sessionId === "string" && query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(status ? { status } : {}),
        limit: Math.min(toNonNegativeInteger(query.limit, 100), 1000),
      }),
    };
  });

  app.get("/api/v1/media/jobs/:jobId", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    if (!canAccessMediaJob(principals.get(request), job)) return reply.code(403).send({ error: "Media job access denied" });
    return { data: job };
  });

  app.get("/api/v1/media/jobs/:jobId/lineage", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    const principal = principals.get(request);
    if (!canAccessMediaJob(principal, job)) return reply.code(403).send({ error: "Media job access denied" });
    return { data: mediaJobs.lineage(jobId).filter((entry) => canAccessMediaJob(principal, entry)) };
  });

  app.post("/api/v1/media/jobs/:jobId/edits", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const source = mediaJobs.get(jobId);
    if (!source) return reply.code(404).send({ error: "Media job not found" });
    const principal = principals.get(request);
    if (!canAccessMediaJob(principal, source)) return reply.code(403).send({ error: "Media job access denied" });
    try {
      const body = requireRecord(request.body);
      const edited = await mediaJobs.submitEdit(source, requireString(body.prompt, "prompt"), principal);
      security?.audit("media-job.edited", principal?.user.id, "media-job", edited.id, { sourceJobId: source.id, routeId: edited.routeId });
      return reply.code(202).send({ data: edited });
    } catch (error) {
      const statusCode = mediaSubmissionStatus(error);
      if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
      return reply.code(statusCode).send({ error: errorMessage(error), ...(error instanceof MediaJobAdmissionError ? { data: { jobId: error.jobId } } : {}) });
    }
  });

  app.post("/api/v1/media/jobs/:jobId/animations", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const source = mediaJobs.get(jobId);
    if (!source) return reply.code(404).send({ error: "Media job not found" });
    const principal = principals.get(request);
    if (!canAccessMediaJob(principal, source)) return reply.code(403).send({ error: "Media job access denied" });
    try {
      const body = requireRecord(request.body);
      const animated = await mediaJobs.submitAnimation(source, requireString(body.prompt, "prompt"), principal);
      security?.audit("media-job.animated", principal?.user.id, "media-job", animated.id, { sourceJobId: source.id, routeId: animated.routeId });
      return reply.code(202).send({ data: animated });
    } catch (error) {
      const statusCode = mediaSubmissionStatus(error);
      if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
      return reply.code(statusCode).send({ error: errorMessage(error), ...(error instanceof MediaJobAdmissionError ? { data: { jobId: error.jobId } } : {}) });
    }
  });

  app.post("/api/v1/media/jobs/:jobId/cancel", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    if (!canAccessMediaJob(principals.get(request), job)) return reply.code(403).send({ error: "Media job access denied" });
    if (!mediaJobs.cancel(jobId)) return reply.code(409).send({ error: "Media job is no longer active" });
    security?.audit("media-job.cancelled", principals.get(request)?.user.id, "media-job", jobId);
    return reply.code(202).send({ data: { id: jobId, cancellationRequested: true } });
  });

  app.post("/api/v1/media/jobs/:jobId/retry", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const original = mediaJobs.get(jobId);
    if (!original) return reply.code(404).send({ error: "Media job not found" });
    const principal = principals.get(request);
    if (!canAccessMediaJob(principal, original)) return reply.code(403).send({ error: "Media job access denied" });
    if (!isTerminalMediaJobStatus(original.status)) return reply.code(409).send({ error: "Only terminal media jobs can be retried" });
    try {
      const retried = await mediaJobs.retry(original, principal);
      security?.audit("media-job.retried", principal?.user.id, "media-job", retried.id, { originalJobId: original.id, routeId: original.routeId, modality: original.modality });
      return reply.code(202).send({ data: retried });
    } catch (error) {
      const statusCode = mediaSubmissionStatus(error);
      if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
      return reply.code(statusCode).send({ error: errorMessage(error), ...(error instanceof MediaJobAdmissionError ? { data: { jobId: error.jobId } } : {}) });
    }
  });

  app.get("/api/v1/media/jobs/:jobId/events", async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = mediaJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "Media job not found" });
    if (!canAccessMediaJob(principals.get(request), job)) return reply.code(403).send({ error: "Media job access denied" });
    const query = request.query as { after?: string; stream?: string };
    const headerAfter = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined;
    const after = toNonNegativeInteger(query.after ?? headerAfter, 0);
    if (query.stream !== "true" && !String(request.headers.accept ?? "").includes("text/event-stream")) {
      return { data: mediaJobs.eventsAfter(jobId, after) };
    }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    let last = after;
    const send = (event: MediaJobEventEnvelope) => {
      if (event.sequence <= last) return;
      last = event.sequence;
      reply.raw.write(`id: ${event.sequence}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = mediaJobs.subscribe(jobId, (event) => {
      send(event);
      if (isTerminalMediaEvent(event.event.type)) {
        unsubscribe();
        reply.raw.end();
      }
    });
    for (const event of mediaJobs.eventsAfter(jobId, after)) send(event);
    if (isTerminalMediaJobStatus(String(mediaJobs.get(jobId)?.status))) {
      unsubscribe();
      reply.raw.end();
    } else {
      request.raw.once("aborted", unsubscribe);
    }
  });

  app.post("/v1/images/generations", async (request, reply) => {
    try {
      const body = parseImageGenerationRequest(request.body);
      const principal = principals.get(request);
      const job = await mediaJobs.submit({
        routeId: body.model,
        modality: "image",
        params: { prompt: body.prompt, ...(body.size ? { size: body.size } : {}) },
      }, principal);
      security?.audit("media-job.created", principal?.user.id, "media-job", job.id, { routeId: body.model, modality: "image", gateway: "images" });
      const terminal = await awaitMediaJob(mediaJobs, job.id, imageTimeoutMs);
      if (terminal.status === "completed" && terminal.artifactId) {
        const artifact = store.getArtifact(terminal.artifactId);
        const bytes = artifact ? await artifacts.read(artifact.id) : undefined;
        if (!artifact || !bytes) throw new Error("Generated artifact is missing");
        const response: ImageGenerationResponse = {
          created: Math.floor(Date.now() / 1000),
          data: body.response_format === "b64_json"
            ? [{ b64_json: Buffer.from(bytes).toString("base64") }]
            : [{ url: `${requestOrigin(request)}/api/v1/artifacts/${artifact.id}/content` }],
        };
        security?.audit("media-job.completed", principal?.user.id, "media-job", job.id, { artifactId: artifact.id, gateway: "images" });
        return response;
      }
      if (terminal.status === "failed") {
        return reply.code(502).send({ error: { message: mediaJobFailureMessage(store, terminal), type: "media_generation_failed", param: job.id, code: "media_generation_failed" } });
      }
      if (terminal.status === "cancelled") {
        return reply.code(409).send({ error: { message: "Image generation was cancelled", type: "media_generation_cancelled", param: job.id, code: "media_generation_cancelled" } });
      }
      return reply.code(502).send({ error: { message: `Image generation ended with status ${terminal.status}`, type: "media_generation_failed", param: job.id, code: "media_generation_failed" } });
    } catch (error) {
      if (error instanceof MediaGenerationTimeoutError) {
        return reply.code(504).send({ error: { message: `Image generation timed out; resume polling GET /api/v1/media/jobs/${error.jobId}`, type: "media_generation_timeout", param: error.jobId, code: "media_generation_timeout" } });
      }
      const statusCode = mediaSubmissionStatus(error);
      if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
      return reply.code(statusCode).send(error instanceof MediaJobAdmissionError
        ? { error: { message: error.message, type: "resource_busy", param: error.jobId, code: error.admission.reason } }
        : openAIError(error, "invalid_request_error"));
    }
  });

  app.post("/v1/videos/generations", async (request, reply) => {
    try {
      const body = parseVideoGenerationRequest(request.body);
      const principal = principals.get(request);
      const job = await mediaJobs.submit({
        routeId: body.model,
        modality: "video",
        params: {
          prompt: body.prompt,
          ...(body.duration !== undefined ? { durationSeconds: body.duration } : {}),
          ...(body.resolution ? { size: body.resolution } : {}),
        },
      }, principal);
      security?.audit("media-job.created", principal?.user.id, "media-job", job.id, { routeId: body.model, modality: "video", gateway: "videos" });
      const response: VideoGenerationResponse = {
        id: job.id,
        object: "video.generation",
        status: job.status,
        createdAt: job.enqueuedAt,
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
        ...(job.artifactId ? { artifactId: job.artifactId } : {}),
        ...(job.errorCode ? { error: job.errorCode } : {}),
      };
      return reply.code(202).send(response);
    } catch (error) {
      const statusCode = mediaSubmissionStatus(error);
      if (error instanceof MediaJobAdmissionError) reply.header("retry-after", "2");
      return reply.code(statusCode).send(error instanceof MediaJobAdmissionError
        ? { error: { message: error.message, type: "resource_busy", param: error.jobId, code: error.admission.reason } }
        : openAIError(error, "invalid_request_error"));
    }
  });

  app.post("/v1/audio/generations", async (_request, reply) => reply.code(501).send({
    error: { message: "Audio generation is not available yet", type: "not_implemented" },
  }));
}

export function requestOrigin(request: FastifyRequest): string {
  const authority = request.headers.host?.trim();
  if (authority) {
    try {
      return new URL(`${request.protocol}://${authority}`).origin;
    } catch {
      // Fall through to Fastify's normalized hostname for malformed headers.
    }
  }
  return `${request.protocol}://${request.hostname}`;
}

export function mediaJobFailureMessage(store: SqliteStore, job: MediaJobRecord): string {
  const events = store.mediaJobEventsAfter(job.id, 0);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "failed") return event.error;
  }
  return job.errorCode ?? `Media generation ended with status ${job.status}`;
}

export async function awaitMediaJob(coordinator: MediaJobCoordinator, id: string, timeoutMs: number): Promise<MediaJobRecord> {
  const current = coordinator.get(id);
  if (current && isTerminalMediaJobStatus(current.status)) return current;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new MediaGenerationTimeoutError(id));
    }, timeoutMs);
    unsubscribe = coordinator.subscribe(id, (event) => {
      if (!isTerminalMediaEvent(event.event.type) || settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      const job = coordinator.get(id);
      if (job) resolve(job);
      else reject(new Error(`Media job ${id} disappeared while awaiting completion`));
    });
  });
}

export class MediaGenerationTimeoutError extends Error {
  constructor(readonly jobId: string) {
    super(`Image generation timed out (job ${jobId})`);
    this.name = "MediaGenerationTimeoutError";
  }
}

function canAccessMediaJob(principal: AuthenticatedPrincipal | undefined, job: MediaJobRecord): boolean {
  return !principal || principal.user.role === "administrator" || principal.user.id === job.createdByUserId;
}

function isTerminalMediaEvent(type: string): boolean {
  return type === "completed" || type === "failed" || type === "cancelled";
}

function parseModality(value: unknown): MediaModality {
  if (value === "image" || value === "video" || value === "audio") return value;
  throw new TypeError("modality must be image, video, or audio");
}

function parseMediaStatus(value: string | undefined): MediaJobStatus | undefined {
  return value && (isActiveMediaJobStatus(value) || isTerminalMediaJobStatus(value)) ? value : undefined;
}

function parseMediaParams(value: unknown): MediaGenerationParams {
  const body = requireRecord(value);
  const prompt = requireString(body.prompt, "prompt");
  const operation = parseMediaOperation(body.operation);
  return {
    prompt,
    ...(operation ? { operation } : {}),
    ...(typeof body.negativePrompt === "string" ? { negativePrompt: body.negativePrompt } : {}),
    ...(typeof body.lyrics === "string" ? { lyrics: body.lyrics } : {}),
    ...(Array.isArray(body.refs) ? {
      refs: body.refs.map((ref) => {
        if (!isRecord(ref)) throw new TypeError("params.refs entries must be objects");
        const modality = ref.modality === "image" || ref.modality === "video" || ref.modality === "audio" ? ref.modality : undefined;
        if (ref.modality !== undefined && !modality) throw new TypeError("params.refs modality must be image, video, or audio");
        if (typeof ref.artifactId === "string" && ref.artifactId) return { artifactId: ref.artifactId, ...(modality ? { modality } : {}) };
        if (typeof ref.url === "string" && ref.url) return { url: ref.url, ...(modality ? { modality } : {}) };
        throw new TypeError("params.refs entries must have artifactId or url");
      }),
    } : {}),
    ...(typeof body.size === "string" ? { size: body.size } : {}),
    ...(typeof body.durationSeconds === "number" ? { durationSeconds: body.durationSeconds } : {}),
    ...(typeof body.fps === "number" ? { fps: body.fps } : {}),
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    ...(typeof body.sampler === "string" ? { sampler: body.sampler } : {}),
    ...(typeof body.steps === "number" ? { steps: body.steps } : {}),
    ...(typeof body.guidance === "number" ? { guidance: body.guidance } : {}),
  };
}

function parseMediaOperation(value: unknown): "generate" | "edit" | "animate" | "reference" | undefined {
  if (value === undefined) return undefined;
  if (value === "generate" || value === "edit" || value === "animate" || value === "reference") return value;
  throw new TypeError("params.operation must be generate, edit, animate, or reference");
}

function parseImageGenerationRequest(value: unknown): ImageGenerationRequest {
  const body = requireRecord(value);
  const model = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");
  const n = body.n === undefined ? 1 : body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new TypeError("n must be a positive integer");
  if (n !== 1) throw new TypeError("n must be 1 in this version");
  return {
    model,
    prompt,
    ...(body.size !== undefined ? { size: requireString(body.size, "size") } : {}),
    ...(body.response_format === "url" || body.response_format === "b64_json" ? { response_format: body.response_format } : {}),
    ...(typeof body.user === "string" && body.user ? { user: body.user } : {}),
  };
}

function parseVideoGenerationRequest(value: unknown): VideoGenerationRequest {
  const body = requireRecord(value);
  const model = requireString(body.model, "model");
  const prompt = requireString(body.prompt, "prompt");
  const duration = body.duration;
  if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)) {
    throw new TypeError("duration must be a positive number");
  }
  return {
    model,
    prompt,
    ...(duration !== undefined ? { duration } : {}),
    ...(body.resolution !== undefined ? { resolution: requireString(body.resolution, "resolution") } : {}),
    ...(typeof body.user === "string" && body.user ? { user: body.user } : {}),
  };
}

function openAIError(error: unknown, type: string): OpenAIErrorResponse {
  return { error: { message: errorMessage(error), type } };
}

function mediaSubmissionStatus(error: unknown): 400 | 404 | 429 | 503 {
  if (error instanceof MediaCoordinatorClosedError) return 503;
  if (error instanceof RouteNotFoundError) return 404;
  if (error instanceof SecurityPolicyError || error instanceof MediaJobAdmissionError) return 429;
  return 400;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Request body must be an object");
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

function validateClientRequestId(value: unknown): string {
  const normalized = requireString(value, "clientRequestId").trim();
  if (normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new TypeError("clientRequestId is invalid");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
