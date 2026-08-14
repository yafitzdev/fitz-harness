import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION } from "@fitz/protocol";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PAIRING_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 600;
const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 10;
const MAX_WARM_REQUESTS_PER_WINDOW = 4;
const MAX_CONCURRENT_PER_CLIENT = 32;
const MAX_TRACKED_CLIENTS = 10_000;

export interface SharedHostGatewayOptions {
  target: URL;
  port?: number;
  host?: string;
  now?: () => number;
}

/** A loopback-only, fail-closed reverse proxy used as cloudflared's origin. */
export class SharedHostGateway {
  readonly #target: URL;
  readonly #port: number;
  readonly #host: string;
  readonly #now: () => number;
  readonly #windows = new Map<string, number[]>();
  readonly #pairingWindows = new Map<string, number[]>();
  readonly #warmWindows = new Map<string, number[]>();
  readonly #concurrent = new Map<string, number>();
  #server: Server | undefined;

  constructor(options: SharedHostGatewayOptions) {
    if (options.target.protocol !== "http:" || !isLoopback(options.target.hostname)) {
      throw new Error("The shared gateway target must be a loopback HTTP Fitz host");
    }
    this.#target = options.target;
    this.#port = options.port ?? 8790;
    this.#host = options.host ?? "127.0.0.1";
    this.#now = options.now ?? Date.now;
  }

  get origin(): string { return `http://${this.#host}:${this.#port}`; }
  get running(): boolean { return Boolean(this.#server?.listening); }

  async start(): Promise<void> {
    if (this.#server?.listening) return;
    const server = createServer((request, response) => { void this.#handle(request, response).catch(() => sendJson(response, 502, { error: "The shared-host gateway failed" })); });
    server.requestTimeout = 0; // Agent SSE streams may legitimately be long-lived.
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
    const url = safeRequestUrl(request.url);
    if (!url) return sendJson(response, 400, { error: "Invalid request URL" });
    const path = url.pathname;
    const client = clientIdentity(request);
    if (!this.#admit(this.#windows, client, MAX_REQUESTS_PER_WINDOW)) return sendJson(response, 429, { error: "Shared-host request rate exceeded" }, { "retry-after": "60" });

    if (method === "GET" && path === "/health") {
      const healthy = await this.#hostIsHealthy();
      return sendJson(response, healthy ? 200 : 503, healthy
        ? { status: "ok", protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION }
        : { status: "unavailable", protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION });
    }
    const pairing = method === "POST" && path === "/api/v1/pairing/redeem-shared";
    if (!pairing && !hasBearer(request.headers.authorization)) return sendJson(response, 401, { error: "Valid device bearer token required" });
    if (!isAllowedSharedRequest(method, path)) return sendJson(response, 404, { error: "This endpoint is unavailable through Share Fitz" });
    if (pairing && !this.#admit(this.#pairingWindows, client, MAX_PAIRING_ATTEMPTS_PER_WINDOW)) return sendJson(response, 429, { error: "Too many pairing attempts" }, { "retry-after": "60" });
    if (method === "POST" && path === "/api/v1/inference/warm" && !this.#admit(this.#warmWindows, client, MAX_WARM_REQUESTS_PER_WINDOW)) return sendJson(response, 429, { error: "Too many model warm requests" }, { "retry-after": "60" });
    if (!pairing && !await this.#isConsumer(request.headers.authorization as string)) return sendJson(response, 403, { error: "Share Fitz accepts consumer credentials only" });
    const active = this.#concurrent.get(client) ?? 0;
    if (active >= MAX_CONCURRENT_PER_CLIENT) return sendJson(response, 429, { error: "Too many concurrent shared-host requests" }, { "retry-after": "2" });
    this.#concurrent.set(client, active + 1);
    this.#proxy(request, response, url, pairing ? MAX_PAIRING_BYTES : MAX_REQUEST_BYTES, client);
  }

  async #isConsumer(authorization: string): Promise<boolean> {
    try {
      const response = await fetch(new URL("/api/v1/me", this.#target), { headers: { authorization }, signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return false;
      const body = await response.json() as { data?: { user?: { role?: unknown } } };
      return body.data?.user?.role === "consumer";
    } catch { return false; }
  }

  async #hostIsHealthy(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/health", this.#target), { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return false;
      const body = await response.json() as { protocolVersion?: unknown; hostContractVersion?: unknown };
      return body.protocolVersion === PROTOCOL_VERSION && body.hostContractVersion === HOST_CONTRACT_VERSION;
    } catch { return false; }
  }

  #admit(windows: Map<string, number[]>, client: string, maximum: number): boolean {
    const cutoff = this.#now() - RATE_WINDOW_MS;
    if (!windows.has(client) && windows.size >= MAX_TRACKED_CLIENTS) {
      for (const [key, times] of windows) {
        if ((times.at(-1) ?? 0) <= cutoff) windows.delete(key);
      }
      if (windows.size >= MAX_TRACKED_CLIENTS) return false;
    }
    const recent = (windows.get(client) ?? []).filter((time) => time > cutoff);
    if (recent.length >= maximum) { windows.set(client, recent); return false; }
    recent.push(this.#now());
    windows.set(client, recent);
    return true;
  }

  #proxy(incoming: IncomingMessage, outgoing: ServerResponse, url: URL, maximumBytes: number, client: string): void {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      const next = Math.max(0, (this.#concurrent.get(client) ?? 1) - 1);
      if (next) this.#concurrent.set(client, next); else this.#concurrent.delete(client);
    };
    outgoing.once("close", release);
    const headers: Record<string, string> = {
      host: this.#target.host,
      ...(typeof incoming.headers.authorization === "string" ? { authorization: incoming.headers.authorization } : {}),
      ...(typeof incoming.headers.accept === "string" ? { accept: incoming.headers.accept } : {}),
      ...(typeof incoming.headers["content-type"] === "string" ? { "content-type": incoming.headers["content-type"] } : {}),
      ...(typeof incoming.headers["last-event-id"] === "string" ? { "last-event-id": incoming.headers["last-event-id"] } : {}),
    };
    const declared = Number(incoming.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maximumBytes) {
      release();
      return sendJson(outgoing, 413, { error: "Request body is too large" });
    }
    const proxy = httpRequest({
      protocol: this.#target.protocol,
      hostname: this.#target.hostname,
      port: this.#target.port,
      method: incoming.method,
      path: `${url.pathname}${url.search}`,
      headers,
    }, (origin) => {
      outgoing.statusCode = origin.statusCode ?? 502;
      for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "retry-after", "etag"]) {
        const value = origin.headers[name];
        if (value !== undefined) outgoing.setHeader(name, value);
      }
      origin.once("error", () => { if (!outgoing.headersSent) sendJson(outgoing, 502, { error: "The Fitz host response failed" }); else outgoing.destroy(); });
      origin.pipe(outgoing);
    });
    proxy.once("error", () => { release(); if (!outgoing.headersSent) sendJson(outgoing, 502, { error: "The Fitz host is unavailable" }); else outgoing.destroy(); });
    incoming.once("aborted", () => proxy.destroy());
    let received = 0;
    incoming.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maximumBytes) {
        proxy.destroy();
        if (!outgoing.headersSent) sendJson(outgoing, 413, { error: "Request body is too large" });
        incoming.destroy();
      } else proxy.write(chunk);
    });
    incoming.once("end", () => proxy.end());
    incoming.once("error", () => proxy.destroy());
  }
}

export function isAllowedSharedRequest(method: string, path: string): boolean {
  if (path === "/api/v1/pairing/redeem-shared") return method === "POST";
  if (path === "/api/v1/me" || path === "/api/v1/configuration") return method === "GET";
  if (path === "/api/v1/inference/warm") return method === "POST";
  if (path === "/v1/models") return method === "GET";
  if (["/v1/chat/completions", "/v1/images/generations", "/v1/videos/generations", "/v1/audio/generations"].includes(path)) return method === "POST";
  if (path === "/api/v1/chats") return method === "GET" || method === "POST";
  if (path === "/api/v1/projects") return method === "GET"; // No remote host-path creation.
  if (/^\/api\/v1\/projects\/[^/]+(?:\/sessions)?$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:transcript|agent-run-state)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:messages|compact)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/sessions\/[^/]+\/(?:artifacts|tool-approvals)$/.test(path)) return method === "GET" || method === "POST";
  if (path === "/api/v1/agent/runs") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/agent\/runs\/[^/]+$/.test(path)) return method === "GET" || method === "DELETE";
  if (/^\/api\/v1\/agent\/runs\/[^/]+\/(?:usage|events)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/agent\/runs\/[^/]+\/(?:steer|resume)$/.test(path)) return method === "POST";
  if (path === "/api/v1/work/queue") return method === "GET";
  if (/^\/api\/v1\/work\/queue\/[^/]+$/.test(path)) return method === "DELETE";
  if (path === "/api/v1/media/jobs") return method === "GET" || method === "POST";
  if (/^\/api\/v1\/media\/jobs\/[^/]+$/.test(path) || /^\/api\/v1\/media\/jobs\/[^/]+\/(?:lineage|events)$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/media\/jobs\/[^/]+\/(?:edits|animations|cancel|retry)$/.test(path)) return method === "POST";
  if (/^\/api\/v1\/artifacts\/[^/]+\/content$/.test(path)) return method === "GET";
  if (/^\/api\/v1\/tool-approvals\/[^/]+\/decision$/.test(path)) return method === "POST";
  return false;
}

function safeRequestUrl(value: string | undefined): URL | undefined {
  try {
    if (!value?.startsWith("/") || value.startsWith("//")) return undefined;
    const url = new URL(value, "http://shared.fitz.invalid");
    if (url.origin !== "http://shared.fitz.invalid" || url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}
function hasBearer(value: string | string[] | undefined): boolean { return typeof value === "string" && /^Bearer\s+\S+$/i.test(value); }
function clientIdentity(request: IncomingMessage): string {
  const cloudflare = request.headers["cf-connecting-ip"];
  return typeof cloudflare === "string" && cloudflare.length <= 64 ? cloudflare : request.socket.remoteAddress ?? "unknown";
}
function isLoopback(value: string): boolean { const host = value.replace(/^\[|\]$/g, "").toLowerCase(); return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}
