import { describe, expect, it } from "vitest";
import { AsyncChannel, AsyncChannelClosedError } from "./async-channel.js";

describe("AsyncChannel", () => {
  it("backpressures producers at the configured item bound", async () => {
    const channel = new AsyncChannel<number>({ capacity: 2 });
    await channel.push(1);
    await channel.push(2);
    let thirdSettled = false;
    const third = channel.push(3).finally(() => { thirdSettled = true; });

    await Promise.resolve();
    expect(channel.bufferedCount).toBe(2);
    expect(channel.pendingWriters).toBe(1);
    expect(thirdSettled).toBe(false);

    const iterator = channel[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await third;
    expect(channel.bufferedCount).toBe(2);
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 3, done: false });
  });

  it("bounds variable-sized values and resumes in FIFO order", async () => {
    const channel = new AsyncChannel<string>({ capacity: 10, maxBufferedSize: 4, sizeOf: (value) => value.length });
    await channel.push("abc");
    const pending = channel.push("de");
    expect(channel.pendingWriters).toBe(1);

    const iterator = channel[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: "abc", done: false });
    await pending;
    expect(channel.bufferedSize).toBe(2);
    await expect(iterator.next()).resolves.toEqual({ value: "de", done: false });
  });

  it("allows exactly one atomic oversized item when explicitly configured", async () => {
    const channel = new AsyncChannel<string>({
      capacity: 4,
      maxBufferedSize: 4,
      sizeOf: (value) => value.length,
      allowSingleOversizedItem: true,
    });
    await channel.push("oversized");
    const pending = channel.push("x");
    expect(channel.bufferedCount).toBe(1);
    expect(channel.pendingWriters).toBe(1);

    const iterator = channel[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: "oversized", done: false });
    await pending;
    await expect(iterator.next()).resolves.toEqual({ value: "x", done: false });
  });

  it("delivers an oversized item directly to a waiting reader without buffering it", async () => {
    const channel = new AsyncChannel<string>({ capacity: 1, maxBufferedSize: 2, sizeOf: (value) => value.length });
    const next = channel[Symbol.asyncIterator]().next();
    await channel.push("direct");
    await expect(next).resolves.toEqual({ value: "direct", done: false });
    expect(channel.bufferedSize).toBe(0);
  });

  it("releases a blocked producer when its request is aborted", async () => {
    const channel = new AsyncChannel<number>({ capacity: 1 });
    await channel.push(1);
    const controller = new AbortController();
    const pending = channel.push(2, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(channel.pendingWriters).toBe(0);
  });

  it("rejects blocked producers when the channel closes", async () => {
    const channel = new AsyncChannel<number>({ capacity: 1 });
    await channel.push(1);
    const pending = channel.push(2);
    channel.close();

    await expect(pending).rejects.toBeInstanceOf(AsyncChannelClosedError);
  });
});
