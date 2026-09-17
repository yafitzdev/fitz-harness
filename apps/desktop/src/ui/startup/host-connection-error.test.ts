import { describe, expect, it } from "vitest";
import { isTransientHostConnectionFailure } from "./host-connection-error.js";

describe("isTransientHostConnectionFailure", () => {
  it.each([
    "The local Fitz service is still starting",
    new Error("The Fitz host could not be reached for /api/v1/agent/runs"),
    "The host did not respond to /health within 5000 ms",
  ])("recognizes shell-owned connection failures", (error) => {
    expect(isTransientHostConnectionFailure(error)).toBe(true);
  });

  it("leaves model and application errors in the conversation", () => {
    expect(isTransientHostConnectionFailure("The model returned an invalid response")).toBe(false);
  });
});
