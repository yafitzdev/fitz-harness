import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { SharedHostGateway } from "./shared-host-gateway.js";

export interface ShareFitzConfiguration { publicUrl: string; tunnelToken: string }
export interface ShareFitzStatus {
  state: "disabled" | "starting" | "connected" | "error";
  available: boolean;
  configured: boolean;
  publicUrl?: string;
  origin: string;
  message?: string;
}
export type CloudflaredSpawner = (executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) => ChildProcess;

/** Owns the bundled cloudflared child without ever placing the tunnel token in
 * argv, logs, renderer-visible status, or the host database. */
export class CloudflareShareManager {
  readonly #gateway: SharedHostGateway;
  readonly #executable: string;
  readonly #spawn: CloudflaredSpawner;
  readonly #manageGateway: boolean;
  #process: ChildProcess | undefined;
  #state: ShareFitzStatus["state"] = "disabled";
  #publicUrl: string | undefined;
  #message: string | undefined;
  #stopping = false;

  constructor(options: { gateway: SharedHostGateway; executable: string; spawn?: CloudflaredSpawner; manageGateway?: boolean }) {
    this.#gateway = options.gateway;
    this.#executable = options.executable;
    this.#spawn = options.spawn ?? ((executable, args, environment) => spawn(executable, [...args], {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    this.#manageGateway = options.manageGateway ?? true;
  }

  status(configured = false): ShareFitzStatus {
    return {
      state: this.#state,
      available: this.#executable === "cloudflared" || existsSync(this.#executable),
      configured,
      origin: this.#gateway.origin,
      ...(this.#publicUrl ? { publicUrl: this.#publicUrl } : {}),
      ...(this.#message ? { message: this.#message } : {}),
    };
  }

  async start(configuration: ShareFitzConfiguration): Promise<ShareFitzStatus> {
    const publicUrl = requirePublicHttpsUrl(configuration.publicUrl);
    const token = requireTunnelToken(configuration.tunnelToken);
    if (this.#process) await this.stop();
    if (this.#executable !== "cloudflared" && !existsSync(this.#executable)) throw new Error("The bundled Cloudflare Tunnel runtime is missing; reinstall Fitz");
    await this.#gateway.start();
    this.#state = "starting";
    this.#publicUrl = publicUrl;
    this.#message = "Connecting the encrypted outbound tunnel…";
    this.#stopping = false;
    try {
      const child = this.#spawn(this.#executable, ["tunnel", "--no-autoupdate", "--loglevel", "info", "run"], {
        ...process.env,
        TUNNEL_TOKEN: token,
        TUNNEL_URL: this.#gateway.origin,
      });
      this.#process = child;
      let buffered = "";
      const observe = (chunk: Buffer | string) => {
        buffered = `${buffered}${chunk.toString()}`.slice(-16_384);
        if (/registered tunnel connection|connection .* registered/i.test(buffered)) {
          this.#state = "connected";
          this.#message = "Share Fitz is online";
        }
      };
      child.stdout?.on("data", observe);
      child.stderr?.on("data", observe);
      child.once("error", (error) => {
        if (this.#process !== child) return;
        this.#process = undefined;
        this.#state = "error";
        this.#message = safeProcessError(error);
        if (this.#manageGateway) void this.#gateway.stop().catch(() => undefined);
      });
      child.once("exit", (code) => {
        if (this.#process !== child) return;
        this.#process = undefined;
        if (this.#stopping) {
          this.#state = "disabled";
          this.#message = undefined;
        } else {
          this.#state = "error";
          this.#message = `Cloudflare Tunnel stopped unexpectedly${code === null ? "" : ` (exit ${code})`}`;
        }
        if (this.#manageGateway) void this.#gateway.stop().catch(() => undefined);
      });
      return this.status(true);
    } catch (error) {
      this.#state = "error";
      this.#message = safeProcessError(error);
      if (this.#manageGateway) await this.#gateway.stop().catch(() => undefined);
      throw new Error(this.#message);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#process;
    this.#process = undefined;
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        if (!child.kill()) { clearTimeout(timer); resolve(); }
      });
    }
    if (this.#manageGateway) await this.#gateway.stop();
    this.#state = "disabled";
    this.#message = undefined;
  }
}

export function requirePublicHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("A public HTTPS URL is required");
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("The public host must be an HTTPS origin without credentials, path, query, or fragment");
  }
  if (isLocalName(url.hostname)) throw new Error("The public host cannot be a local address");
  return url.origin;
}
function requireTunnelToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /\s/.test(value)) throw new Error("A valid Cloudflare Tunnel token is required");
  return value;
}
function isLocalName(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}
function safeProcessError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  return code === "ENOENT" ? "The Cloudflare Tunnel runtime is unavailable" : "Cloudflare Tunnel could not start";
}
