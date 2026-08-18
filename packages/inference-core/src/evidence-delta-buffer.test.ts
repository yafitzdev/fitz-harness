import { describe, expect, it, vi } from "vitest";
import type { InferenceEvidenceDelta } from "@fitz/protocol";
import { EvidenceDeltaBuffer } from "./evidence-delta-buffer.js";

function record(evidenceId: string, sequence: number): InferenceEvidenceDelta {
  return { evidenceId, sequence, timestamp: `2026-08-18T00:00:0${sequence}.000Z`, delta: { text: String(sequence) } };
}

describe("EvidenceDeltaBuffer", () => {
  it("keeps the per-token enqueue path free of evidence I/O and persists one batch on flush", async () => {
    const sink = vi.fn<(records: readonly InferenceEvidenceDelta[]) => void>();
    const buffer = new EvidenceDeltaBuffer(sink, { batchSize: 64, flushIntervalMs: 60_000 });

    buffer.enqueue(record("request-1", 1));
    buffer.enqueue(record("request-1", 2));

    expect(sink).not.toHaveBeenCalled();
    await buffer.flush("request-1");
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith([record("request-1", 1), record("request-1", 2)]);
  });

  it("serializes threshold batches and lets terminal flush join their writes", async () => {
    const written: number[][] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sink = vi.fn(async (records: readonly InferenceEvidenceDelta[]) => {
      written.push(records.map((entry) => entry.sequence));
      if (written.length === 1) await firstWrite;
    });
    const buffer = new EvidenceDeltaBuffer(sink, { batchSize: 2, flushIntervalMs: 60_000 });

    buffer.enqueue(record("request-1", 1));
    buffer.enqueue(record("request-1", 2));
    buffer.enqueue(record("request-1", 3));
    const terminalFlush = buffer.flush("request-1");

    await Promise.resolve();
    expect(written).toEqual([[1, 2]]);
    releaseFirst();
    await terminalFlush;
    expect(written).toEqual([[1, 2], [3]]);
  });

  it("keeps evidence failures fail-open", async () => {
    const buffer = new EvidenceDeltaBuffer(() => { throw new Error("disk full"); }, { flushIntervalMs: 60_000 });
    buffer.enqueue(record("request-1", 1));

    await expect(buffer.flush("request-1")).resolves.toBeUndefined();
  });
});
