import type { InferenceDelta, InferenceRequest } from "@fitz/protocol";

export interface OpenAICompatibleClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
}

export interface OpenAICompatibleModel {
  id: string;
  object?: string;
  owned_by?: string;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
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

  async listModels(baseUrl: string, signal?: AbortSignal): Promise<OpenAICompatibleModel[]> {
    const response = await this.#fetch(openAIEndpoint(baseUrl, "models"), {
      headers: this.headers(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OpenAI-compatible model discovery failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload.data)) throw new Error("OpenAI-compatible model discovery returned no model list");
    return payload.data.flatMap((value) => isRecord(value) && typeof value.id === "string" && value.id
      ? [{ id: value.id, ...(typeof value.object === "string" ? { object: value.object } : {}), ...(typeof value.owned_by === "string" ? { owned_by: value.owned_by } : {}) }]
      : []);
  }

  async *streamChat(
    baseUrl: string,
    modelId: string,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    const response = await this.#fetch(openAIEndpoint(baseUrl, "chat/completions"), {
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
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
        ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
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
        ...(choice?.delta?.tool_calls?.length ? { toolCalls: choice.delta.tool_calls } : {}),
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

function openAIEndpoint(baseUrl: string, endpoint: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return /\/v1$/i.test(normalized)
    ? `${normalized}/${endpoint.replace(/^\//, "")}`
    : `${normalized}/v1/${endpoint.replace(/^\//, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFinishReason(value: string | null | undefined): InferenceDelta["finishReason"] {
  if (value === "length") return "length";
  if (value === "tool_calls") return "tool_calls";
  if (value === "stop" || value === "stop_token") return "stop";
  return undefined;
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
