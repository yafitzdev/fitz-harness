import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { ToolPolicyRecord } from "@fitz/protocol";
import { DEFAULT_QUOTAS, SecurityPolicyError, type AuthenticatedPrincipal, type SecurityService } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import type { HostingService } from "./hosting-service.js";

export interface SecurityAdministrationRouteOptions {
  app: FastifyInstance;
  store: SqliteStore;
  security?: SecurityService;
  principals: WeakMap<object, AuthenticatedPrincipal>;
  administratorGuard: preHandlerHookHandler;
  hosting?: HostingService;
}

/** Registers identity, device, quota, grant, and tool-policy administration. */
export function registerSecurityAdministrationRoutes(options: SecurityAdministrationRouteOptions): void {
  const { app, store, security, principals, administratorGuard: preHandler } = options;

  app.get("/api/v1/management/tool-policies", { preHandler }, async () => ({ data: store.listToolPolicies() }));
  app.put("/api/v1/management/tool-policies/:subjectType/:subjectId/:toolName", { preHandler }, async (request, reply) => {
    try {
      const params = request.params as { subjectType: string; subjectId: string; toolName: string };
      if (params.subjectType !== "role" && params.subjectType !== "user") throw new TypeError("subjectType must be role or user");
      const body = requireRecord(request.body);
      if (body.decision !== "allow" && body.decision !== "deny" && body.decision !== "ask") throw new TypeError("decision must be allow, deny, or ask");
      const policy: ToolPolicyRecord = { subjectType: params.subjectType, subjectId: params.subjectId, toolName: params.toolName, decision: body.decision, updatedAt: new Date().toISOString() };
      store.upsertToolPolicy(policy);
      security?.audit("tool-policy.updated", principals.get(request)?.user.id, "tool-policy", `${params.subjectType}:${params.subjectId}:${params.toolName}`, { decision: body.decision });
      return { data: policy };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });

  app.get("/api/v1/management/users", { preHandler }, async () => ({ data: store.listUsers() }));
  app.get("/api/v1/management/user-usage", { preHandler }, async (request, reply) => {
    const query = request.query as { from?: string; to?: string };
    const to = query.to ? validDate(query.to) : new Date();
    const from = query.from ? validDate(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (!Number.isFinite(to.getTime()) || !Number.isFinite(from.getTime()) || from >= to) return reply.code(400).send({ error: "Invalid usage date range" });
    return { data: store.userUsageSummaries({ from: from.toISOString(), to: to.toISOString() }) };
  });
  app.post("/api/v1/management/hosting/users", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const displayName = requireString(body.displayName, "displayName");
      const keyName = body.keyName === undefined ? `${displayName} device` : requireString(body.keyName, "keyName");
      const service = securityRequired(security);
      const hostingStatus = options.hosting ? await options.hosting.status() : undefined;
      const user = service.createUser(displayName, "consumer");
      const defaults = options.hosting?.configuration().users.defaultQuota;
      if (defaults) service.setQuota(user.id, { maxRequestsPerMinute: defaults.requestsPerMinute, maxPromptChars: defaults.promptCharacters, maxOutputTokens: defaults.outputTokens, maxQueueDepth: defaults.queueDepth });
      const issued = service.issueDevice(user.id, keyName);
      security?.audit("hosting.user-created", principals.get(request)?.user.id, "user", user.id, { deviceId: issued.device.id });
      return reply.code(201).send({ data: { user, device: issued.device, apiKey: issued.token, ...(hostingStatus?.publicUrl ? { url: hostingStatus.publicUrl } : {}) } });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/users/:userId/access", { preHandler }, async (request, reply) => {
    const userId = (request.params as { userId: string }).userId;
    const user = store.getUser(userId);
    if (!user) return reply.code(404).send({ error: "User not found" });
    return { data: { user, devices: store.listDevices(userId), routeIds: store.listUserRouteGrants(userId), quota: store.getUserQuota(userId) ?? DEFAULT_QUOTAS[user.role], currentDeviceId: principals.get(request)?.device?.id } };
  });
  app.post("/api/v1/management/users", { preHandler }, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const user = securityRequired(security).createUser(requireString(body.displayName, "displayName"), parseRole(body.role));
      security?.audit("user.created", principals.get(request)?.user.id, "user", user.id, { role: user.role });
      return reply.code(201).send({ data: user });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.patch("/api/v1/management/users/:userId", { preHandler }, async (request, reply) => {
    try {
      const userId = (request.params as { userId: string }).userId;
      const body = requireRecord(request.body);
      const user = securityRequired(security).updateUser(userId, {
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        ...(body.role !== undefined ? { role: parseRole(body.role) } : {}),
        ...(body.status === "active" || body.status === "disabled" ? { status: body.status } : {}),
      });
      security?.audit("user.updated", principals.get(request)?.user.id, "user", userId);
      return { data: user };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.post("/api/v1/management/users/:userId/devices", { preHandler }, async (request, reply) => {
    try {
      const userId = (request.params as { userId: string }).userId;
      const body = requireRecord(request.body);
      const issued = securityRequired(security).issueDevice(userId, requireString(body.name, "name"));
      security?.audit("device.issued", principals.get(request)?.user.id, "device", issued.device.id, { userId });
      return reply.code(201).send({ data: issued });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/devices/:deviceId", { preHandler }, async (request, reply) => {
    const deviceId = (request.params as { deviceId: string }).deviceId;
    if (!store.revokeDevice(deviceId, new Date().toISOString())) return reply.code(404).send({ error: "Device not found or already revoked" });
    security?.audit("device.revoked", principals.get(request)?.user.id, "device", deviceId);
    return reply.code(204).send();
  });
  app.post("/api/v1/management/devices/:deviceId/rotate", { preHandler }, async (request, reply) => {
    const deviceId = (request.params as { deviceId: string }).deviceId;
    const located = store.listUsers().flatMap((user) => store.listDevices(user.id).map((device) => ({ user, device }))).find((entry) => entry.device.id === deviceId && !entry.device.revokedAt);
    if (!located) return reply.code(404).send({ error: "Active API key not found" });
    try {
      const issued = securityRequired(security).issueDevice(located.user.id, located.device.name);
      if (!store.revokeDevice(deviceId, new Date().toISOString())) {
        store.revokeDevice(issued.device.id, new Date().toISOString());
        return reply.code(409).send({ error: "The API key changed while it was being rotated" });
      }
      security?.audit("device.rotated", principals.get(request)?.user.id, "device", deviceId, { replacementDeviceId: issued.device.id, userId: located.user.id });
      return reply.code(201).send({ data: issued });
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.delete("/api/v1/management/users/:userId", { preHandler }, async (request, reply) => {
    const userId = (request.params as { userId: string }).userId;
    if (principals.get(request)?.user.id === userId) return reply.code(409).send({ error: "You cannot remove your current administrator account" });
    const user = store.getUser(userId);
    if (!user) return reply.code(404).send({ error: "User not found" });
    const removedAt = new Date().toISOString();
    const updated = securityRequired(security).updateUser(userId, { status: "disabled" });
    for (const device of store.listDevices(userId)) if (!device.revokedAt) store.revokeDevice(device.id, removedAt);
    security?.audit("hosting.user-removed", principals.get(request)?.user.id, "user", userId);
    return { data: updated };
  });
  app.put("/api/v1/management/users/:userId/routes", { preHandler }, async (request, reply) => {
    try {
      const userId = (request.params as { userId: string }).userId;
      const body = requireRecord(request.body);
      if (!Array.isArray(body.routeIds) || !body.routeIds.every((id) => typeof id === "string")) throw new TypeError("routeIds must be a string array");
      securityRequired(security).setRouteGrants(userId, body.routeIds);
      security?.audit("route-grants.updated", principals.get(request)?.user.id, "user", userId, { routeIds: body.routeIds });
      return { data: { userId, routeIds: store.listUserRouteGrants(userId) } };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.put("/api/v1/management/users/:userId/quota", { preHandler }, async (request, reply) => {
    try {
      const userId = (request.params as { userId: string }).userId;
      const body = requireRecord(request.body);
      const quota = {
        maxRequestsPerMinute: requireInteger(body.maxRequestsPerMinute),
        maxPromptChars: requireInteger(body.maxPromptChars),
        maxOutputTokens: requireInteger(body.maxOutputTokens),
        maxQueueDepth: requireInteger(body.maxQueueDepth),
      };
      securityRequired(security).setQuota(userId, quota);
      security?.audit("quota.updated", principals.get(request)?.user.id, "user", userId);
      return { data: quota };
    } catch (error) { return reply.code(400).send({ error: errorMessage(error) }); }
  });
  app.get("/api/v1/management/audit-events", { preHandler }, async (request) => {
    const query = request.query as { limit?: string };
    return { data: store.listAuditEvents(Math.min(toNonNegativeInteger(query.limit, 100), 1_000)) };
  });
}

function securityRequired(value: SecurityService | undefined): SecurityService { if (!value) throw new SecurityPolicyError("Authentication is disabled"); return value; }
function requireRecord(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new TypeError("Body must be an object"); return value; }
function requireString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`); return value.trim(); }
function requireInteger(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError("Quota values must be positive integers"); return value as number; }
function parseRole(value: unknown): "administrator" | "agent" | "consumer" { if (value === undefined) return "consumer"; if (value === "administrator" || value === "agent" || value === "consumer") return value; throw new TypeError("Invalid role"); }
function toNonNegativeInteger(value: string | undefined, fallback: number): number { if (value === undefined) return fallback; const number = Number.parseInt(value, 10); return Number.isFinite(number) && number >= 0 ? number : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validDate(value: string): Date { return new Date(value); }
