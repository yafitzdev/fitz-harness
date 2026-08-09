// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationMenuController } from "./application-menu.js";

function setup() {
  const popover = document.createElement("div");
  popover.hidden = true;
  const toggle = document.createElement("button");
  toggle.dataset.appMenu = "File";
  const actions = {
    newChat: vi.fn(), newProject: vi.fn(), toggleSidebar: vi.fn(), editCommand: vi.fn(),
    windowAction: vi.fn(), openExternal: vi.fn(), closeOthers: vi.fn(), showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
  };
  const controller = new ApplicationMenuController({ popover, toggles: [toggle], ...actions });
  document.body.append(toggle, popover);
  return { controller, popover, toggle, actions };
}

beforeEach(() => document.body.replaceChildren());

describe("ApplicationMenuController", () => {
  it("renders, positions, and invokes File menu actions", () => {
    const { popover, toggle, actions } = setup();
    toggle.click();
    expect(popover.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(popover.textContent).toContain("New chatCtrl+NNew projectClose window");
    popover.querySelector<HTMLButtonElement>("button")!.click();
    expect(actions.newChat).toHaveBeenCalledOnce();
    expect(popover.hidden).toBe(true);
  });

  it("closes an already-open menu when its toggle is clicked again", () => {
    const { popover, toggle } = setup();
    toggle.click();
    toggle.click();
    expect(popover.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("reports rejected bridge actions instead of leaking them", async () => {
    const { controller, popover, toggle, actions } = setup();
    actions.openExternal.mockRejectedValueOnce(new Error("Browser unavailable"));
    toggle.dataset.appMenu = "Help";

    controller.open("Help", toggle, new MouseEvent("click"));
    popover.querySelector<HTMLButtonElement>("button")!.click();

    await vi.waitFor(() => expect(actions.showStatus).toHaveBeenCalledWith("Browser unavailable", "error"));
  });
});
