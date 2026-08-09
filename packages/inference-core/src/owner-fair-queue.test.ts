import { describe, expect, it } from "vitest";
import { OwnerFairQueue } from "./owner-fair-queue.js";

interface Item { owner: string; id: string }

describe("OwnerFairQueue", () => {
  it("round-robins owners while retaining FIFO within each owner", () => {
    const queue = new OwnerFairQueue<Item>((item) => item.owner);
    for (const item of [
      { owner: "a", id: "a1" },
      { owner: "a", id: "a2" },
      { owner: "b", id: "b1" },
      { owner: "c", id: "c1" },
      { owner: "b", id: "b2" },
    ]) queue.enqueue(item);

    expect(queue.values().map((item) => item.id)).toEqual(["a1", "b1", "c1", "a2", "b2"]);
    expect(Array.from({ length: 5 }, () => queue.dequeue()?.id)).toEqual(["a1", "b1", "c1", "a2", "b2"]);
    expect(queue.length).toBe(0);
  });

  it("gives all newcomers a turn before the last owner is served again", () => {
    const queue = new OwnerFairQueue<Item>((item) => item.owner);
    queue.enqueue({ owner: "a", id: "a1" });
    expect(queue.dequeue()?.id).toBe("a1");
    queue.enqueue({ owner: "a", id: "a2" });
    queue.enqueue({ owner: "b", id: "b1" });
    queue.enqueue({ owner: "c", id: "c1" });
    expect(queue.values().map((item) => item.id)).toEqual(["b1", "c1", "a2"]);
  });

  it("removes an arbitrary queued item without disturbing owner order", () => {
    const queue = new OwnerFairQueue<Item>((item) => item.owner);
    const a1 = { owner: "a", id: "a1" };
    const a2 = { owner: "a", id: "a2" };
    const b1 = { owner: "b", id: "b1" };
    queue.enqueue(a1); queue.enqueue(a2); queue.enqueue(b1);
    expect(queue.remove(a1)).toBe(true);
    expect(queue.remove(a1)).toBe(false);
    expect(queue.values().map((item) => item.id)).toEqual(["a2", "b1"]);
  });
});
