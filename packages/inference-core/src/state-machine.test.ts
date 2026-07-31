import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "./state-machine.js";

describe("instance state machine", () => {
  it("allows the normal load, generation, and eviction path", () => {
    expect(canTransition("UNLOADED", "PREPARING")).toBe(true);
    expect(canTransition("PREPARING", "LOADING")).toBe(true);
    expect(canTransition("LOADING", "READY")).toBe(true);
    expect(canTransition("READY", "BUSY")).toBe(true);
    expect(canTransition("BUSY", "READY")).toBe(true);
    expect(canTransition("READY", "DRAINING")).toBe(true);
    expect(canTransition("DRAINING", "EVICTING")).toBe(true);
    expect(canTransition("EVICTING", "UNLOADED")).toBe(true);
  });

  it("rejects invalid shortcuts", () => {
    expect(() => assertTransition("UNLOADED", "BUSY")).toThrow(
      "Invalid instance transition",
    );
  });
});
