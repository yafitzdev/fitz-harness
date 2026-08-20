import { describe, expect, it, vi } from "vitest";
import { SidebarActivityController, processingSessionIds } from "./sidebar-activity.js";

describe("processingSessionIds", () => {
  it("keeps queued and running agent chats while excluding unrelated work", () => {
    expect(processingSessionIds([
      { id: "run-1", kind: "agent", status: "running", sessionId: "chat-1" },
      { id: "run-2", kind: "agent", status: "queued", sessionId: "chat-2" },
      { id: "run-3", kind: "agent", status: "completed", sessionId: "chat-3" },
      { id: "media-1", kind: "media", status: "running", sessionId: "chat-4" },
      { id: "run-4", kind: "agent", status: "running" },
    ])).toEqual(new Set(["chat-1", "chat-2"]));
  });
});

describe("SidebarActivityController", () => {
  it("notifies the sidebar when durable queue membership changes", async () => {
    const api = vi.fn().mockResolvedValue({ data: [{ kind: "agent", status: "running", sessionId: "chat-1" }] });
    const onChange = vi.fn();
    const controller = new SidebarActivityController({ api, onChange });

    await controller.refresh();
    await controller.refresh();

    expect(controller.processingSessionIds).toEqual(new Set(["chat-1"]));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(new Set(["chat-1"]));
  });

  it("keeps the last known indicators through a transient queue failure", async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ data: [{ kind: "agent", status: "queued", sessionId: "chat-1" }] })
      .mockRejectedValueOnce(new Error("host reconnecting"));
    const controller = new SidebarActivityController({ api, onChange: vi.fn() });

    await controller.refresh();
    await controller.refresh();

    expect(controller.processingSessionIds).toEqual(new Set(["chat-1"]));
  });

  it("does not keep polling while the durable queue is idle", async () => {
    vi.useFakeTimers();
    try {
      const api = vi.fn().mockResolvedValue({ data: [] });
      const controller = new SidebarActivityController({ api, onChange: vi.fn(), pollIntervalMs: 250 });

      controller.start();
      await vi.runAllTimersAsync();

      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls active work until the durable queue becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const api = vi.fn()
        .mockResolvedValueOnce({ data: [{ kind: "agent", status: "running", sessionId: "chat-1" }] })
        .mockResolvedValueOnce({ data: [] });
      const controller = new SidebarActivityController({ api, onChange: vi.fn(), pollIntervalMs: 250 });

      controller.start();
      await vi.advanceTimersByTimeAsync(250);
      await vi.runAllTimersAsync();

      expect(api).toHaveBeenCalledTimes(2);
      expect(controller.processingSessionIds).toEqual(new Set());
    } finally {
      vi.useRealTimers();
    }
  });
});
