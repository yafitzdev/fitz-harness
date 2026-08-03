// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "./message-actions.js";

describe("MessageActions", () => {
  it("confirms a successful copy inline and restores the copy icon", async () => {
    vi.useFakeTimers();
    const copyText = vi.fn(async () => undefined);
    const actions = new MessageActions({ canEdit: () => true, onEditBlocked: vi.fn(), copyText, resend: vi.fn() });
    const article = document.createElement("article");
    const content = document.createElement("div"); content.textContent = "Copy me"; article.append(content);
    actions.attach(article, content, "assistant", "Copy me", "2026-08-03T10:00:00.000Z");

    const button = article.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!;
    button.click();
    await Promise.resolve();
    expect(copyText).toHaveBeenCalledWith("Copy me");
    expect(button.getAttribute("aria-label")).toBe("Copied");
    expect(button.classList.contains("copied")).toBe(true);

    vi.advanceTimersByTime(1_200);
    expect(button.getAttribute("aria-label")).toBe("Copy message");
    expect(button.classList.contains("copied")).toBe(false);
    vi.useRealTimers();
  });
});
