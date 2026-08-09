// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostLifecycleController, type HostLifecycleElements } from "./host-lifecycle-controller.js";

function button(): HTMLButtonElement { return document.createElement("button"); }
function element(): HTMLElement { return document.createElement("div"); }
function click(target: HTMLElement): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

function setup() {
  const elements: HostLifecycleElements = {
    refreshRemote: button(), cancelRemote: button(), remoteStatus: element(), remoteConfirmation: element(), remoteConfirmationText: element(),
    enableRemote: button(), disableRemote: button(), confirmRemote: button(), refreshStartup: button(), cancelStartup: button(),
    startupStatus: element(), startupConfirmation: element(), startupConfirmationText: element(), installStartup: button(), removeStartup: button(), confirmStartup: button(),
  };
  elements.remoteConfirmation.hidden = true;
  elements.startupConfirmation.hidden = true;
  const api = vi.fn(async (path: string) => {
    if (path.endsWith("connectivity/status")) return { data: { tailscale: { state: "connected", dnsName: "host.tailnet.ts.net" }, serve: { available: true, configuration: {} } } };
    if (path.endsWith("startup")) return { data: { available: true, configured: false, message: "Per-user Windows startup" } };
    return { data: {} };
  });
  const reload = vi.fn(async () => undefined);
  const controller = new HostLifecycleController(elements, { api, reload, errorMessage: (error) => String(error) });
  return { controller, elements, api, reload };
}

beforeEach(() => document.body.replaceChildren());

describe("HostLifecycleController", () => {
  it("loads and renders remote-access and startup state", async () => {
    const { controller, elements } = setup();
    await Promise.all([controller.loadRemote(), controller.loadStartup()]);
    expect(elements.remoteStatus.textContent).toContain("host.tailnet.ts.net");
    expect(elements.remoteStatus.textContent).toContain("Disabled");
    expect(elements.enableRemote.disabled).toBe(false);
    expect(elements.startupStatus.textContent).toContain("Does not start at sign-in");
    expect(elements.installStartup.disabled).toBe(false);
  });

  it("stages and applies remote-access and startup mutations", async () => {
    const { elements, api, reload } = setup();
    click(elements.enableRemote);
    expect(elements.remoteConfirmation.hidden).toBe(false);
    click(elements.confirmRemote);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/connectivity/tailscale-serve", "POST", {}));
    await vi.waitFor(() => expect(elements.remoteConfirmation.hidden).toBe(true));
    expect(reload).toHaveBeenCalledOnce();

    click(elements.installStartup);
    expect(elements.startupConfirmation.hidden).toBe(false);
    click(elements.confirmStartup);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/startup", "POST", {}));
    await vi.waitFor(() => expect(elements.startupConfirmation.hidden).toBe(true));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("keeps mutation failures inside their confirmation surfaces", async () => {
    const { elements, api, reload } = setup();
    api.mockImplementation(async (path: string) => {
      if (path.includes("tailscale-serve")) throw new Error("Tailscale is unavailable");
      if (path.endsWith("startup")) throw new Error("Startup registration failed");
      return { data: {} };
    });

    click(elements.enableRemote);
    click(elements.confirmRemote);
    await vi.waitFor(() => expect(elements.remoteConfirmationText.textContent).toContain("Tailscale is unavailable"));
    expect(elements.remoteConfirmation.hidden).toBe(false);
    expect(elements.remoteConfirmation.getAttribute("role")).toBe("alert");

    click(elements.installStartup);
    click(elements.confirmStartup);
    await vi.waitFor(() => expect(elements.startupConfirmationText.textContent).toContain("Startup registration failed"));
    expect(elements.startupConfirmation.hidden).toBe(false);
    expect(elements.startupConfirmation.getAttribute("role")).toBe("alert");
    expect(reload).not.toHaveBeenCalled();
  });
});
