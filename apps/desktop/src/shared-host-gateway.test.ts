import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SharedHostGateway, isAllowedSharedRequest } from "./shared-host-gateway.js";

const gateways: SharedHostGateway[] = [];
const servers: Server[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map((gateway) => gateway.stop())); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("Share Fitz gateway", () => {
  it("uses a narrow, method-aware public route allowlist", () => {
    expect(isAllowedSharedRequest("POST", "/api/v1/pairing/redeem-shared")).toBe(true);
    expect(isAllowedSharedRequest("POST", "/api/v1/pairing/redeem")).toBe(false);
    expect(isAllowedSharedRequest("GET", "/api/v1/projects")).toBe(true);
    expect(isAllowedSharedRequest("POST", "/api/v1/projects")).toBe(false);
    expect(isAllowedSharedRequest("GET", "/api/v1/management/users")).toBe(false);
    expect(isAllowedSharedRequest("POST", "/api/v1/pairing/bootstrap")).toBe(false);
    expect(isAllowedSharedRequest("GET", "/api/v1/events")).toBe(false);
    expect(isAllowedSharedRequest("DELETE", "/api/v1/sessions/s1/transcript")).toBe(false);
    expect(isAllowedSharedRequest("POST", "/api/v1/agent/runs/r1/events")).toBe(false);
  });

  it("serves only minimal unauthenticated health and rejects management before proxying", async () => {
    const gateway = new SharedHostGateway({ target: new URL("http://127.0.0.1:65534"), port: 18790 });
    gateways.push(gateway);
    await gateway.start();
    const health = await get("http://127.0.0.1:18790/health");
    expect(health.status).toBe(503);
    expect(JSON.parse(health.body)).toEqual(expect.objectContaining({ status: "unavailable", protocolVersion: expect.any(String), hostContractVersion: expect.any(String) }));
    expect(JSON.parse(health.body)).not.toHaveProperty("resources");
    expect((await get("http://127.0.0.1:18790/api/v1/management/users", "secret")).status).toBe(404);
    expect((await get("http://127.0.0.1:18790/api/v1/me")).status).toBe(401);
  });

  it("rejects valid privileged credentials and proxies only consumers", async () => {
    const origin = createServer((request, response) => {
      const role = request.headers.authorization === "Bearer consumer" ? "consumer" : "agent";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { user: { role } } }));
    });
    servers.push(origin);
    await new Promise<void>((resolve) => origin.listen(18791, "127.0.0.1", resolve));
    const gateway = new SharedHostGateway({ target: new URL("http://127.0.0.1:18791"), port: 18792 });
    gateways.push(gateway);
    await gateway.start();
    expect((await get("http://127.0.0.1:18792/api/v1/me", "agent")).status).toBe(403);
    expect((await get("http://127.0.0.1:18792/api/v1/me", "consumer")).status).toBe(200);
  });
});

function get(url: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    call.once("error", reject);
    call.end();
  });
}
