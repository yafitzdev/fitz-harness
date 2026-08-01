import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgentRuntime, type PiSession } from "./pi-agent-runtime.js";

describe("PiAgentRuntime", () => {
  it("translates Pi text and tool lifecycle events behind the Fitz boundary", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined; let disposed = false;
    const runtime = new PiAgentRuntime({ cwd: "C:/project", tools: ["read"], createSession: async (options) => { expect(options.tools).toEqual(["read"]); return { subscribe: (next) => { listener = next; return () => undefined; }, prompt: async (prompt) => { expect(prompt).toContain("USER: inspect this"); listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }); listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" }); listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "done" }); }, abort: async () => undefined, dispose: () => { disposed = true; } }; } });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "inspect this" }] })) events.push(event);
    expect(events).toEqual([{ type: "assistant.delta", text: "hello" }, { type: "tool.started", toolCallId: "call-1", toolName: "read" }, { type: "tool.completed", toolCallId: "call-1", toolName: "read", result: "done" }]); expect(disposed).toBe(true);
  });

  it("propagates Pi session failures", async () => {
    const runtime = new PiAgentRuntime({ createSession: async () => { throw new Error("Pi unavailable"); } }); const consume = async () => { for await (const _event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hello" }] })) { /* consume */ } }; await expect(consume()).rejects.toThrow("Pi unavailable");
  });

  it("does not report an empty Pi turn as a successful run", async () => {
    const runtime = new PiAgentRuntime({ createSession: async () => ({ subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined }) });
    const consume = async () => { for await (const _event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hello" }] })) { /* consume */ } };
    await expect(consume()).rejects.toThrow("without an assistant response");
  });

  it("runs the real Pi loop against the selected Fitz route and executes coding tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fitz-pi-"));
    await writeFile(join(cwd, "probe.txt"), "PI_TOOL_OK", "utf8");
    const requests: any[] = [];
    const server = createServer(async (request, response) => handlePiRequest(request, response, requests));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected server address");
    try {
      const runtime = new PiAgentRuntime({ cwd, baseUrl: `http://127.0.0.1:${address.port}/v1` });
      const events = [];
      for await (const event of runtime.run({ model: "smart", messages: [{ role: "user", content: "Read probe.txt" }], maxTokens: 256 })) events.push(event);
      expect(requests).toHaveLength(2);
      expect(requests[0].model).toBe("smart");
      expect(requests[0].tools[0]).toMatchObject({ type: "function", function: { name: "read" } });
      expect(requests[0].tools.map((tool: any) => tool.function?.name ?? tool.name)).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls"]));
      expect(requests[1].messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("PI_TOOL_OK"))).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool.started", toolName: "read" }),
        expect.objectContaining({ type: "tool.completed", toolName: "read" }),
        expect.objectContaining({ type: "assistant.delta", text: "Pi read PI_TOOL_OK" }),
      ]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

async function handlePiRequest(request: IncomingMessage, response: ServerResponse, requests: any[]): Promise<void> {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (requests.length === 1) {
    sse(response, { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    sse(response, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: "read", arguments: '{"path":"probe.txt"}' } }] }, finish_reason: null }] });
    sse(response, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  } else {
    sse(response, { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    sse(response, { choices: [{ index: 0, delta: { content: "Pi read PI_TOOL_OK" }, finish_reason: null }] });
    sse(response, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  }
  response.end("data: [DONE]\n\n");
}

function sse(response: ServerResponse, value: Record<string, any>): void {
  const usage = value.usage ? { ...value.usage, total_tokens: value.usage.prompt_tokens + value.usage.completion_tokens } : undefined;
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "smart",
    ...value,
    ...(usage ? { usage } : {}),
  })}\n\n`);
}
