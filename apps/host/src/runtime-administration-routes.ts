import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { AuthenticatedPrincipal, SecurityService } from "@fitz/security";
import type { NInferRuntimeManager } from "./ninfer-runtime.js";

export interface RuntimeAdministrationRouteOptions {
  app: FastifyInstance;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
  ninferRuntime?: NInferRuntimeManager;
}

export function registerRuntimeAdministrationRoutes(options: RuntimeAdministrationRouteOptions): void {
  const { app, security, principals, administratorGuard, ninferRuntime } = options;
  const preHandler = administratorGuard;
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

function requireRecord(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Body must be an object"); return value as Record<string, unknown>; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
