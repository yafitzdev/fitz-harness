import type { InferenceDelta, InferenceRequest } from "@fitz/protocol";

export interface OpenAICompatibleClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAICompatibleClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiKey: string | undefined;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiKey = options.apiKey;
  }

  async healthy(baseUrl: string, healthPath: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.#fetch(joinUrl(baseUrl, healthPath), {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    return response.ok;
  }

  async *streamChat(
    baseUrl: string,
    modelId: string,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    const response = await this.#fetch(joinUrl(baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
        ...(request.userId ? { user: request.userId } : {}),
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI-compatible request failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    for await (const chunk of parseSseJson(response.body, signal)) {
      if (chunk.error) throw new Error(chunk.error.message ?? "OpenAI-compatible stream failed");
      const choice = chunk.choices?.[0];
      const finishReason = normalizeFinishReason(choice?.finish_reason);
      yield {
        text: choice?.delta?.content ?? "",
        ...(finishReason ? { finishReason } : {}),
        ...(chunk.usage?.prompt_tokens !== undefined ? { promptTokens: chunk.usage.prompt_tokens } : {}),
        ...(chunk.usage?.completion_tokens !== undefined
          ? { completionTokens: chunk.usage.completion_tokens }
          : {}),
      };
    }
  }

  private headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }
}

export async function* parseSseJson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data) as StreamChunk;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function normalizeFinishReason(value: string | null | undefined): InferenceDelta["finishReason"] {
  if (value === "length") return "length";
  if (value === "stop" || value === "stop_token" || value === "tool_calls") return "stop";
  return undefined;
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
