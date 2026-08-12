import { validateRequestPath } from "./security.js";

export type HostRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HostResponseType = "text" | "base64";

export interface HostRequestOptions {
  method?: string;
  body?: unknown;
  responseType?: HostResponseType;
  authenticated?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HostRequestResult { status: number; body: string }

export const HOST_REQUEST_DEADLINES = {
  api: 30_000,
  artifact: 120_000,
  diagnostic: 10 * 60_000,
} as const;

/** Long-running cold-start diagnostics are explicit exceptions to the normal
 * API deadline. Artifact materialization receives a separate bounded budget;
 * all other desktop traffic fails fast enough to surface a dead host. */
export function hostRequestDeadline(path: string, responseType: HostResponseType = "text"): number {
  if (responseType === "base64") return HOST_REQUEST_DEADLINES.artifact;
  if (/^\/api\/v1\/management\/recipes\/[^/]+\/(?:test|media-test)(?:\?|$)/.test(path)) return HOST_REQUEST_DEADLINES.diagnostic;
  return HOST_REQUEST_DEADLINES.api;
}

export class HostRequestError extends Error {
  constructor(readonly code: "timeout" | "cancelled" | "network", message: string, readonly retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "HostRequestError";
  }
}

/** One typed boundary for all desktop-to-host HTTP. It validates paths and
 * methods, injects the current device credential, and gives every request a
 * bounded deadline plus renderer-lifecycle cancellation. */
export class HostClient {
  readonly #origin: URL;
  readonly #getToken: () => string | undefined;
  readonly #fetch: typeof fetch;
  readonly #defaultTimeoutMs: number;

  constructor(options: { origin: URL; getToken: () => string | undefined; fetch?: typeof fetch; defaultTimeoutMs?: number }) {
    this.#origin = options.origin;
    this.#getToken = options.getToken;
    this.#fetch = options.fetch ?? fetch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  async fetch(path: string, options: HostRequestOptions = {}): Promise<Response> {
    const safePath = validateRequestPath(path);
    const method = normalizeMethod(options.method);
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Host request timeout must be positive");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const token = options.authenticated === false ? undefined : this.#getToken();
    try {
      return await this.#fetch(new URL(safePath, this.#origin), {
        method,
        headers: {
          accept: options.responseType === "base64" ? "*/*" : "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new HostRequestError("cancelled", `The host request to ${safePath} was cancelled`, false, error);
      if (timeoutSignal.aborted) throw new HostRequestError("timeout", `The host did not respond to ${safePath} within ${timeoutMs} ms`, true, error);
      throw new HostRequestError("network", `The Fitz host could not be reached for ${safePath}`, true, error);
    }
  }

  async request(path: string, options: HostRequestOptions = {}): Promise<HostRequestResult> {
    const response = await this.fetch(path, options);
    return {
      status: response.status,
      body: options.responseType === "base64"
        ? Buffer.from(await response.arrayBuffer()).toString("base64")
        : await response.text(),
    };
  }
}

function normalizeMethod(value: string | undefined): HostRequestMethod {
  const method = (value ?? "GET").toUpperCase();
  if (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") return method;
  throw new TypeError("HTTP method is not allowed");
}
