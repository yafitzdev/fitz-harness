import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { TailscaleMonitor, TailscaleServeManager, WindowsStartupManager } from "@fitz/connectivity";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { NInferRuntimeManager } from "./ninfer-runtime.js";

export interface RuntimeAdministrationRouteOptions {
  app: FastifyInstance;
  tailscale: TailscaleMonitor;
  tailscaleServe: TailscaleServeManager;
  startup?: WindowsStartupManager;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
  authMode: "disabled" | "required";
  localPort: number;
  ninferRuntime?: NInferRuntimeManager;
}

export function registerRuntimeAdministrationRoutes(options: RuntimeAdministrationRouteOptions): void {
  const { app, tailscale, tailscaleServe, startup, security, principals, administratorGuard, authMode, localPort, ninferRuntime } = options;
  const preHandler = administratorGuard;

  app.get("/api/v1/management/connectivity/status", { preHandler }, async () => {
    const tailscaleStatus = await tailscale.status();
    try { return { data: { tailscale: tailscaleStatus, serve: { available: true, configuration: await tailscaleServe.status() } } }; }
    catch (error) { return { data: { tailscale: tailscaleStatus, serve: { available: false, message: errorMessage(error) } } }; }
  });
  app.post("/api/v1/management/connectivity/tailscale-serve", { preHandler }, async (request, reply) => {
    try {
      if (authMode !== "required") return reply.code(409).send({ error: "Device authentication must be enabled before remote access" });
      const body = requireRecord(request.body);
      const requestedLocalPort = body.localPort === undefined ? localPort : requireInteger(body.localPort);
      const httpsPort = body.httpsPort === undefined ? 443 : requireInteger(body.httpsPort);
      await tailscaleServe.enable(requestedLocalPort, httpsPort);
      security?.audit("tailscale-serve.enabled", principals.get(request)?.user.id, "connectivity", "tailscale", { localPort: requestedLocalPort, httpsPort });
      return { data: await tailscaleServe.status() };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/connectivity/tailscale-serve", { preHandler }, async (request, reply) => {
    try {
      const query = request.query as { httpsPort?: string };
      const httpsPort = toNonNegativeInteger(query.httpsPort, 443);
      await tailscaleServe.disable(httpsPort);
      security?.audit("tailscale-serve.disabled", principals.get(request)?.user.id, "connectivity", "tailscale", { httpsPort });
      return reply.code(204).send();
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/startup", { preHandler }, async () => ({ data: startup ? await startup.status() : { available: false, configured: false, message: "Startup management is unavailable" } }));
  app.post("/api/v1/management/startup", { preHandler }, async (request, reply) => {
    try {
      const result = await requiredStartup(startup).install();
      security?.audit("host-startup.installed", principals.get(request)?.user.id, "host", "startup");
      return { data: result };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/startup", { preHandler }, async (request, reply) => {
    try {
      const result = await requiredStartup(startup).remove();
      security?.audit("host-startup.removed", principals.get(request)?.user.id, "host", "startup");
      return { data: result };
    } catch (error) { return reply.code(503).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/ninfer-runtime", { preHandler }, async (_request, reply) => {
    if (!ninferRuntime) return reply.code(404).send({ error: "Managed NInfer runtime is unavailable" });
    return { data: await ninferRuntime.status() };
  });
  app.post("/api/v1/management/ninfer-runtime/provision", { preHandler }, async (request, reply) => {
    if (!ninferRuntime) return reply.code(404).send({ error: "Managed NInfer runtime is unavailable" });
    try {
      const body = request.body === undefined ? {} : requireRecord(request.body);
      const moveModels = body.moveModels === undefined ? true : body.moveModels === true;
      if (body.moveModels !== undefined && typeof body.moveModels !== "boolean") throw new TypeError("moveModels must be a boolean");
      const status = ninferRuntime.startProvisioning(moveModels);
      security?.audit("ninfer-runtime.provision-requested", principals.get(request)?.user.id, "runtime", ninferRuntime.layout.id, { moveModels });
      return reply.code(202).send({ data: status });
    } catch (error) {
      const active = errorMessage(error).includes("already in progress");
      return reply.code(active ? 409 : 503).send({ error: errorMessage(error) });
    }
  });
}

function requiredStartup(value: WindowsStartupManager | undefined): WindowsStartupManager { if (!value) throw new Error("Startup management is unavailable"); return value; }
function requireRecord(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Body must be an object"); return value as Record<string, unknown>; }
function requireInteger(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError("Values must be positive integers"); return value as number; }
function toNonNegativeInteger(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
