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
