import { describe, expect, it } from "vitest";
import { classifyHostError } from "./host-error.js";

describe("classifyHostError", () => {
  it("does not leak commands into the user-facing message", () => {
    expect(classifyHostError("Command failed: wsl.exe --bad", 500)).toMatchObject({
      code: "engine_unavailable",
      message: "The engine process could not complete the operation.",
      detail: "Command failed: wsl.exe --bad",
      retryable: true,
    });
  });

  it("provides remediation for queue pressure and authentication", () => {
    expect(classifyHostError("GPU queue is busy", 409)).toMatchObject({ code: "resource_busy", retryable: true });
    expect(classifyHostError("missing token", 401)).toMatchObject({ code: "authentication_required", retryable: false });
  });
});
