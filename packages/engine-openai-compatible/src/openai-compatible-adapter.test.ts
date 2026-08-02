import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
import { OpenAICompatibleEngineAdapter } from "./openai-compatible-adapter.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("OpenAICompatibleEngineAdapter", () => {
  it("checks readiness, authenticates, and translates an SSE completion", async () => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((request, response) => handleRequest(request, response, requests));
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const recipe = recipeFor(`http://127.0.0.1:${address.port}`);
    const adapter = new OpenAICompatibleEngineAdapter({ environment: { TEST_OPENAI_KEY: "secret" } });
    expect(await adapter.validateRecipe(recipe)).toEqual({ valid: true, issues: [] });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 1 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await expect(adapter.waitUntilReady(instance, new AbortController().signal)).resolves.toMatchObject({ modelId: "test-model" });

    const chunks = [];
    for await (const chunk of adapter.streamChat(instance, {
      id: "request-1", routeId: "default", messages: [{ role: "user", content: "hello" }],
    }, new AbortController().signal)) chunks.push(chunk);

    expect(chunks).toEqual([
      { text: "hello " },
      { text: "world", finishReason: "stop", promptTokens: 2, completionTokens: 2 },
    ]);
    expect(requests).toEqual([
      { url: "/v1/models", authorization: "Bearer secret" },
      { url: "/v1/chat/completions", authorization: "Bearer secret" },
    ]);
    await expect(adapter.stop(instance, "graceful")).resolves.toMatchObject({ stopped: true });
  });

  it("rejects embedded credentials and insecure remote HTTP by default", async () => {
    const adapter = new OpenAICompatibleEngineAdapter();
    await expect(adapter.validateRecipe(recipeFor("http://user:pass@localhost:1234"))).resolves.toMatchObject({ valid: false });
    await expect(adapter.validateRecipe(recipeFor("http://example.com"))).resolves.toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: "insecure_remote_endpoint" })],
    });
  });

  it("accepts the conventional v1 API base without duplicating the path", async () => {
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((request, response) => handleRequest(request, response, requests)); servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const adapter = new OpenAICompatibleEngineAdapter({ environment: { TEST_OPENAI_KEY: "secret" } }); const recipe = recipeFor(`http://127.0.0.1:${address.port}/v1`); const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 1 }); const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await adapter.waitUntilReady(instance, new AbortController().signal);
    for await (const _chunk of adapter.streamChat(instance, { id: "v1", routeId: "default", messages: [{ role: "user", content: "hello" }] }, new AbortController().signal)) { /* consume */ }
    expect(requests.map((item) => item.url)).toEqual(["/v1/models", "/v1/chat/completions"]);
  });
});

function recipeFor(baseUrl: string): Recipe {
  return {
    id: "external", playbookId: "external", displayName: "External model", adapter: "openai-compatible",
    modelId: "test-model", contextTokens: 8192,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: { baseUrl, apiKeyEnv: "TEST_OPENAI_KEY" },
  };
}

function handleRequest(request: IncomingMessage, response: ServerResponse, requests: Array<{ url?: string; authorization?: string }>): void {
  requests.push({ ...(request.url ? { url: request.url } : {}), ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
  if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[]}'); return; }
  if (request.url === "/v1/chat/completions") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    return;
  }
  response.writeHead(404); response.end();
}
