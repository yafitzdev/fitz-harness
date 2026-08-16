// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayHost } from "./overlay-host.js";
import { ContextMenu } from "./context-menu.js";

beforeEach(() => document.body.replaceChildren());

describe("ContextMenu", () => {
  it("renders item state and invokes the shared close path before its action", () => {
    const overlay = new OverlayHost(document);
    const element = document.createElement("div");
    const anchor = document.createElement("button");
    document.body.append(anchor, element);
    const sequence: string[] = [];
    const menu = new ContextMenu(element, overlay, () => sequence.push("close"));
    const button = menu.add({
      label: "Delete",
      icon: '<path d="M2 2h16"></path>',
      danger: true,
      action: () => sequence.push("action"),
    });

    expect(button.classList.contains("danger")).toBe(true);
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.querySelector(".menu-label")?.textContent).toBe("Delete");
    button.click();
    expect(sequence).toEqual(["close", "action"]);
  });

  it("opens beside its anchor through the shared overlay host", () => {
    const overlay = new OverlayHost(document);
    const element = document.createElement("div");
    const anchor = document.createElement("button");
    document.body.append(anchor, element);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(100, 100, 40, 20));
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(0, 0, 120, 80));
    const menu = new ContextMenu(element, overlay, vi.fn());

    menu.openBeside(anchor, 7);

    expect(element.parentElement).toBe(overlay.root);
    expect(element.hidden).toBe(false);
    expect(element.style.left).toBe("147px");
    menu.close();
    expect(element.hidden).toBe(true);
  });
});

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x, toJSON: () => ({}) } as DOMRect;
}
