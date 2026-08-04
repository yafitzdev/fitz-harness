// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "./inspector-panel.js";

function mount(): HTMLElement {
  const element = document.createElement("main");
  element.className = "workspace";
  element.getBoundingClientRect = () => ({ width: 900, height: 700, top: 0, left: 0, right: 900, bottom: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(element);
  return element;
}

function panel(host: HTMLElement, onLayoutChange = vi.fn()): InspectorPanel {
  return new InspectorPanel({
    mount: host,
    getProjectRoot: () => "",
    getSearchRoots: () => [],
    showToast: vi.fn(),
    onLayoutChange,
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  // happy-dom's global storage here is a bare stub; provide a Map-backed one
  // so ResizablePane can restore and persist the panel width.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
});

describe("InspectorPanel", () => {
  it("builds the right-hand Inspector shell hidden with its own resizer", () => {
    const host = mount();
    const view = panel(host);

    expect(view.element.className).toContain("inspector-panel");
    expect(view.element.getAttribute("aria-label")).toBe("Inspector");
    expect(view.element.hidden).toBe(true);
    expect(view.resizer.className).toContain("inspector-resizer");
    expect(view.resizer.hidden).toBe(true);
    expect(view.element.querySelector(".inspector-header")).not.toBeNull();
    expect(view.element.querySelector(".inspector-content")).not.toBeNull();
    expect(view.element.querySelector(".inspector-empty")?.textContent).toContain("Select a file or link");
    expect(host.querySelectorAll(".inspector-panel, .inspector-resizer")).toHaveLength(2);
  });

  it("opens and closes the panel with the workspace reflowing around it", () => {
    const host = mount();
    const onLayoutChange = vi.fn();
    const view = panel(host, onLayoutChange);
    onLayoutChange.mockClear();

    view.open();
    expect(view.isOpen).toBe(true);
    expect(view.element.hidden).toBe(false);
    expect(view.resizer.hidden).toBe(false);
    expect(host.classList.contains("inspector-open")).toBe(true);
    expect(host.parentElement?.classList.contains("context-open")).toBe(true);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    view.close();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
    expect(view.resizer.hidden).toBe(true);
    expect(host.classList.contains("inspector-open")).toBe(false);
    expect(host.parentElement?.classList.contains("context-open")).toBe(false);
    expect(onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it("toggles open state and closes from the header close button", () => {
    const host = mount();
    const view = panel(host);

    view.toggle();
    expect(view.isOpen).toBe(true);
    view.toggle();
    expect(view.isOpen).toBe(false);

    view.open();
    const close = view.element.querySelector<HTMLButtonElement>("#inspector-close")!;
    close.click();
    expect(view.isOpen).toBe(false);
    expect(view.element.hidden).toBe(true);
  });

  it("restores the persisted width and resizes from the divider keyboard", () => {
    const host = mount();
    const view = panel(host);

    expect(view.width()).toBe(400);
    expect(host.style.getPropertyValue("--inspector-width")).toBe("400px");

    view.resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(view.width()).toBe(388);
    expect(host.style.getPropertyValue("--inspector-width")).toBe("388px");
    expect(view.resizer.getAttribute("aria-valuenow")).toBe("388");

    view.resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(view.width()).toBe(400);
  });

  it("restores the preview hint only while the panel is closed", () => {
    const host = mount();
    const view = panel(host);
    const content = view.element.querySelector<HTMLElement>(".inspector-content")!;

    content.replaceChildren();
    view.resetPreview();
    expect(content.querySelector(".inspector-empty")?.textContent).toContain("Select a file or link");

    content.replaceChildren();
    view.open();
    view.resetPreview();
    expect(content.childElementCount).toBe(0);
  });
});
