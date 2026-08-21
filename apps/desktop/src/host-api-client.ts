import type { DesktopBridge } from "./preload.js";
import { parseHostError } from "./client-error.js";

export type HostApiBridge = Pick<DesktopBridge, "request"> & Partial<Pick<DesktopBridge, "uploadArtifact">>;
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
    return this.#parse<T>(response);
  }

  async uploadArtifact<T = JsonObject>(sessionId: string, file: File): Promise<T> {
    if (!this.#bridge.uploadArtifact) throw new Error("Streaming artifact uploads are unavailable");
    return this.#parse<T>(await this.#bridge.uploadArtifact({ sessionId, file }));
  }

  #parse<T>(response: { status: number; body: string }): T {
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); }
    catch { parsed = { error: response.body }; }
    if (response.status >= 400) throw parseHostError(parsed, response.status);
    return parsed as T;
  }
}
