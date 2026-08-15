import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SecurityService } from "@fitz/security";
import { SqliteStore } from "@fitz/storage";
import { registerSecurityAdministrationRoutes } from "./security-administration-routes.js";

const openApps: Array<{ close(): Promise<void> }> = [];
const openStores: SqliteStore[] = [];
afterEach(async () => { while (openApps.length) await openApps.pop()!.close(); while (openStores.length) openStores.pop()!.close(); });

describe("Hosting user administration", () => {
  it("creates a consumer key, rotates it, and removes all access without deleting history", async () => {
    const app = Fastify(); const store = new SqliteStore(":memory:"); const security = new SecurityService(store, "test-pepper"); openApps.push(app); openStores.push(store);
    registerSecurityAdministrationRoutes({ app, store, security, principals: new WeakMap(), administratorGuard: async () => undefined, hosting: { status: async () => ({ publicUrl: "https://yan.example.ts.net" }), configuration: () => ({ users: { defaultQuota: { requestsPerMinute: 7, promptCharacters: 1000, outputTokens: 500, queueDepth: 1 } } }) } as never });
    const created = await app.inject({ method: "POST", url: "/api/v1/management/hosting/users", payload: { displayName: "Grace", keyName: "Laptop" } });
    expect(created.statusCode).toBe(201); expect(created.json().data.user.role).toBe("consumer"); expect(created.json().data.url).toBe("https://yan.example.ts.net");
    expect(security.authenticate(`Bearer ${created.json().data.apiKey}`)?.user.id).toBe(created.json().data.user.id);
    const deviceId = created.json().data.device.id;
    const rotated = await app.inject({ method: "POST", url: `/api/v1/management/devices/${deviceId}/rotate`, payload: {} });
    expect(rotated.statusCode).toBe(201); expect(security.authenticate(`Bearer ${created.json().data.apiKey}`)).toBeUndefined(); expect(security.authenticate(`Bearer ${rotated.json().data.token}`)?.user.id).toBe(created.json().data.user.id);
    const removed = await app.inject({ method: "DELETE", url: `/api/v1/management/users/${created.json().data.user.id}` });
    expect(removed.statusCode).toBe(200); expect(store.getUser(created.json().data.user.id)?.status).toBe("disabled"); expect(security.authenticate(`Bearer ${rotated.json().data.token}`)).toBeUndefined();
  });
});
