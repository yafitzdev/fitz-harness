import { describe, expect, it, vi } from "vitest";
import { abortableDelay } from "./abortable-delay.js";

describe("abortableDelay", () => {
  it("removes its abort listener after the timer resolves", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const delayed = abortableDelay(1_000, controller.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await delayed;

      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer and removes its listener when aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const delayed = abortableDelay(10_000, controller.signal);
      controller.abort();

      await expect(delayed).rejects.toMatchObject({ name: "AbortError" });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
