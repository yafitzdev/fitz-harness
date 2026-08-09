import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { writeWithBackpressure } from "./stream-response.js";

class ControlledWritable extends EventEmitter {
  readonly chunks: string[] = [];
  acceptImmediately = false;
  destroyed = false;
  writableEnded = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.acceptImmediately;
  }
}

describe("writeWithBackpressure", () => {
  it("waits for drain when the socket buffer is full", async () => {
    const writable = new ControlledWritable();
    let settled = false;
    const writing = writeWithBackpressure(writable, "chunk").finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(writable.listenerCount("drain")).toBe(1);

    writable.emit("drain");
    await writing;
    expect(settled).toBe(true);
    expect(writable.eventNames()).toEqual([]);
  });

  it("rejects and removes listeners when the client disconnects", async () => {
    const writable = new ControlledWritable();
    const writing = writeWithBackpressure(writable, "chunk");
    writable.emit("close");

    await expect(writing).rejects.toMatchObject({ name: "ConnectionClosedError" });
    expect(writable.eventNames()).toEqual([]);
  });

  it("rejects a blocked write when its request is aborted", async () => {
    const writable = new ControlledWritable();
    const controller = new AbortController();
    const writing = writeWithBackpressure(writable, "chunk", controller.signal);
    controller.abort();

    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(writable.eventNames()).toEqual([]);
  });
});
