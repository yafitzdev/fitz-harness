// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaJobTracker, mediaJobIdFromToolResult } from "./media-job-tracker.js";

afterEach(() => vi.useRealTimers());

describe("MediaJobTracker", () => {
  it("extracts only media job tool metadata", () => {
    expect(mediaJobIdFromToolResult({ content: [], details: { mediaJobId: "job-1", status: "queued" } })).toBe("job-1");
    expect(mediaJobIdFromToolResult({ content: [{ type: "text", text: "ordinary result" }] })).toBeUndefined();
  });

  it("polls a queued job and reports its completed artifact", async () => {
    vi.useFakeTimers();
    const terminal = vi.fn();
    let polls = 0;
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/events?after=0")) return { data: [] };
      polls += 1;
      return polls === 1
        ? { data: { id: "job-1", sessionId: "session-1", modality: "video", status: "queued" } }
        : { data: { id: "job-1", sessionId: "session-1", modality: "video", status: "completed", artifactId: "artifact-1" } };
    });
    const tracker = new MediaJobTracker({ api, onTerminal: terminal, pollIntervalMs: 10 });

    tracker.watch("job-1");
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());

    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "artifact-1", status: "completed" }), undefined);
  });

  it("uses the durable failed event instead of a machine error code", async () => {
    const terminal = vi.fn();
    const api = vi.fn(async (path: string) => path.endsWith("/events?after=0")
      ? { data: [{ sequence: 1, event: { type: "failed", error: "Not enough VRAM" } }] }
      : { data: { id: "job-2", sessionId: "session-1", modality: "video", status: "failed", errorCode: "generation_failed" } });
    const tracker = new MediaJobTracker({ api, onTerminal: terminal });

    tracker.watch("job-2");
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());

    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ id: "job-2" }), "Not enough VRAM");
  });

  it("exposes the active job so the composer can show a stop button and cancels it", async () => {
    vi.useFakeTimers();
    const terminal = vi.fn();
    const onActiveChange = vi.fn();
    let polls = 0;
    const api = vi.fn(async (path: string, method?: string) => {
      if (method === "POST" && path.endsWith("/cancel")) return { data: { id: "job-1", cancellationRequested: true } };
      if (path.endsWith("/events?after=0")) return { data: [] };
      polls += 1;
      return { data: { id: "job-1", sessionId: "session-1", modality: "image", status: polls > 1 ? "cancelled" : "queued" } };
    });
    const tracker = new MediaJobTracker({ api, onTerminal: terminal, onActiveChange, pollIntervalMs: 10 });

    expect(tracker.active).toBe(false);
    expect(tracker.activeJobId).toBeUndefined();
    tracker.watch("job-1");
    expect(tracker.active).toBe(true);
    expect(tracker.activeJobId).toBe("job-1");
    expect(onActiveChange).toHaveBeenCalled();

    await tracker.cancelActive();
    expect(api).toHaveBeenCalledWith("/api/v1/media/jobs/job-1/cancel", "POST");

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    expect(tracker.active).toBe(false);
    expect(tracker.activeJobId).toBeUndefined();
  });

  it("reports meaningful progress moves and swallows sub-percent jitter", async () => {
    vi.useFakeTimers();
    const terminal = vi.fn();
    const onProgress = vi.fn();
    const polls: Array<{ status: string; progress?: number }> = [
      { status: "started" },
      { status: "progressing", progress: 0.25 },
      { status: "progressing", progress: 0.251 },
      { status: "completed", progress: 1 },
    ];
    let index = 0;
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/events?after=0")) return { data: [] };
      const next = polls[index++]!;
      return { data: { id: "job-1", sessionId: "session-1", modality: "video", status: next.status, ...(next.progress !== undefined ? { progress: next.progress } : {}) } };
    });
    const tracker = new MediaJobTracker({ api, onTerminal: terminal, onProgress, pollIntervalMs: 10 });

    tracker.watch("job-1");
    await vi.advanceTimersByTimeAsync(10); // started
    await vi.advanceTimersByTimeAsync(10); // 0.25
    await vi.advanceTimersByTimeAsync(10); // 0.251 (below the 1% threshold)
    await vi.advanceTimersByTimeAsync(10); // completed
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "started" }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ progress: 0.25 }));
    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ progress: 0.251 }));
  });
});
