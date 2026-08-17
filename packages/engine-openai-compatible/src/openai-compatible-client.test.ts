import { InferenceRequestRejectedError } from "@fitz/inference-core";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleClient, supportsChatCompletions } from "./openai-compatible-client.js";

describe("OpenAICompatibleClient model discovery", () => {
  it("preserves optional provider capability metadata", async () => {
    const client = new OpenAICompatibleClient({
      fetch: async () => new Response(JSON.stringify({
        data: [{
          id: "command-a",
          endpoints: ["chat"],
          features: ["tool-use"],
          capabilities: { chat_completions: true },
          type: "language",
          task: "chat-completion",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await expect(client.listModels("https://example.test/v1")).resolves.toEqual([{
      id: "command-a",
      endpoints: ["chat"],
      features: ["tool-use"],
      capabilities: { chat_completions: true },
      type: "language",
      task: "chat-completion",
    }]);
  });

  it("accepts chat models and rejects non-chat catalog entries", () => {
    expect(supportsChatCompletions({ id: "command-a", endpoints: ["chat"] })).toBe(true);
    expect(supportsChatCompletions({ id: "custom-chat", capabilities: { chat_completions: true } })).toBe(true);
    expect(supportsChatCompletions({ id: "unknown-instruct-model" })).toBe(true);

    expect(supportsChatCompletions({ id: "command-a", endpoints: ["embed"] })).toBe(false);
    expect(supportsChatCompletions({ id: "embed-v4.0" })).toBe(false);
    expect(supportsChatCompletions({ id: "rerank-v3.5" })).toBe(false);
    expect(supportsChatCompletions({ id: "cohere-transcribe-03-2026" })).toBe(false);
    expect(supportsChatCompletions({ id: "whisper-1" })).toBe(false);
    expect(supportsChatCompletions({ id: "omni-moderation-latest" })).toBe(false);
    expect(supportsChatCompletions({ id: "gpt-image-1" })).toBe(false);
  });

  it("surfaces reasoning_content deltas as reasoning", async () => {
    const client = new OpenAICompatibleClient({
      fetch: async () => new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"Hi!"},"finish_reason":"stop"}]}\n\n'
        + "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

    const deltas = [];
    for await (const delta of client.streamChat("https://example.test/v1", "deepseek-v4-pro", {
      id: "req-1", routeId: "probe", messages: [{ role: "user", content: "Say hi." }],
    }, new AbortController().signal)) {
      deltas.push(delta);
    }
    expect(deltas[0]).toEqual(expect.objectContaining({ text: "", reasoning: "Let me think" }));
    expect(deltas[1]).toEqual(expect.objectContaining({ text: "Hi!", finishReason: "stop" }));
    expect(deltas[1].reasoning).toBeUndefined();
  });

  it("forwards normalized reasoning history and optional chat-template controls", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new OpenAICompatibleClient({
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    for await (const _delta of client.streamChat("https://example.test/v1", "qwen", {
      id: "req-history", routeId: "default",
      messages: [{ role: "assistant", content: "answer", reasoning_content: "reasoning" }],
      chatTemplateKwargs: { enable_thinking: true, preserve_thinking: true },
    }, new AbortController().signal)) { /* consume */ }
    expect(body).toMatchObject({
      messages: [{ role: "assistant", content: "answer", reasoning_content: "reasoning" }],
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    });
  });

  it("forwards an explicit include_usage choice to the provider", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new OpenAICompatibleClient({
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    for await (const _delta of client.streamChat("https://example.test/v1", "qwen", {
      id: "req-usage", routeId: "default", messages: [{ role: "user", content: "hello" }],
      streamOptions: { includeUsage: true },
    }, new AbortController().signal)) { /* consume */ }
    expect(body).toMatchObject({ stream_options: { include_usage: true } });
  });

  it.each(["reasoning", "reasoning_text"])("normalizes provider %s deltas as reasoning", async (field) => {
    const client = new OpenAICompatibleClient({
      fetch: async () => new Response(
        `data: {"choices":[{"delta":{"${field}":"Thinking"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });
    const deltas = [];
    for await (const delta of client.streamChat("https://example.test/v1", "model", {
      id: "req-alias", routeId: "probe", messages: [{ role: "user", content: "Work" }],
    }, new AbortController().signal)) deltas.push(delta);
    expect(deltas[0]).toEqual(expect.objectContaining({ reasoning: "Thinking" }));
  });

  it("classifies provider 4xx responses as request rejections", async () => {
    const client = new OpenAICompatibleClient({
      fetch: async () => new Response(JSON.stringify({ error: { message: "context too large" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(collect(client.streamChat("https://example.test/v1", "local-model", {
      id: "req-rejected", routeId: "fast", messages: [{ role: "user", content: "large prompt" }],
    }, new AbortController().signal))).rejects.toEqual(expect.objectContaining({
      name: "InferenceRequestRejectedError",
      statusCode: 400,
    }));
    await expect(collect(client.streamChat("https://example.test/v1", "local-model", {
      id: "req-rejected-2", routeId: "fast", messages: [{ role: "user", content: "large prompt" }],
    }, new AbortController().signal))).rejects.toBeInstanceOf(InferenceRequestRejectedError);
  });
});

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _delta of stream) {
    // Exhaust the stream so request and streaming errors surface to the caller.
  }
}
