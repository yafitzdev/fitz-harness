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
  const showToast = vi.fn();
  const controller = new HostLifecycleController(elements, { api, reload, showToast, errorMessage: (error) => String(error) });
  return { controller, elements, api, reload, showToast };
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
    const { elements, api, reload, showToast } = setup();
    click(elements.enableRemote);
    expect(elements.remoteConfirmation.hidden).toBe(false);
    click(elements.confirmRemote);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/connectivity/tailscale-serve", "POST", {}));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Private HTTPS enabled"));
    expect(reload).toHaveBeenCalledOnce();

    click(elements.installStartup);
    expect(elements.startupConfirmation.hidden).toBe(false);
    click(elements.confirmStartup);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/startup", "POST", {}));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Host will start at sign-in"));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
