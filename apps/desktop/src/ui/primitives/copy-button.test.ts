// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createCopyButton } from "./copy-button.js";

describe("createCopyButton", () => {
  it("shows a checkmark after a successful copy and restores after the delay", async () => {
    vi.useFakeTimers();
    const copyText = vi.fn(async () => undefined);
    const button = createCopyButton({ copyText, value: () => "hello", title: "Copy value" });
    document.body.append(button);

    button.click();
    await Promise.resolve();
    expect(copyText).toHaveBeenCalledWith("hello");
    expect(button.getAttribute("aria-label")).toBe("Copied");
    expect(button.title).toBe("Copied");
    expect(button.classList.contains("copied")).toBe(true);
    expect(button.querySelector("svg path")?.getAttribute("d")).toContain("m4.2 10.1");

    vi.advanceTimersByTime(1_200);
    expect(button.getAttribute("aria-label")).toBe("Copy value");
    expect(button.title).toBe("Copy value");
    expect(button.classList.contains("copied")).toBe(false);
    vi.useRealTimers();
  });

  it("reads the value lazily at click time", () => {
    const copyText = vi.fn(async () => undefined);
    let value = "one";
    const button = createCopyButton({ copyText, value: () => value });
    value = "two";
    button.click();
    expect(copyText).toHaveBeenCalledWith("two");
  });

  it("does not copy when the value is empty", () => {
    const copyText = vi.fn(async () => undefined);
    const button = createCopyButton({ copyText, value: () => "" });
    button.click();
    expect(copyText).not.toHaveBeenCalled();
  });

  it("keeps the copy icon when the copy fails", async () => {
    const copyText = vi.fn(async () => { throw new Error("clipboard unavailable"); });
    const button = createCopyButton({ copyText, value: () => "hello", title: "Copy value" });
    button.click();
    await Promise.resolve();
    expect(button.getAttribute("aria-label")).toBe("Copy value");
    expect(button.classList.contains("copied")).toBe(false);
  });

  it("renders a labeled text variant", () => {
    const button = createCopyButton({ copyText: async () => undefined, value: () => "x", text: true });
    expect(button.classList.contains("copy-button-text")).toBe(true);
    expect(button.textContent).toContain("Copy");
  });
});
