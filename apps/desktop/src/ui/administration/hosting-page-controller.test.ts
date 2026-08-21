// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostingPageClient, HostingPageController, type HostingPageElements } from "./hosting-page-controller.js";

function node<T extends HTMLElement>(tag: string): T { const value = document.createElement(tag) as T; document.body.append(value); return value; }
function elements(): HostingPageElements {
  const enableConfirmation = node<HTMLElement>("div"); enableConfirmation.hidden = true;
  return { enabled: node("input"), enableConfirmation, cancelEnable: node("button"), confirmEnable: node("button"), stateLabel: undefined, stateMessage: undefined, publicUrl: node("code"), copyUrl: node("button"), repair: node("button"), advancedStatus: node("div"), startAtLogin: node("input"), configPath: node("code"), copyConfigPath: node("button"), configJson: node("textarea"), reloadConfig: node("button"), validateConfig: node("button"), saveConfig: node("button"), configStatus: node("p") };
}
const configuration = { version: 1, hosting: { enabled: false, provider: "tailscale-funnel", startAtLogin: false, publicPort: 443, gatewayPort: 8790 }, defaults: { route: "default", effort: "normal" } };
const status = { enabled: false, online: false, provider: "tailscale-funnel", gateway: { running: true, origin: "http://127.0.0.1:8790" }, tailscale: { connected: true, enabled: false, dnsName: "yan.example.ts.net" }, startup: { available: true, configured: false }, configPath: "C:\\Fitz\\fitz.config.json", restartRequired: false };

beforeEach(() => document.body.replaceChildren());

describe("HostingPageController", () => {
  it("rejects malformed hosting status envelopes at the typed API boundary", async () => {
    const client = createHostingPageClient(async () => ({ data: { enabled: false } }));
    await expect(client.status()).rejects.toThrow("hosting status is invalid");
  });

  it("renders one hosting switch and the advanced canonical configuration", async () => {
    const view = elements(); const onConfiguration = vi.fn();
    const api = vi.fn(async (path: string) => path.endsWith("/hosting") ? { data: status } : { data: configuration });
    const controller = new HostingPageController(view, { api: createHostingPageClient(api), copyText: vi.fn(async () => undefined), showStatus: vi.fn(), errorMessage: String, onConfiguration });
    await controller.load();
    expect(view.configJson.value).toContain('"tailscale-funnel"');
    expect(view.advancedStatus.textContent).toContain("yan.example.ts.net");
    expect(onConfiguration).toHaveBeenCalledWith(configuration);
  });

  it("requires explicit confirmation before enabling hosting and saves validated JSON through the canonical API", async () => {
    const view = elements();
    const online = { ...status, enabled: true, online: true, publicUrl: "https://yan.example.ts.net", tailscale: { ...status.tailscale, enabled: true } };
    let currentStatus = status;
    const api = vi.fn(async (path: string, method?: string) => {
      if (path.endsWith("/hosting") && method === "PUT") { currentStatus = online; return { data: online }; }
      if (path.endsWith("/hosting")) return { data: currentStatus };
      if (path.endsWith("/validate")) return { data: configuration };
      if (path.endsWith("/config") && method === "PATCH") return { data: { configuration, hosting: online } };
      return { data: configuration };
    });
    const controller = new HostingPageController(view, { api: createHostingPageClient(api), copyText: vi.fn(async () => undefined), showStatus: vi.fn(), errorMessage: (error) => String(error) });
    await controller.load();
    view.enabled.checked = true; view.enabled.dispatchEvent(new Event("change"));
    expect(view.enabled.checked).toBe(false);
    expect(view.enableConfirmation.hidden).toBe(false);
    expect(api).not.toHaveBeenCalledWith("/api/v1/management/hosting", "PUT", { enabled: true });
    view.confirmEnable.click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/hosting", "PUT", { enabled: true }));
    view.configJson.value = JSON.stringify(configuration); view.saveConfig.click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/config/validate", "POST", configuration));
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/config", "PATCH", configuration));
  });

  it("cancels hosting enablement without mutating host state", async () => {
    const view = elements();
    const api = vi.fn(async (path: string) => path.endsWith("/hosting") ? { data: status } : { data: configuration });
    const controller = new HostingPageController(view, { api: createHostingPageClient(api), copyText: vi.fn(async () => undefined), showStatus: vi.fn(), errorMessage: String });
    await controller.load();

    view.enabled.checked = true; view.enabled.dispatchEvent(new Event("change"));
    view.cancelEnable.click();

    expect(view.enableConfirmation.hidden).toBe(true);
    expect(view.enabled.checked).toBe(false);
    expect(api).not.toHaveBeenCalledWith("/api/v1/management/hosting", "PUT", expect.anything());
  });

  it("flashes a checkmark on the copy button after a successful copy", async () => {
    vi.useFakeTimers();
    try {
      const view = elements();
      view.copyUrl.textContent = "Copy URL";
      const online = { ...status, enabled: true, online: true, publicUrl: "https://yan.example.ts.net", tailscale: { ...status.tailscale, enabled: true } };
      const api = vi.fn(async (path: string) => path.endsWith("/hosting") ? { data: online } : { data: configuration });
      const copyText = vi.fn(async () => undefined);
      const controller = new HostingPageController(view, { api: createHostingPageClient(api), copyText, showStatus: vi.fn(), errorMessage: String });
      await controller.load();
      view.copyUrl.click();
      await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith("https://yan.example.ts.net"));
      expect(view.copyUrl.textContent).toBe("✓ Copied");
      expect(view.copyUrl.classList.contains("is-copied")).toBe(true);
      expect(view.copyUrl.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1400);
      expect(view.copyUrl.textContent).toBe("Copy URL");
      expect(view.copyUrl.classList.contains("is-copied")).toBe(false);
      expect(view.copyUrl.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
