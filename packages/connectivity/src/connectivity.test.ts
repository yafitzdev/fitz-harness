import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./reconnect.js";
import { TailscaleFunnelManager } from "./tailscale.js";
import { WindowsStartupManager } from "./windows-startup.js";
describe("connectivity", () => { it("uses bounded exponential reconnect delays", () => { expect(reconnectDelay(0, () => 0.5)).toBe(500); expect(reconnectDelay(100, () => 0.5)).toBe(15_000); }); });

describe("TailscaleFunnelManager", () => {
  it("enables and disables only a Funnel targeting the protected gateway", async () => {
    const calls: string[][] = [];
    let enabled = false;
    const manager = new TailscaleFunnelManager({ target: new URL("http://127.0.0.1:8790"), runner: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") return { stdout: JSON.stringify({ BackendState: "Running", Version: "1.102.2", Self: { DNSName: "fitz.tail.test." } }) };
      if (args[0] === "funnel" && args.at(-1) === "off") { enabled = false; return { stdout: "" }; }
      if (args[0] === "funnel" && args[1] === "--https=443") { enabled = true; return { stdout: "" }; }
      return { stdout: enabled ? JSON.stringify({ Web: { "fitz.tail.test:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8790" } } } }, AllowFunnel: { "fitz.tail.test:443": true } }) : "{}" };
    } });
    await expect(manager.enable()).resolves.toMatchObject({ state: "online", publicUrl: "https://fitz.tail.test" });
    await expect(manager.disable()).resolves.toMatchObject({ state: "off", enabled: false });
    expect(calls).toContainEqual(["funnel", "--https=443", "--bg", "--yes", "http://127.0.0.1:8790"]);
    expect(calls).toContainEqual(["funnel", "--https=443", "http://127.0.0.1:8790", "off"]);
  });
});

describe("Windows startup", () => {
  it("installs and removes a per-user hidden host launcher", async () => {
    const calls: string[][] = [];
    let configured = false;
    const manager = new WindowsStartupManager("C:\\Fitz Host\\start-host.ps1", async (args) => {
      calls.push([...args]);
      if (args[0] === "add") configured = true;
      if (args[0] === "delete") configured = false;
      if (args[0] === "query" && !configured) throw new Error("not found");
      return { stdout: configured ? "FitzHarnessHost REG_SZ command" : "" };
    }, "win32", () => true);
    expect(await manager.status()).toEqual(expect.objectContaining({ available: true, configured: false }));
    expect(await manager.install()).toEqual(expect.objectContaining({ configured: true }));
    expect(await manager.remove()).toEqual(expect.objectContaining({ configured: false }));
    expect(calls.find((args) => args[0] === "add")?.join(" ")).toContain("-WindowStyle Hidden");
  });
});
