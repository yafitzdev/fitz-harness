// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdateController, type DesktopUpdateBridge, type DesktopUpdateElements } from "./desktop-update-controller.js";

function button(): HTMLButtonElement { return document.createElement("button"); }
function element(): HTMLElement { return document.createElement("div"); }

function setup(overrides: Partial<DesktopUpdateBridge> = {}) {
  let listener: ((update: any) => void) | undefined;
  const elements: DesktopUpdateElements = {
    check: button(), install: button(), label: element(), version: element(), progress: element(), globalInstall: button(),
  };
  const bridge: DesktopUpdateBridge = {
    checkForUpdates: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => ({ state: "downloaded", version: "1.2.3", percent: 100 })),
    onUpdateStatus: vi.fn((next) => { listener = next; return () => undefined; }),
    ...overrides,
  };
  const controller = new DesktopUpdateController(elements, bridge);
  return { controller, elements, bridge, emit: (update: any) => listener?.(update) };
}

beforeEach(() => document.body.replaceChildren());

describe("DesktopUpdateController", () => {
  it("restores update state and deduplicates install actions through the trusted bridge", async () => {
    const { elements, bridge } = setup();
    await vi.waitFor(() => expect(elements.label.textContent).toBe("Update ready to install"));
    expect(elements.version.textContent).toBe("Version 1.2.3");
    expect(elements.progress.style.width).toBe("100%");
    expect(elements.install.hidden).toBe(false);
    elements.install.click();
    elements.globalInstall.click();
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
  });

  it("renders a failed install request instead of leaking an unhandled rejection", async () => {
    const { elements } = setup({
      installUpdate: vi.fn(async () => { throw new Error("installer unavailable"); }),
    });
    await vi.waitFor(() => expect(elements.label.textContent).toBe("Update ready to install"));

    elements.install.click();

    await vi.waitFor(() => expect(elements.label.textContent).toBe("Update install failed"));
    expect(elements.check.disabled).toBe(false);
  });

  it("renders live progress and recovers a failed manual check", async () => {
    const { elements, emit } = setup({
      updateStatus: vi.fn(async () => ({ state: "idle" })),
      checkForUpdates: vi.fn(async () => { throw new Error("offline"); }),
    });
    await vi.waitFor(() => expect(elements.label.textContent).toBe("Ready to check"));
    emit({ state: "downloading", version: "2.0.0", percent: 42.4 });
    expect(elements.label.textContent).toBe("Downloading update · 42%");
    expect(elements.check.disabled).toBe(true);
    emit({ state: "idle" });
    elements.check.click();
    await vi.waitFor(() => expect(elements.label.textContent).toBe("Update check failed"));
    expect(elements.check.disabled).toBe(false);
  });
});
