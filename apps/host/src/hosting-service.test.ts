import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FitzConfigService } from "@fitz/config";
import type { SharedHostGateway, TailscaleFunnelManager, WindowsStartupManager } from "@fitz/connectivity";
import { HostingService } from "./hosting-service.js";

function fixture(initialFunnel = false, existingConfiguration = false) {
  const path = join(mkdtempSync(join(tmpdir(), "fitz-hosting-")), "fitz.config.json");
  const firstConfig = new FitzConfigService({ path });
  const config = existingConfiguration ? new FitzConfigService({ path }) : firstConfig;
  let gatewayRunning = false; let funnelEnabled = initialFunnel; let startupConfigured = false;
  const gateway = { origin: "http://127.0.0.1:8790", get running() { return gatewayRunning; }, start: vi.fn(async () => { gatewayRunning = true; }), stop: vi.fn(async () => { gatewayRunning = false; }) } as unknown as SharedHostGateway;
  const funnelStatus = () => ({ state: funnelEnabled ? "online" : "off", available: true, enabled: funnelEnabled, connected: true, target: "http://127.0.0.1:8790", ...(funnelEnabled ? { publicUrl: "https://yan.example.ts.net" } : {}) });
  const funnel = { status: vi.fn(async () => funnelStatus()), enable: vi.fn(async () => { funnelEnabled = true; return funnelStatus(); }), disable: vi.fn(async () => { funnelEnabled = false; return funnelStatus(); }) } as unknown as TailscaleFunnelManager;
  const startup = { status: vi.fn(async () => ({ available: true, configured: startupConfigured, launcherPath: "C:\\Fitz\\start-host.ps1" })), install: vi.fn(async () => { startupConfigured = true; return { available: true, configured: true, launcherPath: "C:\\Fitz\\start-host.ps1" }; }), remove: vi.fn(async () => { startupConfigured = false; return { available: true, configured: false, launcherPath: "C:\\Fitz\\start-host.ps1" }; }) } as unknown as WindowsStartupManager;
  return { config, gateway, funnel, startup, service: new HostingService({ config, gateway, funnel, startup }) };
}

describe("HostingService", () => {
  it("adopts an existing Fitz Funnel and makes the canonical state authoritative", async () => {
    const { service, config, gateway } = fixture(true);
    const status = await service.initialize();
    expect(status.online).toBe(true); expect(config.read().hosting.enabled).toBe(true); expect(gateway.start).toHaveBeenCalledOnce();
    await service.close();
  });

  it("honors an existing canonical off switch instead of re-adopting a stale Funnel", async () => {
    const { service, config, funnel } = fixture(true, true);
    const status = await service.initialize();
    expect(status.enabled).toBe(false); expect(config.read().hosting.enabled).toBe(false); expect(funnel.disable).toHaveBeenCalledOnce();
    await service.close();
  });

  it("reconciles the master switch and startup setting", async () => {
    const { service, config, funnel, startup } = fixture(false); await service.initialize();
    await service.update({ hosting: { enabled: true, startAtLogin: true } });
    expect(funnel.enable).toHaveBeenCalledOnce(); expect(startup.install).toHaveBeenCalledOnce(); expect(config.read().hosting).toMatchObject({ enabled: true, startAtLogin: true });
    await service.update({ hosting: { enabled: false } }); expect(funnel.disable).toHaveBeenCalledOnce();
    await service.close();
  });

  it("marks port changes as requiring a restart instead of applying mismatched runtime state", async () => {
    const { service, config, funnel } = fixture(false); await service.initialize();
    const status = await service.update({ hosting: { enabled: true, publicPort: 8443 } });
    expect(status.restartRequired).toBe(true); expect(config.read().hosting.publicPort).toBe(8443);
    expect(funnel.enable).not.toHaveBeenCalled();
    await expect(service.repair()).rejects.toThrow(/Restart Fitz/);
    await service.close();
  });

  it("still closes the active Funnel when disabling alongside a port change", async () => {
    const { service, config, funnel } = fixture(true); await service.initialize();
    const status = await service.update({ hosting: { enabled: false, publicPort: 8443 } });
    expect(status.enabled).toBe(false); expect(config.read().hosting.publicPort).toBe(8443); expect(funnel.disable).toHaveBeenCalledOnce();
    await service.close();
  });

  it("rolls back Funnel and startup changes when the canonical config cannot be persisted", async () => {
    const { service, config, funnel, startup } = fixture(false); await service.initialize();
    vi.spyOn(config, "update").mockImplementationOnce(() => { throw new Error("disk full"); });

    await expect(service.update({ hosting: { enabled: true, startAtLogin: true } })).rejects.toThrow("disk full");

    expect(funnel.enable).toHaveBeenCalledOnce();
    expect(funnel.disable).toHaveBeenCalledOnce();
    expect(startup.install).toHaveBeenCalledOnce();
    expect(startup.remove).toHaveBeenCalledOnce();
    expect(config.read().hosting).toMatchObject({ enabled: false, startAtLogin: false });
    await service.close();
  });
});
