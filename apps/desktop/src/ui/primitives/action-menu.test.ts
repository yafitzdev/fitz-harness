// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createActionMenu } from "./action-menu.js";

describe("createActionMenu", () => {
  it("keeps secondary actions behind a compact overflow control", async () => {
    const show = vi.fn();
    const remove = vi.fn();
    const menu = createActionMenu([
      { label: "Show in folder", action: show },
      { label: "Delete", action: remove, danger: true, confirm: true },
    ]);
    document.body.append(menu);
    expect(menu.querySelector("summary")?.getAttribute("aria-label")).toBe("More actions");

    const buttons = menu.querySelectorAll<HTMLButtonElement>("button");
    buttons[0]!.click();
    expect(show).toHaveBeenCalledOnce();
    buttons[1]!.click();
    expect(remove).not.toHaveBeenCalled();
    expect(buttons[1]!.textContent).toBe("Confirm delete");
    buttons[1]!.click();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
  });
});
