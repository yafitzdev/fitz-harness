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

  it("adds compact model performance to assistant message metadata", () => {
    const actions = new MessageActions({ canEdit: () => true, onEditBlocked: vi.fn(), copyText: vi.fn(), resend: vi.fn() });
    const article = document.createElement("article"); article.className = "message assistant";
    const content = document.createElement("div"); article.append(content);
    actions.attach(article, content, "assistant", "Hello", "2026-08-03T10:00:00.000Z");

    actions.setPerformance(content, {
      id: "usage-1", kind: "chat", status: "completed", routeId: "local", recipeId: "muse-glimmer", modelId: "Muse-Glimmer-30B-UD-Q4_K_XL", executionLane: "gpu",
      enqueuedAt: "2026-08-03T09:59:58.000Z", completedAt: "2026-08-03T10:00:12.000Z",
      ttftMs: 702, generationMs: 12_000, durationMs: 12_702, queueWaitMs: 4,
      promptTokens: 77_771, completionTokens: 1_128,
    });

    const time = article.querySelector<HTMLTimeElement>("time")!;
    expect(time.textContent).toMatch(/ · 702ms TTFT · 94 tok\/s · 77\.8k ctx · Muse-Glimmer-30B-UD-Q4_K_XL$/);
    expect(time.title).toContain("Model: Muse-Glimmer-30B-UD-Q4_K_XL");
    expect(time.title).toContain("Input tokens: 77");
    expect(time.title).toContain("Output tokens: 1");
    expect(time.title).toContain("Total model time: 13s");
  });

  it("uses the recipe ID when provider model telemetry is unavailable", () => {
    const actions = new MessageActions({ canEdit: () => true, onEditBlocked: vi.fn(), copyText: vi.fn(), resend: vi.fn() });
    const article = document.createElement("article"); article.className = "message assistant";
    const content = document.createElement("div"); article.append(content);
    actions.attach(article, content, "assistant", "Hello", "2026-08-03T10:00:00.000Z");
    actions.setPerformance(content, { id: "usage-2", kind: "chat", status: "completed", routeId: "local", recipeId: "fallback-recipe", executionLane: "gpu", enqueuedAt: "2026-08-03T10:00:00.000Z", completedAt: "2026-08-03T10:00:01.000Z", promptTokens: 900 });

    expect(article.querySelector("time")?.textContent).toMatch(/ · 900 ctx · fallback-recipe$/);
  });
});
