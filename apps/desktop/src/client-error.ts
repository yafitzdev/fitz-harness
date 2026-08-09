import { HOST_CONTRACT_VERSION, PROTOCOL_VERSION, type FitzErrorPayload } from "@fitz/protocol";

export class HostRequestError extends Error {
  constructor(readonly payload: FitzErrorPayload, readonly status: number) {
    super([payload.message, payload.remediation].filter(Boolean).join(" "));
    this.name = "HostRequestError";
  }
}

export function parseHostError(value: unknown, status: number): HostRequestError {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string" || typeof value.error.retryable !== "boolean") {
    return new HostRequestError({ code: "internal_error", message: `The host returned an invalid error response (${status}).`, retryable: false }, status);
  }
  return new HostRequestError(value.error as unknown as FitzErrorPayload, status);
}

/** Validate every host, including remote hosts, before the renderer consumes
 * any API data. Fitz deliberately has no compatibility mode. */
export function assertHostContract(value: unknown): void {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.hostContractVersion !== HOST_CONTRACT_VERSION) {
    const foundProtocol = isRecord(value) && typeof value.protocolVersion === "string" ? value.protocolVersion : "missing";
    const foundContract = isRecord(value) && typeof value.hostContractVersion === "string" ? value.hostContractVersion : "missing";
    throw new HostRequestError({
      code: "internal_error",
      message: "This Fitz desktop and host are different versions.",
      detail: `Expected protocol ${PROTOCOL_VERSION} / host contract ${HOST_CONTRACT_VERSION}; found ${foundProtocol} / ${foundContract}.`,
      remediation: "Update or restart the host, then reconnect.",
      retryable: false,
    }, 426);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
