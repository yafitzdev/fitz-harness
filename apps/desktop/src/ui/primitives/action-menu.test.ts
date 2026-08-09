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

  it("runs async actions once and contains rejected callbacks", async () => {
    let resolveAction: (() => void) | undefined;
    const action = vi.fn(() => new Promise<void>((resolve) => { resolveAction = resolve; }));
    const onError = vi.fn();
    const menu = createActionMenu([
      { label: "Slow action", action },
      { label: "Broken action", action: () => Promise.reject(new Error("bridge unavailable")), onError },
    ]);
    document.body.append(menu);
    const buttons = menu.querySelectorAll<HTMLButtonElement>("button");

    buttons[0]!.click();
    buttons[0]!.click();
    expect(action).toHaveBeenCalledOnce();
    expect(buttons[0]!.disabled).toBe(true);
    expect(menu.getAttribute("aria-busy")).toBe("true");
    resolveAction?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(buttons[0]!.disabled).toBe(false);
    expect(menu.hasAttribute("aria-busy")).toBe(false);

    buttons[1]!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("bridge unavailable");
    expect(buttons[1]!.disabled).toBe(false);
  });
});
