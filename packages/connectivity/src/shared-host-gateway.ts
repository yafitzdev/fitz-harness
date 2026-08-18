import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION } from "@fitz/protocol";

const MAX_BODY = 8 * 1024 * 1024;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 600;
const MAX_GLOBAL_REQUESTS = 1_200;
const MAX_WARM_REQUESTS = 4;
const MAX_CONCURRENT = 32;
const MAX_AUTHENTICATIONS = 32;
const MAX_TRACKED_CLIENTS = 10_000;

export interface SharedHostGatewayOptions { target: URL; port?: number; host?: string; now?: () => number }

/** Loopback-only, consumer-only reverse proxy. Public tunnel providers target
 * this gateway and can never reach the raw administrative host. */
export class SharedHostGateway {
  readonly #target: URL;
  readonly #port: number;
  readonly #host: string;
  readonly #now: () => number;
  readonly #requests = new Map<string, number[]>();
  readonly #warming = new Map<string, number[]>();
  readonly #concurrent = new Map<string, number>();
  #authentications = 0;
  #server: Server | undefined;

  constructor(options: SharedHostGatewayOptions) {
    if (options.target.protocol !== "http:" || !isLoopback(options.target.hostname)) throw new Error("The sharing gateway target must be a loopback HTTP Fitz host");
    this.#target = options.target;
    this.#port = options.port ?? 8790;
    this.#host = options.host ?? "127.0.0.1";
    this.#now = options.now ?? Date.now;
  }

  get origin(): string { return `http://${this.#host}:${this.#port}`; }
  get running(): boolean { return Boolean(this.#server?.listening); }

  async start(): Promise<void> {
    if (this.running) return;
    const server = createServer((request, response) => { void this.#handle(request, response).catch(() => sendJson(response, 502, { error: "The sharing gateway failed" })); });
    // Long inference responses remain unlimited, but clients must finish
    // sending their request body promptly to avoid slow-body slot exhaustion.
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => { server.off("error", reject); resolve(); });
    });
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const method = (request.method ?? "GET").toUpperCase();
    const url = requestUrl(request.url);
    if (!url) return sendJson(response, 400, { error: "Invalid request URL" });
    const client = clientIdentity(request);
    if (!this.#admit(this.#requests, "global", MAX_GLOBAL_REQUESTS)) return sendJson(response, 429, { error: "Hosting request capacity exceeded" }, { "retry-after": "60" });
    if (!this.#admit(this.#requests, client, MAX_REQUESTS)) return sendJson(response, 429, { error: "Request rate exceeded" }, { "retry-after": "60" });
    if (!hasBearer(request.headers.authorization)) return sendJson(response, 401, { error: "Valid API key required" });
    const healthRequest = method === "GET" && url.pathname === "/health";
    if (!healthRequest && !isAllowedSharedRequest(method, url.pathname)) return sendJson(response, 404, { error: "This endpoint is unavailable through Fitz Hosting" });
    if (method === "POST" && url.pathname === "/api/v1/inference/warm" && !this.#admit(this.#warming, client, MAX_WARM_REQUESTS)) return sendJson(response, 429, { error: "Too many model warm requests" }, { "retry-after": "60" });
    if (this.#authentications >= MAX_AUTHENTICATIONS) return sendJson(response, 429, { error: "Too many authentication attempts" }, { "retry-after": "2" });
    this.#authentications += 1;
    let consumer = false;
    try { consumer = await this.#consumer(request.headers.authorization as string); }
    finally { this.#authentications -= 1; }
    if (!consumer) return sendJson(response, 403, { error: "Fitz Hosting accepts consumer API keys only" });
    if (healthRequest) return this.#health(response);
    const active = this.#concurrent.get(client) ?? 0;
    if (active >= MAX_CONCURRENT) return sendJson(response, 429, { error: "Too many concurrent requests" }, { "retry-after": "2" });
    this.#concurrent.set(client, active + 1);
    this.#proxy(request, response, url, MAX_BODY, client);
  }

  async #health(response: ServerResponse): Promise<void> {
    try {
      const result = await fetch(new URL("/health", this.#target), { signal: AbortSignal.timeout(2_000) });
      const body = result.ok ? await result.json() as Record<string, unknown> : {};
      const healthy = body.protocolVersion === PROTOCOL_VERSION && body.hostContractVersion === HOST_CONTRACT_VERSION;
      sendJson(response, healthy ? 200 : 503, { status: healthy ? "ok" : "unavailable", protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION });
    } catch { sendJson(response, 503, { status: "unavailable", protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION }); }
  }

  async #consumer(authorization: string): Promise<boolean> {
    try {
      const response = await fetch(new URL("/api/v1/me", this.#target), { headers: { authorization }, signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return false;
      const body = await response.json() as { data?: { user?: { role?: unknown } } };
      return body.data?.user?.role === "consumer";
    } catch { return false; }
  }

  #admit(windows: Map<string, number[]>, client: string, maximum: number): boolean {
    const cutoff = this.#now() - WINDOW_MS;
    if (!windows.has(client) && windows.size >= MAX_TRACKED_CLIENTS) {
      for (const [key, values] of windows) if ((values.at(-1) ?? 0) <= cutoff) windows.delete(key);
      if (windows.size >= MAX_TRACKED_CLIENTS) return false;
    }
    const recent = (windows.get(client) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= maximum) { windows.set(client, recent); return false; }
    recent.push(this.#now()); windows.set(client, recent); return true;
  }

  #proxy(incoming: IncomingMessage, outgoing: ServerResponse, url: URL, maximumBytes: number, client: string): void {
    let released = false;
    const release = () => { if (released) return; released = true; const remaining = Math.max(0, (this.#concurrent.get(client) ?? 1) - 1); if (remaining) this.#concurrent.set(client, remaining); else this.#concurrent.delete(client); };
    outgoing.once("close", release);
    const headers: Record<string, string> = {
      host: this.#target.host,
      ...(typeof incoming.headers.authorization === "string" ? { authorization: incoming.headers.authorization } : {}),
      ...(typeof incoming.headers.accept === "string" ? { accept: incoming.headers.accept } : {}),
      ...(typeof incoming.headers["content-type"] === "string" ? { "content-type": incoming.headers["content-type"] } : {}),
      ...(typeof incoming.headers["last-event-id"] === "string" ? { "last-event-id": incoming.headers["last-event-id"] } : {}),
      ...(typeof incoming.headers.range === "string" ? { range: incoming.headers.range } : {}),
      ...(typeof incoming.headers["if-none-match"] === "string" ? { "if-none-match": incoming.headers["if-none-match"] } : {}),
    };
    const declared = Number(incoming.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maximumBytes) { release(); sendJson(outgoing, 413, { error: "Request body is too large" }); return; }
    const proxy = httpRequest({ protocol: this.#target.protocol, hostname: this.#target.hostname, port: this.#target.port, method: incoming.method, path: `${url.pathname}${url.search}`, headers }, (origin) => {
      outgoing.statusCode = origin.statusCode ?? 502;
      for (const name of ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "content-security-policy", "cache-control", "retry-after", "etag"]) { const value = origin.headers[name]; if (value !== undefined) outgoing.setHeader(name, value); }
      origin.once("error", () => outgoing.headersSent ? outgoing.destroy() : sendJson(outgoing, 502, { error: "The Fitz host response failed" }));
      origin.pipe(outgoing);
    });
    proxy.once("error", () => { release(); if (outgoing.headersSent) outgoing.destroy(); else sendJson(outgoing, 502, { error: "The Fitz host is unavailable" }); });
    incoming.once("aborted", () => proxy.destroy());
    let received = 0;
    incoming.on("data", (chunk: Buffer) => { received += chunk.length; if (received > maximumBytes) { proxy.destroy(); if (!outgoing.headersSent) sendJson(outgoing, 413, { error: "Request body is too large" }); incoming.destroy(); } else proxy.write(chunk); });
    incoming.once("end", () => proxy.end());
    incoming.once("error", () => proxy.destroy());
  }
}

export function isAllowedSharedRequest(method: string, path: string): boolean {
  if (["/api/v1/me", "/api/v1/configuration", "/v1/models"].includes(path)) return method === "GET";
  // Consumers own these records; exposing them is required for configuring
  // cloud providers from a remote Fitz desktop.
  if (["/api/v1/connections", "/api/v1/cloud-routes"].includes(path)) return method === "GET";
  if (/^\/api\/v1\/connections\/[^/]+$/.test(path)) return method === "PUT" || method === "DELETE";
  if (/^\/api\/v1\/cloud-routes\/[^/]+$/.test(path)) return method === "PUT" || method === "DELETE";
  if (path === "/api/v1/inference/warm") return method === "POST";
  if (["/v1/chat/completions", "/v1/images/generations", "/v1/videos/generations", "/v1/audio/generations"].includes(path)) return method === "POST";
  if (path === "/api/v1/chats") return method === "GET" || method === "POST";
  if (path === "/api/v1/projects") return method === "GET";
  if (/^\/api\/v1\/projects\/[^/]+(?:\/sessions)?$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:transcript|agent-run-state|query|forensics)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:messages|compact|edit|regenerate)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:artifacts|tool-approvals)$/.test(path)) return method === "GET" || method === "POST";
  if (path === "/api/v1/agent/runs") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/agent\/runs\/[^/]+$/.test(path)) return method === "GET" || method === "DELETE";
  if (/^\/api\/v1\/agent\/runs\/[^/]+\/(?:usage|events)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/agent\/runs\/[^/]+\/(?:steer|resume)$/.test(path)) return method === "POST";
  if (path === "/api/v1/work/queue") return method === "GET";
  if (/^\/api\/v1\/work\/queue\/[^/]+$/.test(path)) return method === "DELETE";
  if (path === "/api/v1/jobs") return method === "GET";
  if (/^\/api\/v1\/jobs\/[^/]+(?:\/events)?$/.test(path)) return method === "GET";
  if (path === "/api/v1/media/jobs") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/media\/jobs\/[^/]+$/.test(path) || /^\/api\/v1\/media\/jobs\/[^/]+\/(?:lineage|events)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/media\/jobs\/[^/]+\/(?:edits|animations|cancel|retry)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/artifacts\/[^/]+\/content$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/tool-approvals\/[^/]+\/decision$/.test(path)) return method === "POST";
  return false;
}

function requestUrl(value: string | undefined): URL | undefined { try { if (!value?.startsWith("/") || value.startsWith("//")) return undefined; const url = new URL(value, "http://shared.fitz.invalid"); return url.origin === "http://shared.fitz.invalid" && !url.username && !url.password ? url : undefined; } catch { return undefined; } }
function clientIdentity(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.length <= 8_192
    ? `key:${createHash("sha256").update(authorization).digest("base64url")}`
    : `socket:${request.socket.remoteAddress ?? "unknown"}`;
}
function hasBearer(value: string | string[] | undefined): boolean { return typeof value === "string" && /^Bearer\s+\S+$/i.test(value); }
function isLoopback(value: string): boolean { const host = value.replace(/^\[|\]$/g, "").toLowerCase(); return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void { if (response.writableEnded) return; response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }); response.end(JSON.stringify(body)); }
