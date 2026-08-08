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
});
