import { describe, expect, it } from "vitest";
import { ACTIVE_MEDIA_JOB_STATUSES, isActiveMediaJobStatus, isTerminalMediaJobStatus, TERMINAL_MEDIA_JOB_STATUSES, type MediaJobEvent, type MediaJobRecord } from "@fitz/protocol";

describe("media protocol types", () => {
  it("exports media job DTOs that survive JSON round-trips", () => {
    const job: MediaJobRecord = {
      id: "job-1",
      sessionId: "session-1",
      routeId: "video",
      modality: "video",
      status: "queued",
      params: { prompt: "a cat", durationSeconds: 5, fps: 24, negativePrompt: "blurry" },
      enqueuedAt: new Date(0).toISOString(),
      createdByUserId: "user-1",
      creditCostCents: 3,
    };
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it("serializes the MediaJobEvent discriminated union", () => {
    const events: MediaJobEvent[] = [
      { type: "progress", progress: 0.5 },
      { type: "completed", result: { data: { url: "https://example.com/out.mp4" }, mimeType: "video/mp4", byteSize: 1024, width: 1280, height: 720 } },
      { type: "failed", error: "boom" },
      { type: "cancelled" },
    ];
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
    const completed = events.find((event): event is Extract<MediaJobEvent, { type: "completed" }> => event.type === "completed");
    expect(completed?.result.mimeType).toBe("video/mp4");
  });

  it("keeps active and terminal status classification exhaustive and disjoint", () => {
    expect(ACTIVE_MEDIA_JOB_STATUSES).toEqual(["queued", "started", "progressing"]);
    expect(TERMINAL_MEDIA_JOB_STATUSES).toEqual(["completed", "failed", "cancelled", "interrupted"]);
    for (const status of ACTIVE_MEDIA_JOB_STATUSES) {
      expect(isActiveMediaJobStatus(status)).toBe(true);
      expect(isTerminalMediaJobStatus(status)).toBe(false);
    }
    for (const status of TERMINAL_MEDIA_JOB_STATUSES) {
      expect(isTerminalMediaJobStatus(status)).toBe(true);
      expect(isActiveMediaJobStatus(status)).toBe(false);
    }
    expect(isActiveMediaJobStatus("unknown")).toBe(false);
    expect(isTerminalMediaJobStatus("unknown")).toBe(false);
  });
});
