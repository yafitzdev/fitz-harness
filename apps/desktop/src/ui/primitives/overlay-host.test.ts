// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayHost } from "./overlay-host.js";

beforeEach(() => document.body.replaceChildren());

describe("OverlayHost", () => {
  it("portals and positions surfaces in one document-level host", () => {
    const host = new OverlayHost(document);
    const anchor = document.createElement("button");
    const menu = document.createElement("div");
    menu.hidden = true;
    document.body.append(anchor, menu);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(100, 700, 80, 30));
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(rect(0, 0, 220, 140));

    host.register(menu);
    host.open(menu, { anchor, placement: "auto-end", gap: 6 });

    expect(menu.parentElement).toBe(host.root);
    expect(menu.hidden).toBe(false);
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("554px");
  });

  it("closes the previous surface and runs its lifecycle callback", () => {
    const host = new OverlayHost(document);
    const anchor = document.createElement("button");
    const first = document.createElement("div");
    const second = document.createElement("div");
    const closed = vi.fn();
    for (const element of [first, second]) {
      element.hidden = true;
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(0, 0, 100, 50));
    }
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(20, 20, 40, 20));
    host.register(first, closed);
    host.register(second);
    host.open(first, { anchor, placement: "auto-start" });

    host.open(second, { anchor, placement: "auto-start" });

    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    expect(closed).toHaveBeenCalledOnce();
  });
});

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x, toJSON: () => ({}) } as DOMRect;
}
