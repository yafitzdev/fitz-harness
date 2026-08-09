import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { ArtifactRepository, SqliteStore, StorageDurabilityService } from "@fitz/storage";

export interface StorageRouteOptions {
  app: FastifyInstance;
  store: SqliteStore;
  artifacts: ArtifactRepository;
  storageDurability?: StorageDurabilityService;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
}

export function registerStorageRoutes(options: StorageRouteOptions): void {
  const { app, store, artifacts, storageDurability, security, principals, administratorGuard } = options;
  const preHandler = administratorGuard;

  app.get("/api/v1/management/storage", { preHandler }, async (_request, reply) => {
    try { return { data: { report: await artifacts.inspect(), backups: storageDurability ? await storageDurability.listBackups() : [], available: Boolean(storageDurability) } }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/storage/verify", { preHandler }, async (request, reply) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const report = await artifacts.inspect({ verifyChecksums: body.verifyChecksums !== false });
      security?.audit("storage.verified", principals.get(request)?.user.id, "storage", undefined, { issues: report.issues.length, verifiedChecksums: report.verifiedChecksums });
      return { data: report };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/storage/gc", { preHandler }, async (request, reply) => {
    try {
      const result = await artifacts.collectGarbage();
      security?.audit("storage.garbage-collected", principals.get(request)?.user.id, "storage", undefined, { ...result });
      return { data: result };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.put("/api/v1/management/storage/quota", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const quotaBytes = body.quotaBytes === null ? undefined : Number(body.quotaBytes);
      if (quotaBytes !== undefined && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1)) throw new TypeError("quotaBytes must be a positive integer or null");
      if (quotaBytes === undefined) store.deleteSetting("artifactStorageQuotaBytes");
      else store.setSetting("artifactStorageQuotaBytes", quotaBytes);
      security?.audit("storage.quota-updated", principals.get(request)?.user.id, "storage", undefined, { quotaBytes: quotaBytes ?? null });
      return { data: { quotaBytes: quotaBytes ?? null } };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/backups", { preHandler }, async (_request, reply) => {
    try { return { data: await requiredDurability(storageDurability).listBackups() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/backups", { preHandler }, async (request, reply) => {
    try {
      const backup = await requiredDurability(storageDurability).createBackup();
      security?.audit("storage.backup-created", principals.get(request)?.user.id, "backup", backup.id, { objects: backup.objects, bytes: backup.bytes });
      return reply.code(201).send({ data: backup });
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/backups/:id/validate", { preHandler }, async (request, reply) => {
    try { return { data: await requiredDurability(storageDurability).validateBackup((request.params as { id: string }).id, true) }; }
    catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/backups/:id/restore", { preHandler }, async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      const result = await requiredDurability(storageDurability).scheduleRestore(id);
      security?.audit("storage.restore-scheduled", principals.get(request)?.user.id, "backup", id);
      return { data: result };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
}

function requiredDurability(value: StorageDurabilityService | undefined): StorageDurabilityService {
  if (!value) throw new Error("Storage backups are unavailable");
  return value;
}
function requireRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new TypeError("Body must be an object"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
