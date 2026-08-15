import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
export type TailscaleRunner = (args: readonly string[]) => Promise<{ stdout: string }>;
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export type TailscaleFunnelState = "online" | "off" | "needs-login" | "unavailable" | "error";
export interface TailscaleFunnelStatus {
  state: TailscaleFunnelState;
  available: boolean;
  enabled: boolean;
  connected: boolean;
  publicUrl?: string;
  dnsName?: string;
  target: string;
  version?: string;
  backendState?: string;
  message?: string;
  configuration?: Record<string, unknown>;
}
export interface TailscaleFunnelManagerOptions {
  target: URL;
  httpsPort?: 443 | 8443 | 10000;
  executable?: string;
  runner?: TailscaleRunner;
}

/** Owns the complete local Tailscale Funnel lifecycle. The app talks only to
 * the installed daemon/CLI; friends connect over public HTTPS without joining
 * the tailnet. */
export class TailscaleFunnelManager {
  readonly #target: URL;
  readonly #httpsPort: 443 | 8443 | 10000;
  readonly #runner: TailscaleRunner;

  constructor(options: TailscaleFunnelManagerOptions) {
    if (options.target.protocol !== "http:" || !isLoopback(options.target.hostname)) throw new Error("Tailscale Funnel must target a loopback HTTP gateway");
    this.#target = options.target;
    this.#httpsPort = options.httpsPort ?? 443;
    const executable = options.executable ?? resolveTailscaleExecutable();
    this.#runner = options.runner ?? (async (args) => execute(executable, [...args], { timeout: 30_000, windowsHide: true }));
  }

  async status(): Promise<TailscaleFunnelStatus> {
    let daemon: Record<string, any>;
    try { daemon = JSON.parse((await this.#runner(["status", "--json"])).stdout) as Record<string, any>; }
    catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      return { state: code === "ENOENT" ? "unavailable" : "error", available: false, enabled: false, connected: false, target: this.#target.origin, message: errorMessage(error) };
    }
    const backendState = typeof daemon.BackendState === "string" ? daemon.BackendState : "Unknown";
    const self = isRecord(daemon.Self) ? daemon.Self : {};
    const dnsName = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : undefined;
    const version = typeof daemon.Version === "string" ? daemon.Version : undefined;
    if (backendState !== "Running") return { state: backendState === "NeedsLogin" ? "needs-login" : "off", available: true, enabled: false, connected: false, target: this.#target.origin, backendState, ...(dnsName ? { dnsName } : {}), ...(version ? { version } : {}) };
    try {
      const configuration = JSON.parse((await this.#runner(["funnel", "status", "--json"])).stdout || "{}") as Record<string, unknown>;
      const publicUrl = configuredFunnelUrl(configuration, dnsName, this.#httpsPort, this.#target.origin);
      return { state: publicUrl ? "online" : "off", available: true, enabled: Boolean(publicUrl), connected: true, target: this.#target.origin, backendState, ...(publicUrl ? { publicUrl } : {}), ...(dnsName ? { dnsName } : {}), ...(version ? { version } : {}), configuration };
    } catch (error) {
      return { state: "error", available: true, enabled: false, connected: true, target: this.#target.origin, backendState, ...(dnsName ? { dnsName } : {}), ...(version ? { version } : {}), message: errorMessage(error) };
    }
  }

  async enable(): Promise<TailscaleFunnelStatus> {
    const before = await this.status();
    if (!before.available) throw new Error(before.message ?? "Tailscale is not installed");
    if (!before.connected) throw new Error("Sign in to Tailscale on this PC before enabling Fitz Hosting");
    await this.#runner(["funnel", `--https=${this.#httpsPort}`, "--bg", "--yes", this.#target.origin]);
    const after = await this.status();
    if (!after.enabled) throw new Error(after.message ?? "Tailscale Funnel did not expose the Fitz gateway");
    return after;
  }

  async disable(): Promise<TailscaleFunnelStatus> {
    await this.#runner(["funnel", `--https=${this.#httpsPort}`, this.#target.origin, "off"]);
    return this.status();
  }
}

function configuredFunnelUrl(configuration: Record<string, unknown>, dnsName: string | undefined, port: number, target: string): string | undefined {
  const allow = isRecord(configuration.AllowFunnel) ? configuration.AllowFunnel : {};
  const web = isRecord(configuration.Web) ? configuration.Web : {};
  const candidates = Object.entries(allow).filter(([, enabled]) => enabled === true).map(([host]) => host);
  for (const host of candidates) {
    const site = web[host];
    if (!isRecord(site) || !isRecord(site.Handlers)) continue;
    const root = site.Handlers["/"];
    if (!isRecord(root) || normalizeOrigin(root.Proxy) !== target) continue;
    return `https://${host.replace(/:443$/, "")}`;
  }
  if (!dnsName) return undefined;
  const host = port === 443 ? dnsName : `${dnsName}:${port}`;
  const site = web[host];
  if (!isRecord(site) || !isRecord(site.Handlers) || !isRecord(site.Handlers["/"]) || normalizeOrigin(site.Handlers["/"].Proxy) !== target) return undefined;
  return `https://${host}`;
}
function normalizeOrigin(value: unknown): string | undefined { if (typeof value !== "string") return undefined; try { return new URL(value).origin; } catch { return undefined; } }
function resolveTailscaleExecutable(): string { const programFiles = process.env.ProgramFiles; const installed = programFiles ? join(programFiles, "Tailscale", "tailscale.exe") : undefined; return installed && existsSync(installed) ? installed : "tailscale"; }
function isLoopback(value: string): boolean { const host = value.replace(/^\[|\]$/g, "").toLowerCase(); return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
