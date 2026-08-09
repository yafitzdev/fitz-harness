// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdaptiveWorkspace } from "./adaptive-workspace.js";

class ResizeObserverStub {
  observe = vi.fn();
}

describe("AdaptiveWorkspace", () => {
  beforeEach(() => vi.stubGlobal("ResizeObserver", ResizeObserverStub));

  it("temporarily collapses the project sidebar for a compact docked Inspector", () => {
    const shell = document.createElement("div");
    const workspace = document.createElement("main");
    Object.defineProperty(shell, "clientWidth", { value: 900 });
    const layout = new AdaptiveWorkspace({ shell, workspace });

    workspace.classList.add("inspector-open");
    layout.sync();
    expect(shell.classList.contains("sidebar-collapsed")).toBe(true);

    workspace.classList.remove("inspector-open");
    layout.sync();
    expect(shell.classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("does not override a sidebar the user collapsed themselves", () => {
    const shell = document.createElement("div");
    const workspace = document.createElement("main");
    Object.defineProperty(shell, "clientWidth", { value: 900 });
    shell.classList.add("sidebar-collapsed");
    const layout = new AdaptiveWorkspace({ shell, workspace });

    workspace.classList.add("inspector-open");
    layout.sync();
    workspace.classList.remove("inspector-open");
    layout.sync();
    expect(shell.classList.contains("sidebar-collapsed")).toBe(true);
  });
});
