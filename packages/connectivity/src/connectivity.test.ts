import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./reconnect.js";
import { TailscaleMonitor, TailscaleServeManager } from "./tailscale.js";
import { WindowsStartupManager } from "./windows-startup.js";
describe("connectivity", () => { it("normalizes Tailscale JSON status", async () => { const monitor = new TailscaleMonitor(async () => ({ stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "fitz.tail.test.", TailscaleIPs: ["100.64.0.1", "fd7a::1"] } }) })); await expect(monitor.status()).resolves.toEqual({ state: "connected", backendState: "Running", dnsName: "fitz.tail.test", addresses: ["100.64.0.1", "fd7a::1"] }); }); it("renders private HTTPS Serve commands without exposing the host directly", async () => { const calls: readonly string[][] = []; const manager = new TailscaleServeManager(async (args) => { (calls as string[][]).push([...args]); return { stdout: "{}" }; }); await manager.enable(8787); await manager.disable(); expect(calls).toEqual([["serve", "--https=443", "--bg", "--yes", "http://127.0.0.1:8787"], ["serve", "--https=443", "off"]]); }); it("uses bounded exponential reconnect delays", () => { expect(reconnectDelay(0, () => 0.5)).toBe(500); expect(reconnectDelay(100, () => 0.5)).toBe(15_000); }); });

describe("Windows startup", () => {
  it("installs and removes a per-user hidden host launcher", async () => {
    const calls: string[][] = [];
    let configured = false;
    const manager = new WindowsStartupManager("C:\\Fitz Host\\start-host.ps1", async (args) => {
      calls.push([...args]);
      if (args[0] === "add") configured = true;
      if (args[0] === "delete") configured = false;
      if (args[0] === "query" && !configured) throw new Error("not found");
      return { stdout: configured ? "FitzCodexHost REG_SZ command" : "" };
    }, "win32", () => true);
    expect(await manager.status()).toEqual(expect.objectContaining({ available: true, configured: false }));
    expect(await manager.install()).toEqual(expect.objectContaining({ configured: true }));
    expect(await manager.remove()).toEqual(expect.objectContaining({ configured: false }));
    expect(calls.find((args) => args[0] === "add")?.join(" ")).toContain("-WindowStyle Hidden");
  });
});
