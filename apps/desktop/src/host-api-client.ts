import type { DesktopBridge } from "./preload.js";
import { parseHostError } from "./client-error.js";

export type HostApiBridge = Pick<DesktopBridge, "request">;
export type JsonObject = Record<string, any>;

/**
 * Owns the renderer-to-host JSON boundary. UI controllers receive the small
 * request function they need; only this adapter knows how IPC responses are
 * decoded and how host errors are normalized.
 */
export class HostApiClient {
  readonly #bridge: HostApiBridge;

  constructor(bridge: HostApiBridge) {
    this.#bridge = bridge;
  }

  async request<T = JsonObject>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.#bridge.request({ path, method, ...(body !== undefined ? { body } : {}) });
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); }
    catch { parsed = { error: response.body }; }
    if (response.status >= 400) throw parseHostError(parsed, response.status);
    return parsed as T;
  }
}
