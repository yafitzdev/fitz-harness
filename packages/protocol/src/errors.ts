export type FitzErrorCode = "authentication_required" | "access_denied" | "not_found" | "invalid_input" | "resource_busy" | "engine_unavailable" | "provider_unavailable" | "storage_failure" | "internal_error";
export interface FitzErrorPayload { code: FitzErrorCode; message: string; detail?: string; remediation?: string; retryable: boolean }
export interface FitzErrorResponse { error: FitzErrorPayload }
