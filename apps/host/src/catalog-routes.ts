import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { PiPackageService } from "@fitz/agent-pi";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import { DownloadNotFoundError, type ModelCatalogService } from "./model-catalog.js";

export interface CatalogRouteOptions {
  app: FastifyInstance;
  piPackages?: PiPackageService;
  modelCatalog?: ModelCatalogService;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
}

/** Owns installable Pi packages/skills and downloadable model catalogs. */
export function registerCatalogRoutes(options: CatalogRouteOptions): void {
  const { app, piPackages, modelCatalog, security, principals, administratorGuard } = options;
  const preHandler = administratorGuard;

  app.get("/api/v1/management/pi/catalog", { preHandler }, async (request, reply) => {
    try {
      const query = request.query as { query?: string; offset?: string; limit?: string; sort?: string; direction?: string; type?: unknown };
      return { data: await requiredPi(piPackages).catalog(query.query ?? "", toNonNegativeInteger(query.offset, 0), Math.min(toNonNegativeInteger(query.limit, 30), 50), catalogSort(query.sort), catalogDirection(query.direction), catalogTypeFilter(query.type)) };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/pi/packages", { preHandler }, async (_request, reply) => {
    try { return { data: await requiredPi(piPackages).installed() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/pi/skills", { preHandler }, async (_request, reply) => {
    try { return { data: await requiredPi(piPackages).skills() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/pi/packages/install", { preHandler }, async (request, reply) => mutatePackage(request, reply, "install"));
  app.post("/api/v1/management/pi/packages/update", { preHandler }, async (request, reply) => mutatePackage(request, reply, "update"));
  app.put("/api/v1/management/pi/packages/enabled", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const source = requireString(body.source, "source");
      if (typeof body.enabled !== "boolean") throw new TypeError("enabled must be boolean");
      await requiredPi(piPackages).setEnabled(source, body.enabled);
      security?.audit(body.enabled ? "pi-package.enabled" : "pi-package.disabled", principals.get(request)?.user.id, "pi-package", source);
      return { data: { source, enabled: body.enabled } };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/pi/packages", { preHandler }, async (request, reply) => {
    try {
      const source = requireString(requireRecord(request.body).source, "source");
      await requiredPi(piPackages).remove(source);
      security?.audit("pi-package.removed", principals.get(request)?.user.id, "pi-package", source);
      return reply.code(204).send();
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });

  app.get("/api/v1/management/models/catalog", { preHandler }, async (request, reply) => {
    try {
      const query = request.query as { query?: string; pipeline?: string; offset?: string; limit?: string; sort?: string; direction?: string; min_likes?: string; min_downloads?: string; released_within_weeks?: string };
      return { data: await requiredModels(modelCatalog).search(query.query ?? "", toNonNegativeInteger(query.offset, 0), Math.min(toNonNegativeInteger(query.limit, 30), 50), query.pipeline ?? "text-generation", catalogSort(query.sort), catalogDirection(query.direction), toNonNegativeInteger(query.min_likes, 0), toNonNegativeInteger(query.min_downloads, 0), toNonNegativeInteger(query.released_within_weeks, 0)) };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/models/files", { preHandler }, async (request, reply) => {
    try { return { data: await requiredModels(modelCatalog).files(requireString((request.query as { repo?: string }).repo, "repo")) }; }
    catch (error) { return reply.code(error instanceof TypeError ? 400 : 503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/models/downloaded", { preHandler }, async (_request, reply) => {
    try { return { data: await requiredModels(modelCatalog).downloaded() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/models/downloads", { preHandler }, async (_request, reply) => {
    try { return { data: requiredModels(modelCatalog).list() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/models/download", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const repo = requireString(body.repo, "repo");
      const fileName = body.fileName === undefined ? undefined : requireString(body.fileName, "fileName");
      const record = await requiredModels(modelCatalog).start(repo, fileName);
      security?.audit("model.download-started", principals.get(request)?.user.id, "model", `${repo}/${record.fileName}`);
      return reply.code(202).send({ data: record });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/models/downloads/:id", { preHandler }, async (request, reply) => {
    try { return { data: requiredModels(modelCatalog).progress((request.params as { id: string }).id) }; }
    catch (error) { return reply.code(error instanceof DownloadNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/models/downloads/:id", { preHandler }, async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      requiredModels(modelCatalog).cancel(id);
      security?.audit("model.download-cancelled", principals.get(request)?.user.id, "model", id);
      return reply.code(204).send();
    } catch (error) { return reply.code(error instanceof DownloadNotFoundError ? 404 : 400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/models/downloaded", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const repoId = requireString(body.repoId, "repoId");
      const fileName = requireString(body.fileName, "fileName");
      await requiredModels(modelCatalog).removeDownloaded(repoId, fileName);
      security?.audit("model.removed", principals.get(request)?.user.id, "model", `${repoId}/${fileName}`);
      return reply.code(204).send();
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });

  async function mutatePackage(request: FastifyRequest, reply: FastifyReply, action: "install" | "update") {
    try {
      const source = requireString(requireRecord(request.body).source, "source");
      await requiredPi(piPackages)[action](source);
      security?.audit(`pi-package.${action === "install" ? "installed" : "updated"}`, principals.get(request)?.user.id, "pi-package", source);
      return action === "install" ? reply.code(201).send({ data: { source } }) : { data: { source } };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  }
}

const CATALOG_SORT_KEYS = ["downloads", "updated", "name", "likes"] as const;
type CatalogSortKey = (typeof CATALOG_SORT_KEYS)[number];
const CATALOG_TYPES = ["extension", "skill", "prompt", "theme"] as const;
type CatalogType = (typeof CATALOG_TYPES)[number];
function catalogSort(value: unknown): CatalogSortKey { return typeof value === "string" && (CATALOG_SORT_KEYS as readonly string[]).includes(value) ? value as CatalogSortKey : "downloads"; }
function catalogDirection(value: unknown): "asc" | "desc" { return value === "asc" ? "asc" : "desc"; }
function catalogTypeFilter(value: unknown): CatalogType[] { const values = Array.isArray(value) ? value : value === undefined ? [] : [value]; return values.filter((entry): entry is CatalogType => typeof entry === "string" && (CATALOG_TYPES as readonly string[]).includes(entry)); }
function requiredPi(value: PiPackageService | undefined): PiPackageService { if (!value) throw new Error("Pi package management is unavailable"); return value; }
function requiredModels(value: ModelCatalogService | undefined): ModelCatalogService { if (!value) throw new Error("Model catalog is unavailable"); return value; }
function requireRecord(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Body must be an object"); return value as Record<string, unknown>; }
function requireString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`); return value.trim(); }
function toNonNegativeInteger(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
