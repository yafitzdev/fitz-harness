import { describe, expect, it } from "vitest";
import { validateMediaGenerationParams } from "./parameters.js";

describe("validateMediaGenerationParams", () => {
  it("normalizes a valid prompt and preserves provider parameters", () => {
    expect(validateMediaGenerationParams({
      prompt: "  a fox  ", durationSeconds: 4, fps: 24, seed: -1, steps: 20, guidance: 0,
    })).toEqual({ prompt: "a fox", durationSeconds: 4, fps: 24, seed: -1, steps: 20, guidance: 0 });
  });

  it.each([
    [{ prompt: "x", durationSeconds: 0 }, "durationSeconds"],
    [{ prompt: "x", fps: -1 }, "fps"],
    [{ prompt: "x", steps: 1.5 }, "steps"],
    [{ prompt: "x", guidance: -0.1 }, "guidance"],
    [{ prompt: "x", seed: Number.POSITIVE_INFINITY }, "seed"],
  ] as const)("rejects invalid provider-independent values: %o", (params, field) => {
    expect(() => validateMediaGenerationParams(params)).toThrow(field);
  });
});
