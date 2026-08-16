// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizablePane } from "./resizable-pane.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

function setup(overrides: Partial<ConstructorParameters<typeof ResizablePane>[0]> = {}) {
  const divider = document.createElement("div");
  const apply = vi.fn();
  const onChange = vi.fn();
  const pane = new ResizablePane({
    divider,
    storageKey: "pane-width",
    defaultValue: 300,
    minimum: 200,
    maximum: 500,
    pointerValue: (event) => event.clientX,
    apply,
    onChange,
    ...overrides,
  });
  return { pane, divider, apply, onChange };
}

describe("ResizablePane", () => {
  it("restores persisted size and clamps it to the current bounds", () => {
    localStorage.setItem("pane-width", "900");
    const { pane, divider, apply } = setup();
    expect(pane.value()).toBe(500);
    expect(apply).toHaveBeenLastCalledWith(500);
    expect(divider.getAttribute("aria-valuenow")).toBe("500");
  });

  it("resizes accessibly with the keyboard and persists the result", () => {
    const { pane, divider } = setup();
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(pane.value()).toBe(312);
    expect(localStorage.getItem("pane-width")).toBe("312");

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(pane.value()).toBe(300);
  });

  it("tracks pointer movement and persists only when the drag finishes", () => {
    const { pane, divider } = setup();
    Object.assign(divider, { setPointerCapture: vi.fn() });
    divider.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 4, clientX: 320, bubbles: true }));
    divider.dispatchEvent(new PointerEvent("pointermove", { pointerId: 4, clientX: 420, bubbles: true }));
    expect(pane.value()).toBe(420);
    expect(localStorage.getItem("pane-width")).toBeNull();
    divider.dispatchEvent(new PointerEvent("pointerup", { pointerId: 4, bubbles: true }));
    expect(localStorage.getItem("pane-width")).toBe("420");
    expect(divider.classList.contains("dragging")).toBe(false);
  });
});
