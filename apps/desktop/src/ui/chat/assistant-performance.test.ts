// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { AssistantPerformance } from "./assistant-performance.js";

describe("AssistantPerformance", () => {
  it("matches live and restored message timestamps to the nearest model request", async () => {
    const first = document.createElement("div"); const second = document.createElement("div");
    document.body.append(first, second);
    const apply = vi.fn();
    const api = vi.fn(async () => ({ data: [
      { id: "usage-1", kind: "chat", status: "completed", routeId: "local", executionLane: "gpu", enqueuedAt: "2026-08-03T10:00:00.000Z", firstOutputAt: "2026-08-03T10:00:01.000Z", completedAt: "2026-08-03T10:00:03.000Z" },
      { id: "usage-2", kind: "chat", status: "completed", routeId: "local", executionLane: "gpu", enqueuedAt: "2026-08-03T10:00:10.000Z", firstOutputAt: "2026-08-03T10:00:11.000Z", completedAt: "2026-08-03T10:00:13.000Z" },
    ] }));
    const performance = new AssistantPerformance({ api, apply });
    performance.track(first, "run-1", "2026-08-03T10:00:01.050Z");
    performance.track(second, "run-1", "2026-08-03T10:00:12.950Z");
    await performance.refresh("run-1");

    expect(apply).toHaveBeenNthCalledWith(1, first, expect.objectContaining({ id: "usage-1" }));
    expect(apply).toHaveBeenNthCalledWith(2, second, expect.objectContaining({ id: "usage-2" }));
  });

  it("replaces a premature tool-call match when final response usage arrives", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const apply = vi.fn();
    const api = vi.fn()
      .mockResolvedValueOnce({ data: [
        { id: "tool-usage", kind: "chat", status: "completed", routeId: "local", executionLane: "gpu", enqueuedAt: "2026-08-03T10:00:00.000Z", firstOutputAt: "2026-08-03T10:00:04.000Z", completedAt: "2026-08-03T10:00:05.000Z" },
      ] })
      .mockResolvedValueOnce({ data: [
        { id: "tool-usage", kind: "chat", status: "completed", routeId: "local", executionLane: "gpu", enqueuedAt: "2026-08-03T10:00:00.000Z", firstOutputAt: "2026-08-03T10:00:04.000Z", completedAt: "2026-08-03T10:00:05.000Z" },
        { id: "final-usage", kind: "chat", status: "completed", routeId: "local", executionLane: "gpu", enqueuedAt: "2026-08-03T10:00:06.000Z", firstOutputAt: "2026-08-03T10:00:07.000Z", completedAt: "2026-08-03T10:00:12.000Z" },
      ] });
    const performance = new AssistantPerformance({ api, apply });
    performance.track(target, "run-1", "2026-08-03T10:00:07.050Z");
    await vi.waitFor(() => expect(target.dataset.usageId).toBe("tool-usage"));

    await performance.refresh("run-1");

    expect(target.dataset.usageId).toBe("final-usage");
    expect(apply).toHaveBeenLastCalledWith(target, expect.objectContaining({ id: "final-usage" }));
  });
});
