import { describe, expect, it, vi } from "vitest";
import { createAvailablePortAllocator } from "./port-allocator.js";

describe("available inference port allocation", () => {
  it("skips ports already owned by another local server", async () => {
    const probe = vi.fn(async (_host: string, port: number) => port !== 19_001);
    const allocate = createAvailablePortAllocator({ first: 19_001, last: 19_003, probe });

    await expect(allocate()).resolves.toBe(19_002);
    expect(probe.mock.calls).toEqual([["127.0.0.1", 19_001], ["127.0.0.1", 19_002]]);
  });

  it("fails clearly when the local inference range is exhausted", async () => {
    const allocate = createAvailablePortAllocator({ first: 19_001, last: 19_002, probe: async () => false });
    await expect(allocate()).rejects.toThrow("No available inference port");
  });
});
