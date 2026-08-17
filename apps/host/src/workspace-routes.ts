import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { RouteNotFoundError, type RouteResolver } from "@fitz/inference-core";
import { classifyArtifact, normalizeMimeType } from "@fitz/media";
import { LOCAL_MAIN_CONTEXT_TOKENS, type SessionQuerySection, type SessionQueryService, type SessionRecord } from "@fitz/protocol";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { ArtifactRepository, SqliteStore } from "@fitz/storage";
import type { ContextManager } from "@fitz/context";
import { ConversationTurnError, type ConversationTurnService } from "./conversation-turns.js";

const LOCAL_CONNECTION_ID = "hosted--local";
const PUBLIC_ROUTE_IDS = new Set(["default", "fast", "smart"]);
const MEDIA_TOOL_NAMES = new Set(["generate_image", "generate_video", "generate_audio"]);

export interface WorkspaceRouteOptions {
  app: FastifyInstance;
  store: SqliteStore;
  artifacts: ArtifactRepository;
  sessionQuery: SessionQueryService;
  routes: RouteResolver;
  context: ContextManager;
  conversationTurns: ConversationTurnService;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
}

export function registerWorkspaceRoutes(options: WorkspaceRouteOptions): void {
  const { app, store, artifacts, sessionQuery, routes, context, conversationTurns, security, principals } = options;
  const principalFor = (request: object) => principals.get(request);
  const sessionFor = (sessionId: string) => store.getSession(sessionId);
  const canAccess = (ownerUserId: string | undefined, request: object) => canAccessOwner(principalFor(request), ownerUserId);

  app.get("/api/v1/projects", async (request) => {
    const principal = principalFor(request);
    return { data: store.listProjects(principal?.user.role === "administrator" ? undefined : principal?.user.id) };
  });

  app.post("/api/v1/projects", async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const principal = principalFor(request);
      const now = new Date().toISOString();
      const project = {
        id: randomUUID(),
        name: requireString(body.name, "name"),
        createdAt: now,
        updatedAt: now,
        ...(principal ? { ownerUserId: principal.user.id } : {}),
        ...(typeof body.rootPath === "string" ? { rootPath: body.rootPath } : {}),
      };
      store.createProject(project);
      security?.audit("project.created", principal?.user.id, "project", project.id);
      return reply.code(201).send({ data: project });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/projects/:projectId", async (request, reply) => {
    const project = store.getProject((request.params as { projectId: string }).projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (!canAccess(project.ownerUserId, request)) return reply.code(403).send({ error: "Project access denied" });
    return { data: project };
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    try {
      const project = store.getProject((request.params as { projectId: string }).projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (!canAccess(project.ownerUserId, request)) return reply.code(403).send({ error: "Project access denied" });
      const body = requireRecord(request.body);
      const updated = {
        ...project,
        ...(typeof body.name === "string" ? { name: requireString(body.name, "name") } : {}),
        ...(typeof body.rootPath === "string" ? { rootPath: body.rootPath } : {}),
        updatedAt: new Date().toISOString(),
      };
      store.updateProject(updated);
      return { data: updated };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete("/api/v1/projects/:projectId", async (request, reply) => {
    const project = store.getProject((request.params as { projectId: string }).projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const principal = principalFor(request);
    if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" });
    store.deleteProject(project.id);
    security?.audit("project.deleted", principal?.user.id, "project", project.id, { name: project.name });
    return reply.code(204).send();
  });

  app.get("/api/v1/projects/:projectId/sessions", async (request, reply) => {
    const project = store.getProject((request.params as { projectId: string }).projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const principal = principalFor(request);
    if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" });
    return { data: store.listSessions(project.id, principal?.user.role === "administrator" ? undefined : principal?.user.id) };
  });

  app.post("/api/v1/projects/:projectId/sessions", async (request, reply) => {
    try {
      const project = store.getProject((request.params as { projectId: string }).projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const principal = principalFor(request);
      if (!canAccessOwner(principal, project.ownerUserId)) return reply.code(403).send({ error: "Project access denied" });
      const body = requireRecord(request.body);
      const session = createSession(body, principal, project.id);
      store.createSession(session);
      security?.audit("session.created", principal?.user.id, "session", session.id, {
        projectId: project.id,
        connectionId: session.connectionId,
        routeId: session.routeId,
      });
      return reply.code(201).send({ data: session });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/chats", async (request) => {
    const principal = principalFor(request);
    return { data: store.listStandaloneSessions(principal?.user.role === "administrator" ? undefined : principal?.user.id) };
  });

  app.post("/api/v1/chats", async (request, reply) => {
    try {
      const principal = principalFor(request);
      const session = createSession(requireRecord(request.body), principal);
      store.createSession(session);
      security?.audit("session.created", principal?.user.id, "session", session.id, {
        connectionId: session.connectionId,
        routeId: session.routeId,
      });
      return reply.code(201).send({ data: session });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
    return { data: session };
  });

  /** One session ID -> one versioned diagnostic artifact. The default is a
   * full export, including immutable artifact bytes as base64; callers doing
   * lightweight inspection can opt out with includeArtifactContent=false. */
  app.get("/api/v1/sessions/:sessionId/forensics", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
    const query = request.query as { includeArtifactContent?: string; download?: string };
    const includeArtifactContent = query.includeArtifactContent !== "false";
    const result = await sessionQuery.query({
      sessionId: session.id,
      section: "all",
      includeArtifactContent,
      ...queryOwner(principalFor(request)),
    });
    const bundle = result?.snapshot.forensics;
    if (!bundle) return reply.code(404).send({ error: "Session not found" });
    if (query.download === "true") {
      reply.header("content-disposition", `attachment; filename="fitz-session-${safeFilename(session.id)}-forensics.json"`);
    }
    return { data: bundle };
  });

  app.get("/api/v1/sessions/:sessionId/query", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
    try {
      const query = request.query as { section?: string; after?: string; before?: string; limit?: string; includeArtifactContent?: string };
      const section = parseSessionQuerySection(query.section);
      const result = await sessionQuery.query({
        sessionId: session.id,
        section,
        ...(query.after === undefined ? {} : { after: toNonNegativeInteger(query.after, 0) }),
        ...(query.before === undefined ? {} : { before: Math.max(1, toNonNegativeInteger(query.before, Number.MAX_SAFE_INTEGER)) }),
        ...(query.limit === undefined ? {} : { limit: toNonNegativeInteger(query.limit, 0) }),
        ...(query.includeArtifactContent === "true" ? { includeArtifactContent: true } : {}),
        ...queryOwner(principalFor(request)),
      });
      if (!result) return reply.code(404).send({ error: "Session not found" });
      return {
        data: result.section === "transcript"
          ? { ...result, page: { ...result.page, estimatedContextTokens: context.estimateSession(session.id) } }
          : result,
      };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.patch("/api/v1/sessions/:sessionId", async (request, reply) => {
    try {
      const session = sessionFor((request.params as { sessionId: string }).sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
      const body = requireRecord(request.body);
      const updated: SessionRecord = {
        ...session,
        ...(typeof body.title === "string" ? { title: requireString(body.title, "title") } : {}),
        ...(body.status === "active" || body.status === "archived" ? { status: body.status } : {}),
        ...(typeof body.connectionId === "string" && body.connectionId.trim() ? { connectionId: body.connectionId.trim() } : {}),
        ...(body.routeId !== undefined ? { routeId: requirePublicRouteId(body.routeId) } : {}),
        updatedAt: new Date().toISOString(),
      };
      store.updateSession(updated);
      return { data: updated };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete("/api/v1/sessions/:sessionId", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const principal = principalFor(request);
    if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
    const activeRun = store.latestSessionAgentRun(session.id);
    if (activeRun?.status === "queued" || activeRun?.status === "running") return reply.code(409).send({ error: "Stop the active request before removing this chat" });
    for (const artifact of store.listArtifacts(session.id)) await artifacts.delete(artifact.id);
    store.deleteSession(session.id);
    security?.audit("session.deleted", principal?.user.id, "session", session.id, { title: session.title, projectId: session.projectId });
    return reply.code(204).send();
  });

  app.get("/api/v1/sessions/:sessionId/transcript", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
    const query = request.query as { after?: string; before?: string; limit?: string };
    const limit = Math.min(Math.max(toNonNegativeInteger(query.limit, 250), 1), 500);
    const after = query.after === undefined ? undefined : toNonNegativeInteger(query.after, 0);
    const before = query.before === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, toNonNegativeInteger(query.before, Number.MAX_SAFE_INTEGER));
    const result = await sessionQuery.query({
      sessionId: session.id,
      section: "transcript",
      ...(after === undefined ? { before } : { after }),
      limit,
      ...queryOwner(principalFor(request)),
    });
    if (!result) return reply.code(404).send({ error: "Session not found" });
    const data = result.transcript;
    return {
      data,
      page: {
        hasEarlier: after === undefined ? result.page.hasMore : false,
        oldestSequence: data.at(0)?.sequence ?? null,
        newestSequence: data.at(-1)?.sequence ?? null,
        estimatedContextTokens: context.estimateSession(session.id),
      },
    };
  });

  app.post("/api/v1/sessions/:sessionId/messages", async (request, reply) => {
    try {
      const session = sessionFor((request.params as { sessionId: string }).sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const principal = principalFor(request);
      if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
      const body = requireRecord(request.body);
      const clientMessageId = requireString(body.clientMessageId, "clientMessageId");
      if (clientMessageId.length > 128) throw new TypeError("clientMessageId must be at most 128 characters");
      const text = requireString(body.text, "text");
      const id = `client-message:${session.id}:${clientMessageId}`;
      const existing = store.getTranscriptEntry(id);
      if (existing) {
        if (existing.sessionId !== session.id || existing.role !== "user" || existing.content.text !== text) {
          return reply.code(409).send({ error: "clientMessageId is already used by another message" });
        }
        return reply.code(200).send({ data: existing });
      }
      const entry = store.appendTranscriptEntry({
        id,
        sessionId: session.id,
        kind: "message",
        role: "user",
        content: { text, source: "desktop" },
        createdAt: new Date().toISOString(),
      });
      security?.audit("session.message-created", principal?.user.id, "session", session.id, { transcriptEntryId: entry.id });
      return reply.code(201).send({ data: entry });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/v1/sessions/:sessionId/regenerate", async (request, reply) => {
    try {
      const session = sessionFor((request.params as { sessionId: string }).sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const principal = principalFor(request);
      if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
      const runId = requireString(requireRecord(request.body).runId, "runId");
      const result = conversationTurns.regenerateLatestAssistant(session.id, runId);
      security?.audit("session.response-regenerated", principal?.user.id, "session", session.id, { runId, removedTranscriptEntries: result.removedTranscriptEntries });
      return { data: result };
    } catch (error) {
      const status = error instanceof ConversationTurnError
        ? error.code === "assistant-not-found" || error.code === "transcript-not-found" ? 404 : 409
        : 400;
      return reply.code(status).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/v1/sessions/:sessionId/compact", async (request, reply) => {
    try {
      const session = sessionFor((request.params as { sessionId: string }).sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const principal = principalFor(request);
      if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
      const body = isRecord(request.body) ? request.body : {};
      const publicRouteId = typeof body.model === "string" ? requireString(body.model, "model") : session.routeId ?? "default";
      const routeId = publicRouteId;
      const resolved = routes.resolve(routeId);
      const result = await context.compactSession(session.id, Math.min(LOCAL_MAIN_CONTEXT_TOKENS, resolved.recipe.contextTokens));
      security?.audit("session.compacted", principal?.user.id, "session", session.id, {
        routeId,
        throughSequence: result.entry.content.throughSequence,
      });
      return { data: result };
    } catch (error) {
      return reply.code(error instanceof RouteNotFoundError ? 404 : 400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/sessions/:sessionId/artifacts", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
    return { data: store.listArtifacts(session.id) };
  });

  app.post("/api/v1/sessions/:sessionId/artifacts", async (request, reply) => {
    try {
      const session = sessionFor((request.params as { sessionId: string }).sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const principal = principalFor(request);
      if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
      const body = requireRecord(request.body);
      const name = requireString(body.name, "name");
      const mimeType = normalizeMimeType(requireString(body.mimeType, "mimeType"));
      const content = decodeBase64(body.contentBase64);
      if (content.byteLength > 5_000_000) throw new TypeError("Artifact exceeds the 5000000 byte limit");
      const artifact = await artifacts.create({
        id: randomUUID(),
        sessionId: session.id,
        name,
        mimeType,
        kind: classifyArtifact(mimeType, name),
        createdAt: new Date().toISOString(),
        metadata: isRecord(body.metadata) ? body.metadata : {},
        ...(principal ? { createdByUserId: principal.user.id } : {}),
      }, content, { maxBytes: 5_000_000 });
      security?.audit("artifact.created", principal?.user.id, "artifact", artifact.id, {
        sessionId: session.id,
        mimeType,
        byteSize: artifact.byteSize,
      });
      return reply.code(201).send({ data: artifact });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/artifacts/:artifactId/content", async (request, reply) => {
    const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    const session = sessionFor(artifact.sessionId);
    if (!session || !canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Artifact access denied" });
    const range = resolveByteRange(request.headers.range, artifact.byteSize);
    if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${artifact.byteSize}`).send();
    const content = await artifacts.open(artifact.id, range ?? undefined);
    if (!content) return reply.code(404).send({ error: "Artifact content not found" });
    const base = () => reply
      .header("accept-ranges", "bytes")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header("content-disposition", `attachment; filename="${safeFilename(artifact.name)}"`)
      .type(artifact.mimeType);
    if (range === null) return base().header("content-length", content.byteSize).send(content.stream);
    return base().code(206).header("content-length", range.end - range.start + 1).header("content-range", `bytes ${range.start}-${range.end}/${content.byteSize}`).send(content.stream);
  });

  app.delete("/api/v1/artifacts/:artifactId", async (request, reply) => {
    const artifact = store.getArtifact((request.params as { artifactId: string }).artifactId);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    const session = sessionFor(artifact.sessionId);
    const principal = principalFor(request);
    if (!session || !canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Artifact access denied" });
    await artifacts.delete(artifact.id);
    security?.audit("artifact.deleted", principal?.user.id, "artifact", artifact.id, { sessionId: artifact.sessionId, name: artifact.name });
    return reply.code(204).send();
  });

  app.post("/api/v1/sessions/:sessionId/tool-approvals", async (request, reply) => {
    try {
      const session = sessionFor((request.params as { sessionId: string }).sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });
      const principal = principalFor(request);
      if (!canAccessOwner(principal, session.ownerUserId)) return reply.code(403).send({ error: "Session access denied" });
      const body = requireRecord(request.body);
      const toolName = requireString(body.toolName, "toolName");
      const decision = store.resolveToolPolicy(principal?.user.id, principal?.user.role, toolName);
      const now = new Date().toISOString();
      const approval = {
        id: randomUUID(),
        sessionId: session.id,
        toolCallId: requireString(body.toolCallId, "toolCallId"),
        toolName,
        status: decision === "allow" ? "approved" as const : decision === "deny" ? "denied" as const : "pending" as const,
        request: isRecord(body.request) ? body.request : {},
        requestedAt: now,
        ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        ...(decision !== "ask" ? { resolvedAt: now } : {}),
      };
      store.createToolApproval(approval);
      security?.audit("tool-approval.requested", principal?.user.id, "tool-approval", approval.id, { toolName, decision });
      return reply.code(201).send({ data: approval });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/v1/sessions/:sessionId/tool-approvals", async (request, reply) => {
    const session = sessionFor((request.params as { sessionId: string }).sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Session access denied" });
    const query = request.query as { status?: string };
    return { data: store.listToolApprovals(session.id, parseApprovalStatus(query.status)) };
  });

  app.post("/api/v1/tool-approvals/:approvalId/decision", async (request, reply) => {
    try {
      const approval = store.getToolApproval((request.params as { approvalId: string }).approvalId);
      if (!approval) return reply.code(404).send({ error: "Approval not found" });
      const session = sessionFor(approval.sessionId);
      if (!session || !canAccess(session.ownerUserId, request)) return reply.code(403).send({ error: "Approval access denied" });
      const body = requireRecord(request.body);
      if (body.decision !== "approved" && body.decision !== "denied") throw new TypeError("decision must be approved or denied");
      const amendedRequest = body.decision === "approved" && MEDIA_TOOL_NAMES.has(approval.toolName) && isRecord(body.request)
        ? parseMediaApprovalRequest(approval.toolName, approval.request, body.request)
        : undefined;
      const principal = principalFor(request);
      if (!store.resolveToolApproval(approval.id, body.decision, principal?.user.id, typeof body.note === "string" ? body.note : undefined, amendedRequest)) {
        return reply.code(409).send({ error: "Approval is no longer pending" });
      }
      security?.audit("tool-approval.resolved", principal?.user.id, "tool-approval", approval.id, {
        decision: body.decision,
        amended: Boolean(amendedRequest),
      });
      return { data: store.getToolApproval(approval.id) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  function createSession(body: Record<string, unknown>, principal: AuthenticatedPrincipal | undefined, projectId?: string): SessionRecord {
    const now = new Date().toISOString();
    const routeId = requirePublicRouteId(body.routeId);
    const connectionId = typeof body.connectionId === "string" && body.connectionId.trim() ? body.connectionId.trim() : LOCAL_CONNECTION_ID;
    return {
      id: randomUUID(),
      ...(projectId ? { projectId } : {}),
      title: requireString(body.title, "title"),
      status: "active",
      connectionId,
      routeId,
      createdAt: now,
      updatedAt: now,
      ...(principal ? { ownerUserId: principal.user.id } : {}),
    };
  }
}

function queryOwner(principal: AuthenticatedPrincipal | undefined): { ownerUserId?: string } {
  return principal && principal.user.role !== "administrator" ? { ownerUserId: principal.user.id } : {};
}

function parseSessionQuerySection(value: string | undefined): SessionQuerySection {
  if (value === undefined || value === "") return "transcript";
  if (["overview", "transcript", "runs", "evidence", "artifacts", "media", "audit", "all"].includes(value)) return value as SessionQuerySection;
  throw new TypeError(`Unknown session query section: ${value}`);
}

function canAccessOwner(principal: AuthenticatedPrincipal | undefined, ownerUserId: string | undefined): boolean {
  return !principal || principal.user.role === "administrator" || principal.user.id === ownerUserId;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Body must be an object");
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function requirePublicRouteId(value: unknown): "default" | "fast" | "smart" {
  if (value === undefined) return "default";
  if (typeof value !== "string" || !PUBLIC_ROUTE_IDS.has(value)) throw new TypeError("routeId must be default, fast, or smart");
  return value as "default" | "fast" | "smart";
}

function toNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseApprovalStatus(value: string | undefined): "pending" | "approved" | "denied" | "cancelled" | undefined {
  return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" ? value : undefined;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError("contentBase64 must be valid padded base64");
  }
  return Buffer.from(value, "base64");
}

function safeFilename(value: string): string {
  return value.replace(/[\r\n"\\/]/g, "_").slice(0, 160) || "artifact";
}

function resolveByteRange(header: string | undefined, total: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  if (total === 0) return "unsatisfiable";
  const spec = /^bytes=(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!spec || spec === "*" || spec.includes(",")) return null;
  if (spec.startsWith("-")) {
    const suffix = Number(spec.slice(1));
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const separator = spec.indexOf("-");
  if (separator === -1) return null;
  const start = Number(spec.slice(0, separator));
  if (!Number.isSafeInteger(start) || start < 0 || start >= total) return "unsatisfiable";
  const endText = spec.slice(separator + 1);
  const end = endText === "" ? total - 1 : Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end: Math.min(end, total - 1) };
}

function parseMediaApprovalRequest(
  toolName: string,
  original: Readonly<Record<string, unknown>>,
  value: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const prompt = requireString(value.prompt, "prompt");
  const amended: Record<string, unknown> = { prompt };
  const optionalNumber = (name: string, options: { integer?: boolean; minimum?: number } = {}) => {
    const candidate = value[name];
    if (candidate === undefined || candidate === null || candidate === "") return;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || (options.integer && !Number.isInteger(candidate)) || (options.minimum !== undefined && candidate < options.minimum)) {
      throw new TypeError(`${name} is invalid`);
    }
    amended[name] = candidate;
  };
  const optionalString = (name: string) => {
    const candidate = value[name];
    if (candidate === undefined || candidate === null || candidate === "") return;
    if (typeof candidate !== "string") throw new TypeError(`${name} must be a string`);
    amended[name] = candidate;
  };
  if (toolName === "generate_image") {
    optionalString("size");
    optionalNumber("seed", { integer: true, minimum: 0 });
    optionalString("negative_prompt");
  } else if (toolName === "generate_video") {
    optionalNumber("duration_seconds", { minimum: 0.1 });
    optionalString("resolution");
    optionalNumber("fps", { integer: true, minimum: 1 });
  } else if (toolName === "generate_audio") {
    optionalNumber("duration_seconds", { minimum: 0.1 });
    optionalString("lyrics");
  }
  if (Array.isArray(value.refs)) {
    if (!value.refs.every((item) => typeof item === "string")) throw new TypeError("refs must contain strings");
    amended.refs = value.refs.slice(0, 32);
  }
  for (const protectedField of ["route_id", "estimated_credit_cost_cents"]) {
    if (original[protectedField] !== undefined) amended[protectedField] = original[protectedField];
  }
  return amended;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
