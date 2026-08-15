import type { FitzConfigPatch } from "@fitz/config";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { HostingService } from "./hosting-service.js";

export interface HostingRouteOptions {
  app: FastifyInstance;
  hosting: HostingService;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
}

export function registerHostingRoutes(options: HostingRouteOptions): void {
  const { app, hosting, security, principals, administratorGuard: preHandler } = options;
  app.get("/api/v1/management/hosting", { preHandler }, async () => ({ data: await hosting.status() }));
  app.put("/api/v1/management/hosting", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      if (typeof body.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      const data = await hosting.update({ hosting: { enabled: body.enabled } });
      security?.audit(`hosting.${body.enabled ? "enabled" : "disabled"}`, principals.get(request)?.user.id, "hosting", "public");
      return { data };
    } catch (error) { return reply.code(error instanceof TypeError ? 400 : 503).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/hosting/repair", { preHandler }, async (_request, reply) => {
    try { return { data: await hosting.repair() }; }
    catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/config", { preHandler }, async () => ({ data: hosting.configuration(), path: hosting.configPath }));
  app.post("/api/v1/management/config/validate", { preHandler }, async (request, reply) => {
    try { return { data: hosting.preview(requireRecord(request.body) as FitzConfigPatch) }; }
    catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.patch("/api/v1/management/config", { preHandler }, async (request, reply) => {
    try {
      const data = await hosting.update(requireRecord(request.body) as FitzConfigPatch);
      security?.audit("configuration.updated", principals.get(request)?.user.id, "configuration", "canonical");
      return { data: { configuration: hosting.configuration(), hosting: data } };
    } catch (error) { return reply.code(error instanceof TypeError ? 400 : 503).send({ error: errorMessage(error) }); }
  });
}

function requireRecord(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Body must be an object"); return value as Record<string, unknown>; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
