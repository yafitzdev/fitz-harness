import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import { assertHostContract, HostRequestError, parseHostError } from "./client-error.js";

describe("desktop host contracts", () => {
  it("accepts only the exact desktop/host contract", () => {
    expect(() => assertHostContract({ protocolVersion: PROTOCOL_VERSION, hostContractVersion: HOST_CONTRACT_VERSION })).not.toThrow();
    expect(() => assertHostContract({ protocolVersion: PROTOCOL_VERSION, hostContractVersion: "old" })).toThrow(HostRequestError);
    expect(() => assertHostContract({ protocolVersion: PROTOCOL_VERSION })).toThrow("different versions");
  });

  it("requires structured host errors and preserves remediation", () => {
    const error = parseHostError({ error: { code: "resource_busy", message: "GPU request queued", remediation: "Wait or cancel it.", retryable: true } }, 409);
    expect(error).toMatchObject({ status: 409, payload: { code: "resource_busy", retryable: true, remediation: "Wait or cancel it." } });
    expect(error.message).toBe("GPU request queued Wait or cancel it.");
    expect(parseHostError({ error: "old string" }, 500).payload).toMatchObject({ code: "internal_error", retryable: false });
  });
});
