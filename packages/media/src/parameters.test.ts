import { describe, expect, it } from "vitest";
import { validateMediaGenerationParams } from "./parameters.js";

describe("validateMediaGenerationParams", () => {
  it("normalizes a valid prompt and preserves provider parameters", () => {
    expect(validateMediaGenerationParams({
      prompt: "  a fox  ", durationSeconds: 4, fps: 24, seed: -1, steps: 20, guidance: 0,
    })).toEqual({ prompt: "a fox", durationSeconds: 4, fps: 24, seed: -1, steps: 20, guidance: 0 });
  });

  it("normalizes optional song lyrics without adding them to non-audio requests", () => {
    expect(validateMediaGenerationParams({ prompt: "music", lyrics: "  [Verse]\nHello  " })).toEqual({
      prompt: "music",
      lyrics: "[Verse]\nHello",
    });
    expect(validateMediaGenerationParams({ prompt: "image" })).not.toHaveProperty("lyrics");
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

  it("requires a source image for an explicit edit", () => {
    expect(() => validateMediaGenerationParams({ prompt: "make it blue", operation: "edit" })).toThrow("source image reference");
    expect(validateMediaGenerationParams({ prompt: "make it blue", operation: "edit", refs: [{ artifactId: "source" }] })).toEqual({
      prompt: "make it blue", operation: "edit", refs: [{ artifactId: "source" }],
    });
  });

  it("requires exactly one source image for animation", () => {
    expect(() => validateMediaGenerationParams({ prompt: "make it move", operation: "animate" })).toThrow("source image reference");
    expect(() => validateMediaGenerationParams({
      prompt: "make it move", operation: "animate", refs: [{ artifactId: "one" }, { artifactId: "two" }],
    })).toThrow("exactly one");
    expect(validateMediaGenerationParams({ prompt: "make it move", operation: "animate", refs: [{ artifactId: "source" }] })).toEqual({
      prompt: "make it move", operation: "animate", refs: [{ artifactId: "source" }],
    });
  });
});
