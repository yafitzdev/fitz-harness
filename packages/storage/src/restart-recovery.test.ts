import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("inference request restart recovery", () => {
  it("marks persisted queued and started requests as interrupted after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "fitz-storage-recovery-"));
    const path = join(directory, "fitz.db");
    try {
      const first = new SqliteStore(path);
      first.recordQueueEvent(queueEvent(1, "queued-request", "queued"));
      first.recordQueueEvent(queueEvent(2, "started-request", "queued"));
      first.recordQueueEvent(queueEvent(3, "started-request", "started"));
      first.recordQueueEvent(queueEvent(4, "completed-request", "queued"));
      first.recordQueueEvent(queueEvent(5, "completed-request", "completed"));
      first.recordGpuQueueEvent(queueEvent(6, "gpu-chat", "queued"));
      first.recordGpuQueueEvent({ ...queueEvent(7, "gpu-warm", "started"), data: { ...queueEvent(7, "gpu-warm", "started").data, kind: "warm" as const } });
      first.recordGpuQueueEvent({ ...queueEvent(8, "gpu-media", "completed"), data: { ...queueEvent(8, "gpu-media", "completed").data, kind: "media" as const } });
      first.close();

      const restarted = new SqliteStore(path);
      expect(restarted.recoverInterruptedRequests()).toBe(2);
      expect(restarted.recoverInterruptedGpuWork()).toBe(2);
      expect(restarted.listInferenceRequests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "queued-request",
            status: "interrupted",
            errorCode: "host_restarted",
          }),
          expect.objectContaining({
            id: "started-request",
            status: "interrupted",
            errorCode: "host_restarted",
          }),
          expect.objectContaining({ id: "completed-request", status: "completed" }),
        ]),
      );
      expect(restarted.listGpuWork()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "gpu-chat", kind: "chat", status: "interrupted", errorCode: "host_restarted" }),
        expect.objectContaining({ id: "gpu-warm", kind: "warm", status: "interrupted", errorCode: "host_restarted" }),
        expect.objectContaining({ id: "gpu-media", kind: "media", status: "completed" }),
      ]));
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function queueEvent(
  sequence: number,
  requestId: string,
  status: "queued" | "started" | "completed",
) {
  return {
    sequence,
    protocolVersion: "1" as const,
    timestamp: new Date(sequence).toISOString(),
    type: "queue.updated" as const,
    data: {
      requestId,
      routeId: "default-agent",
      kind: "chat" as const,
      position: status === "queued" ? 1 : 0,
      depth: 1,
      status,
    },
  };
}
