// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayHost } from "./overlay-host.js";
import { CustomSelectController } from "./custom-select.js";

beforeEach(() => document.body.replaceChildren());

function setup() {
  const select = document.createElement("select");
  select.innerHTML = '<optgroup label="Models"><option value="fast">Fast</option><option value="smart" selected>Smart</option></optgroup>';
  const popover = document.createElement("div");
  popover.hidden = true;
  document.body.append(select, popover);
  vi.spyOn(select, "getBoundingClientRect").mockReturnValue(rect(20, 20, 180, 30));
  vi.spyOn(popover, "getBoundingClientRect").mockReturnValue(rect(0, 0, 180, 100));
  const overlay = new OverlayHost(document);
  const beforeOpen = vi.fn();
  const controller = new CustomSelectController(overlay, popover, beforeOpen);
  return { select, popover, overlay, beforeOpen, controller };
}

describe("CustomSelectController", () => {
  it("enhances selects and renders grouped options in the shared overlay", () => {
    const { select, popover, overlay, controller } = setup();

    controller.open(select);

    expect(select.dataset.customMenu).toBe("true");
    expect(select.getAttribute("aria-haspopup")).toBe("listbox");
    expect(select.getAttribute("aria-expanded")).toBe("true");
    expect(popover.parentElement).toBe(overlay.root);
    expect(popover.querySelector(".select-group-label")?.textContent).toBe("Models");
    expect(popover.querySelectorAll<HTMLButtonElement>(".select-option")).toHaveLength(2);
    expect(popover.querySelector<HTMLButtonElement>('[data-value="smart"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("updates the native select and returns focus after choosing an option", () => {
    const { select, popover, controller } = setup();
    const changed = vi.fn();
    select.addEventListener("change", changed);
    controller.open(select);

    popover.querySelector<HTMLButtonElement>('[data-value="fast"]')!.click();

    expect(select.value).toBe("fast");
    expect(changed).toHaveBeenCalledOnce();
    expect(select.getAttribute("aria-expanded")).toBe("false");
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(select);
  });

  it("renders separator options as thin full-width rules", () => {
    const { select, popover, controller } = setup();
    const separator = document.createElement("option");
    separator.dataset.separator = "true";
    separator.disabled = true;
    select.insertBefore(separator, select.firstChild);

    controller.open(select);

    expect(popover.querySelector(".select-separator")).not.toBeNull();
    expect(popover.querySelectorAll(".select-option")).toHaveLength(2);
  });

  it("enhances selects inserted after startup", async () => {
    setup();
    const added = document.createElement("select");
    const option = document.createElement("option");
    option.value = "later";
    option.textContent = "Later";
    added.append(option);
    document.body.append(added);
    await Promise.resolve();
    expect(added.dataset.customMenu).toBe("true");
  });
});

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x, toJSON: () => ({}) } as DOMRect;
}
