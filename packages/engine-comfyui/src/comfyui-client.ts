/** Thin HTTP client for the ComfyUI server API (`/system_stats`, `/prompt`,
 *  `/history`, `/progress`, `/view`, `/queue`). Fetch is injected so tests can
 *  point the adapter at a fixture server without real networking. */

export interface ComfyUIHistoryEntry {
  /** Node-id → output maps (images / videos / audio lists with file refs). */
  outputs: Record<string, ComfyUIOutput>;
  status?: { status_str?: string; completed?: boolean };
}

export interface ComfyUIFileRef {
  filename: string;
  subfolder: string;
  type: "output" | "temp" | "input";
  /** Provider-style format string, e.g. "video/h264-mp4", "audio/wav", "image/png". */
  format?: string;
  width?: number;
  height?: number;
}

export interface ComfyUIOutput {
  images?: ComfyUIFileRef[];
  videos?: ComfyUIFileRef[];
  audio?: ComfyUIFileRef[];
}

export interface ComfyUIProgressState {
  running: Record<string, { progress: number; eta?: number }>;
  completed: Record<string, unknown>;
  queue_remaining: number;
}

export interface ComfyUIClientOptions {
  fetch?: typeof globalThis.fetch;
}

export class ComfyUIClient {
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ComfyUIClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async healthy(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.#fetch(joinUrl(baseUrl, "/system_stats"), {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** POST /prompt with the pinned workflow graph; returns the server-side prompt id. */
  async submitPrompt(
    baseUrl: string,
    graph: Readonly<Record<string, unknown>>,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#fetch(joinUrl(baseUrl, "/prompt"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`ComfyUI submit failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
    }
    const payload = (await response.json()) as { prompt_id?: unknown; node_errors?: unknown };
    if (typeof payload.prompt_id !== "string" || !payload.prompt_id) {
      throw new Error(`ComfyUI submit returned no prompt_id${payload.node_errors ? `: ${JSON.stringify(payload.node_errors).slice(0, 500)}` : ""}`);
    }
    return payload.prompt_id;
  }

  /** GET /history/{promptId}; the entry map is empty when the job is not done. */
  async history(baseUrl: string, promptId: string, signal?: AbortSignal): Promise<Record<string, ComfyUIHistoryEntry>> {
    const response = await this.#fetch(joinUrl(baseUrl, `/history/${encodeURIComponent(promptId)}`), {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return {};
    const payload = (await response.json()) as Record<string, ComfyUIHistoryEntry>;
    return payload ?? {};
  }

  /** GET /progress: per-prompt running progress (0..100) plus queue depth. */
  async progress(baseUrl: string, signal?: AbortSignal): Promise<ComfyUIProgressState> {
    const response = await this.#fetch(joinUrl(baseUrl, "/progress"), {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return { running: {}, completed: {}, queue_remaining: 0 };
    const payload = (await response.json()) as Partial<ComfyUIProgressState>;
    return {
      running: payload.running ?? {},
      completed: payload.completed ?? {},
      queue_remaining: payload.queue_remaining ?? 0,
    };
  }

  /** GET /view → raw output bytes for a file ref. */
  async view(baseUrl: string, file: ComfyUIFileRef, signal?: AbortSignal): Promise<Uint8Array> {
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder,
      type: file.type,
    });
    const response = await this.#fetch(joinUrl(baseUrl, `/view?${query.toString()}`), {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`ComfyUI output download failed (HTTP ${response.status}): ${file.filename}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** POST /queue `{ delete: [promptId] }` — ComfyUI's cancel for queued/running prompts. */
  async cancel(baseUrl: string, promptId: string, signal?: AbortSignal): Promise<void> {
    await this.#fetch(joinUrl(baseUrl, "/queue"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      ...(signal ? { signal } : {}),
    });
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// ---------------------------------------------------------------------------
// WebSocket progress streaming
// ---------------------------------------------------------------------------

/** Minimal structural subset of the WebSocket surface the progress listener
 *  needs. The global `WebSocket` (Node ≥ 22) satisfies it at runtime, but this
 *  package compiles without DOM libs and tests inject a fake. */
export interface ComfyUIWebSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export type ComfyUIWebSocketFactory = (url: string) => ComfyUIWebSocket;

export interface ComfyUIProgressListenerOptions {
  baseUrl: string;
  /** clientId must match the `client_id` sent in the POST /prompt body. */
  clientId: string;
  /** WebSocket factory; defaults to the runtime's global `WebSocket`. */
  createSocket?: ComfyUIWebSocketFactory;
}

/**
 * Streams execution progress from a ComfyUI server over its WebSocket
 * (`/ws?clientId=…`). Modern ComfyUI builds (this checkout included) no longer
 * expose an HTTP `/progress` endpoint — the sampler's ProgressBar hook
 * broadcasts `{"type":"progress","data":{"value":…,"max":…,"prompt_id":…,"node":…}}`
 * frames to every connected client (server-side `client_id` is null in current
 * builds, so messages are not scoped per socket). The listener keeps the latest
 * 0..1 fraction per prompt and ignores everything else (`status`/`executing`/
 * `executed` envelopes and binary preview frames).
 */
export class ComfyUIProgressListener {
  readonly #socket: ComfyUIWebSocket;
  readonly #fractions = new Map<string, number>();
  #closed = false;

  constructor(options: ComfyUIProgressListenerOptions) {
    const factory = options.createSocket ?? defaultWebSocketFactory;
    this.#socket = factory(wsEndpoint(options.baseUrl, options.clientId));
    this.#socket.onmessage = (event) => {
      const parsed = parseProgressMessage(event.data);
      if (parsed !== undefined) this.#fractions.set(parsed.promptId, parsed.progress);
    };
    // A failed socket is non-fatal: the adapter falls back to the HTTP
    // `/progress` endpoint (older ComfyUI builds) and otherwise stays in
    // "started" until the job lands in /history.
    this.#socket.onerror = () => {};
    this.#socket.onclose = () => {
      this.#closed = true;
    };
  }

  /** Latest streamed fraction (0..1) for a prompt id, or undefined if none. */
  progress(promptId: string): number | undefined {
    return this.#fractions.get(promptId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // Socket already gone; nothing to clean up.
    }
  }
}

function parseProgressMessage(data: unknown): { promptId: string; progress: number } | undefined {
  if (typeof data !== "string") return undefined; // binary preview frames
  let message: unknown;
  try {
    message = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message.type !== "progress") return undefined;
  const payload = message.data;
  if (!isRecord(payload)) return undefined;
  const { value, max, prompt_id: promptId } = payload;
  if (typeof value !== "number" || typeof max !== "number" || max <= 0) return undefined;
  if (typeof promptId !== "string" || promptId.length === 0) return undefined;
  return { promptId, progress: Math.min(1, Math.max(0, value / max)) };
}

function wsEndpoint(baseUrl: string, clientId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = `?clientId=${encodeURIComponent(clientId)}`;
  return url.toString();
}

function defaultWebSocketFactory(url: string): ComfyUIWebSocket {
  const constructor = (globalThis as { WebSocket?: new (url: string) => ComfyUIWebSocket }).WebSocket;
  if (typeof constructor !== "function") {
    throw new Error("WebSocket is not available in this runtime; ComfyUI progress streaming is disabled");
  }
  return new constructor(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
