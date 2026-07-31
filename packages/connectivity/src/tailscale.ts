import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export type TailscaleState = "connected" | "needs-login" | "stopped" | "unavailable" | "error";
export interface TailscaleStatus { state: TailscaleState; backendState?: string; dnsName?: string; addresses: string[]; message?: string }
export type TailscaleCommand = () => Promise<{ stdout: string }>;
export class TailscaleMonitor { constructor(private readonly command: TailscaleCommand = async () => execute("tailscale", ["status", "--json"], { timeout: 5000, windowsHide: true })) {}
  async status(): Promise<TailscaleStatus> { try { const { stdout } = await this.command(); const value = JSON.parse(stdout) as Record<string, unknown>; const backendState = typeof value.BackendState === "string" ? value.BackendState : "Unknown"; const self = isRecord(value.Self) ? value.Self : {}; const state: TailscaleState = backendState === "Running" ? "connected" : backendState === "NeedsLogin" ? "needs-login" : "stopped"; return { state, backendState, addresses: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((item): item is string => typeof item === "string") : [], ...(typeof self.DNSName === "string" ? { dnsName: self.DNSName.replace(/\.$/, "") } : {}) }; } catch (error) { const code = isRecord(error) ? error.code : undefined; return { state: code === "ENOENT" ? "unavailable" : "error", addresses: [], message: error instanceof Error ? error.message : String(error) }; } }
}
export type TailscaleRunner = (args: readonly string[]) => Promise<{ stdout: string }>;
export class TailscaleServeManager {
  constructor(private readonly runner: TailscaleRunner = async (args) => execute("tailscale", [...args], { timeout: 15_000, windowsHide: true })) {}
  async status(): Promise<Record<string, unknown>> { const { stdout } = await this.runner(["serve", "status", "--json"]); return JSON.parse(stdout) as Record<string, unknown>; }
  async enable(localPort: number, httpsPort = 443): Promise<void> { validatePort(localPort); validatePort(httpsPort); await this.runner(["serve", `--https=${httpsPort}`, "--bg", "--yes", `http://127.0.0.1:${localPort}`]); }
  async disable(httpsPort = 443): Promise<void> { validatePort(httpsPort); await this.runner(["serve", `--https=${httpsPort}`, "off"]); }
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validatePort(value: number): void { if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`Invalid port: ${value}`); }
