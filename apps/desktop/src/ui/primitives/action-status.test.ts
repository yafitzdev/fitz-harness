// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ActionStatus } from "./action-status.js";

describe("ActionStatus", () => {
  it("renders accessible in-page feedback with a tone", () => {
    const status = new ActionStatus();
    document.body.append(status.root);
    status.show("Connection failed", "error");
    expect(status.root.hidden).toBe(false);
    expect(status.root.getAttribute("role")).toBe("alert");
    expect(status.root.dataset.tone).toBe("error");
    expect(status.message.textContent).toBe("Connection failed");
    expect(ActionStatus.find(document.body)).toBe(status);
  });

  it("dismisses without leaving stale content", () => {
    const status = new ActionStatus();
    status.show("Saved", "success");
    status.root.querySelector<HTMLButtonElement>("button")?.click();
    expect(status.root.hidden).toBe(true);
    expect(status.root.hasAttribute("role")).toBe(false);
    expect(status.message.textContent).toBe("");
  });

  it("clears successful confirmations while keeping failures actionable", () => {
    vi.useFakeTimers();
    const status = new ActionStatus();
    status.show("Saved", "success");
    vi.advanceTimersByTime(4_000);
    expect(status.root.hidden).toBe(true);
    status.show("Save failed", "error");
    vi.advanceTimersByTime(8_000);
    expect(status.root.hidden).toBe(false);
    vi.useRealTimers();
  });
});
