import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION } from "@fitz/protocol";
import { SharedHostGateway, isAllowedSharedRequest } from "./shared-host-gateway.js";

const gateways: SharedHostGateway[] = [];
const servers: Server[] = [];
afterEach(async () => { await Promise.all(gateways.splice(0).map((gateway) => gateway.stop())); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("Fitz Hosting gateway", () => {
  it("exposes only consumer operations and no public pairing or administration", () => {
    expect(isAllowedSharedRequest("POST", "/api/v1/pairing/redeem-shared")).toBe(false);
    expect(isAllowedSharedRequest("GET", "/api/v1/projects")).toBe(true);
    expect(isAllowedSharedRequest("POST", "/api/v1/projects")).toBe(false);
    expect(isAllowedSharedRequest("GET", "/api/v1/management/users")).toBe(false);
    expect(isAllowedSharedRequest("POST", "/api/v1/pairing/bootstrap")).toBe(false);
  });

  it("requires a consumer key even for its minimal health response", async () => {
    const origin = createServer((incoming, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(incoming.url === "/api/v1/me" ? { data: { user: { role: "consumer" } } } : { protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION })); });
    servers.push(origin); await new Promise<void>((resolve) => origin.listen(19789, "127.0.0.1", resolve));
    const gateway = new SharedHostGateway({ target: new URL("http://127.0.0.1:19789"), port: 19790 }); gateways.push(gateway); await gateway.start();
    expect((await get("http://127.0.0.1:19790/health")).status).toBe(401);
    const health = await get("http://127.0.0.1:19790/health", "consumer");
    expect(health.status).toBe(200); expect(JSON.parse(health.body)).toEqual(expect.objectContaining({ status: "ok", protocolVersion: expect.any(String), hostContractVersion: expect.any(String) })); expect(JSON.parse(health.body)).not.toHaveProperty("resources");
    expect((await get("http://127.0.0.1:19790/api/v1/me")).status).toBe(401);
    expect((await get("http://127.0.0.1:19790/api/v1/management/users", "secret")).status).toBe(404);
  });

  it("rejects privileged keys and proxies only consumer keys", async () => {
    const origin = createServer((incoming, response) => { const role = incoming.headers.authorization === "Bearer consumer" ? "consumer" : "agent"; response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: { user: { role } } })); });
    servers.push(origin); await new Promise<void>((resolve) => origin.listen(19791, "127.0.0.1", resolve));
    const gateway = new SharedHostGateway({ target: new URL("http://127.0.0.1:19791"), port: 19792 }); gateways.push(gateway); await gateway.start();
    expect((await get("http://127.0.0.1:19792/api/v1/me", "agent")).status).toBe(403);
    expect((await get("http://127.0.0.1:19792/api/v1/me", "consumer")).status).toBe(200);
  });

  it("preserves byte ranges needed for remote media and artifact playback", async () => {
    let receivedRange: string | undefined;
    const origin = createServer((incoming, response) => {
      if (incoming.url === "/api/v1/me") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { user: { role: "consumer" } } }));
        return;
      }
      receivedRange = incoming.headers.range;
      response.writeHead(206, { "content-type": "audio/mpeg", "accept-ranges": "bytes", "content-range": "bytes 2-5/16" });
      response.end("2345");
    });
    servers.push(origin); await new Promise<void>((resolve) => origin.listen(19793, "127.0.0.1", resolve));
    const gateway = new SharedHostGateway({ target: new URL("http://127.0.0.1:19793"), port: 19794 }); gateways.push(gateway); await gateway.start();

    const result = await get("http://127.0.0.1:19794/api/v1/artifacts/example/content", "consumer", { range: "bytes=2-5" });
    expect(result.status).toBe(206); expect(result.body).toBe("2345"); expect(receivedRange).toBe("bytes=2-5"); expect(result.headers["content-range"]).toBe("bytes 2-5/16");
  });
});

function get(url: string, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> { return new Promise((resolve, reject) => { const call = request(url, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers })); }); call.once("error", reject); call.end(); }); }
