import type { FitzErrorCode, FitzErrorPayload } from "@fitz/protocol";

export function classifyHostError(message: string, status: number): FitzErrorPayload {
  const lower = message.toLowerCase();
  let code: FitzErrorCode = "internal_error";
  let remediation: string | undefined;
  let retryable = status >= 500;
  if (status === 401) { code = "authentication_required"; remediation = "Pair this device with the host, then retry."; retryable = false; }
  else if (status === 403) { code = "access_denied"; remediation = "Ask a host administrator to grant access."; retryable = false; }
  else if (status === 404) { code = "not_found"; retryable = false; }
  else if (status === 409 || lower.includes("busy") || lower.includes("queue")) { code = "resource_busy"; remediation = "Wait for the active request or cancel it from the queue."; retryable = true; }
  else if (status < 500) { code = "invalid_input"; retryable = false; }
  else if (/engine|model|vram|cuda|wsl|executable/.test(lower)) { code = "engine_unavailable"; remediation = "Open Playbooks, verify the recipe, and run its test."; }
  else if (/provider|upstream|fetch|http/.test(lower)) { code = "provider_unavailable"; remediation = "Check the connection and retry."; }
  else if (/sqlite|database|storage|disk|blob/.test(lower)) { code = "storage_failure"; remediation = "Open Administration and review storage diagnostics before retrying."; }
  return { code, message: userMessage(message), ...(message !== userMessage(message) ? { detail: message } : {}), ...(remediation ? { remediation } : {}), retryable };
}

function userMessage(message: string): string {
  if (/command failed:|wsl\.exe|child process/i.test(message)) return "The engine process could not complete the operation.";
  if (/enoent|no such file/i.test(message)) return "A required file could not be found.";
  return message;
}
