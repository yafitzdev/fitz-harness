import { InferenceRequestRejectedError } from "@fitz/inference-core";
import type { InferenceDelta, InferenceRequest } from "@fitz/protocol";

export interface OpenAICompatibleClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  /** Maximum silence between request dispatch and SSE bytes, or between SSE
   * chunks. This is a transport boundary, shared by every OpenAI-compatible
   * engine; it prevents a healthy HTTP process from holding a run forever. */
  streamInactivityTimeoutMs?: number;
}

export interface OpenAICompatibleModel {
  id: string;
  object?: string;
  owned_by?: string;
  endpoints?: string[];
  features?: string[];
  capabilities?: Record<string, unknown>;
  type?: string;
  task?: string;
}

interface StreamDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

interface StreamChunk {
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAICompatibleClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiKey: string | undefined;
  readonly #streamInactivityTimeoutMs: number;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiKey = options.apiKey;
    this.#streamInactivityTimeoutMs = options.streamInactivityTimeoutMs ?? 120_000;
    if (!Number.isFinite(this.#streamInactivityTimeoutMs) || this.#streamInactivityTimeoutMs <= 0) {
      throw new TypeError("streamInactivityTimeoutMs must be positive");
    }
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
    return payload.data.flatMap((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id) return [];
      const endpoints = stringArray(value.endpoints);
      const features = stringArray(value.features);
      return [{
        id: value.id,
        ...(typeof value.object === "string" ? { object: value.object } : {}),
        ...(typeof value.owned_by === "string" ? { owned_by: value.owned_by } : {}),
        ...(endpoints ? { endpoints } : {}),
        ...(features ? { features } : {}),
        ...(isRecord(value.capabilities) ? { capabilities: value.capabilities } : {}),
        ...(typeof value.type === "string" ? { type: value.type } : {}),
        ...(typeof value.task === "string" ? { task: value.task } : {}),
      }];
    });
  }

  async *streamChat(
    baseUrl: string,
    modelId: string,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    const watchdog = new StreamInactivityWatchdog(signal, this.#streamInactivityTimeoutMs);
    try {
      const response = await this.#fetch(openAIEndpoint(baseUrl, "chat/completions"), {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: request.messages,
          stream: true,
          // Preserve the caller's OpenAI stream option while retaining the
          // historical default that lets Fitz collect provider token telemetry.
          stream_options: { include_usage: request.streamOptions?.includeUsage ?? true },
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.topP !== undefined ? { top_p: request.topP } : {}),
          ...(request.stop !== undefined ? { stop: request.stop } : {}),
          ...(request.userId ? { user: request.userId } : {}),
          ...(request.tools !== undefined ? { tools: request.tools } : {}),
          ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
          ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
          ...(request.chatTemplateKwargs !== undefined ? { chat_template_kwargs: request.chatTemplateKwargs } : {}),
        }),
        signal: watchdog.signal,
      });
      watchdog.activity();
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        const message = `OpenAI-compatible request failed (${response.status}): ${detail.slice(0, 500)}`;
        if (response.status >= 400 && response.status < 500) {
          throw new InferenceRequestRejectedError(message, response.status);
        }
        throw new Error(message);
      }
      for await (const chunk of parseSseJson(response.body, watchdog.signal, () => watchdog.activity())) {
        if (chunk.error) throw new Error(chunk.error.message ?? "OpenAI-compatible stream failed");
        const choice = chunk.choices?.[0];
        const finishReason = normalizeFinishReason(choice?.finish_reason);
        const providerReasoning = reasoningText(choice?.delta);
        yield {
          text: choice?.delta?.content ?? "",
          ...(providerReasoning ? { reasoning: providerReasoning } : {}),
          ...(choice?.delta?.tool_calls?.length ? { toolCalls: choice.delta.tool_calls } : {}),
          ...(finishReason ? { finishReason } : {}),
          ...(chunk.usage?.prompt_tokens !== undefined ? { promptTokens: chunk.usage.prompt_tokens } : {}),
          ...(chunk.usage?.completion_tokens !== undefined
            ? { completionTokens: chunk.usage.completion_tokens }
            : {}),
        };
      }
    } catch (error) {
      if (watchdog.timedOut) {
        throw new Error(`OpenAI-compatible stream stalled for ${Math.round(this.#streamInactivityTimeoutMs / 1_000)} seconds without receiving data`);
      }
      throw error;
    } finally {
      watchdog.close();
    }
  }

  private headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }
}

function reasoningText(delta: StreamDelta | undefined): string | undefined {
  if (!delta) return undefined;
  return delta.reasoning_content || delta.reasoning || delta.reasoning_text || undefined;
}

/**
 * OpenAI's model-list schema does not require capability metadata. Prefer an
 * explicit chat endpoint/capability when a provider supplies one, then reject
 * well-known non-chat model families for bare OpenAI-style catalogs.
 */
export function supportsChatCompletions(model: OpenAICompatibleModel): boolean {
  if (model.endpoints?.length) {
    return model.endpoints.some((endpoint) => isChatCapability(endpoint));
  }

  const declaredChatCapability = findDeclaredChatCapability(model.capabilities);
  if (declaredChatCapability !== undefined) return declaredChatCapability;

  const declaredType = [model.type, model.task].filter((value): value is string => Boolean(value));
  if (declaredType.some((value) => isChatCapability(value))) return true;
  if (declaredType.some((value) => isNonChatCapability(value))) return false;

  const normalizedId = model.id.trim().toLowerCase();
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(normalizedId));
}

const NON_CHAT_MODEL_PATTERNS = [
  /(^|[-_.:/])(embed(?:ding)?s?|rerank(?:er)?s?|moderation)([-_.:/]|$)/,
  /(^|[-_.:/])(transcrib(?:e|er|ed)?|transcription|whisper|tts)([-_.:/]|$)/,
  /(^|[-_.:/])(dall[-_.]?e|sora|gpt[-_.]?image)([-_.:/]|$)/,
  /(^|[-_.:/])image[-_.]?(?:gen|generation|1)([-_.:/]|$)/,
];

function findDeclaredChatCapability(capabilities: Record<string, unknown> | undefined): boolean | undefined {
  if (!capabilities) return undefined;
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value === "boolean" && isChatCapability(key)) return value;
  }
  return undefined;
}

function isChatCapability(value: string): boolean {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "chat"
    || normalized === "chat-completion"
    || normalized === "chat-completions"
    || normalized === "text-generation"
    || normalized.endsWith("/chat/completions");
}

function isNonChatCapability(value: string): boolean {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return ["embedding", "embeddings", "rerank", "reranking", "moderation", "transcription", "text-to-speech", "image-generation"].includes(normalized);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length ? strings : undefined;
}

export async function* parseSseJson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onActivity?: () => void,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      onActivity?.();
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
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
  }
}

class StreamInactivityWatchdog {
  readonly #controller = new AbortController();
  readonly #timeoutMs: number;
  readonly #source: AbortSignal;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timedOut = false;

  constructor(source: AbortSignal, timeoutMs: number) {
    this.#source = source;
    this.#timeoutMs = timeoutMs;
    source.addEventListener("abort", this.#sourceAborted, { once: true });
    if (source.aborted) this.#sourceAborted();
    else this.activity();
  }

  get signal(): AbortSignal { return this.#controller.signal; }
  get timedOut(): boolean { return this.#timedOut; }

  activity(): void {
    if (this.#controller.signal.aborted) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timedOut = true;
      this.#controller.abort();
    }, this.#timeoutMs);
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#source.removeEventListener("abort", this.#sourceAborted);
  }

  readonly #sourceAborted = (): void => { this.#controller.abort(this.#source.reason); };
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const aborted = () => finish(() => reject(abortError()));
    const finish = (action: () => void) => {
      signal.removeEventListener("abort", aborted);
      action();
    };
    signal.addEventListener("abort", aborted, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export function openAIEndpoint(baseUrl: string, endpoint: string): string {
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
