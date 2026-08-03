import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadFilesystemScanReason, buildFitzSystemInstructions, PiAgentRuntime, type PiSession } from "./pi-agent-runtime.js";

describe("PiAgentRuntime", () => {
  it("passes Fitz runtime locations to the session factory", async () => {
    const runtime = new PiAgentRuntime({
      cwd: "C:/projects/example",
      agentDir: "C:/Fitz/pi",
      llmRoot: "C:/Users/example/.llm",
      createSession: async (options) => {
        expect(options).toMatchObject({ cwd: "C:/projects/example", agentDir: "C:/Fitz/pi", llmRoot: "C:/Users/example/.llm" });
        return { subscribe: (listener) => { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ready" } }); return () => undefined; }, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined };
      },
    });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "where" }] })) events.push(event);
    expect(events).toEqual([{ type: "assistant.delta", text: "ready" }]);
  });

  it("builds authoritative Fitz paths into the appended system instructions", () => {
    const prompt = buildFitzSystemInstructions({ cwd: "C:/project", agentDir: "C:/Fitz/pi", llmRoot: "C:/Users/me/.llm" });
    expect(prompt).toContain("C:/Fitz/pi/extensions");
    expect(prompt).toContain("C:/Users/me/.llm/engines");
    expect(prompt).toContain("C:/Users/me/.llm/models");
    expect(prompt).toContain("Do not inspect ~/.pi");
    expect(prompt).toContain("Never recursively search /");
    expect(prompt).toContain("Do not read or reveal authentication files");
  });

  it("blocks filesystem-wide shell discovery while allowing scoped searches", () => {
    expect(broadFilesystemScanReason("bash", { command: 'find / -maxdepth 5 -type d -name "extensions"' })).toContain("unbounded filesystem scan");
    expect(broadFilesystemScanReason("bash", { command: "find . -type f -name '*.ts'" })).toBeUndefined();
    expect(broadFilesystemScanReason("bash", { command: "find 'C:/Fitz/pi/extensions' -type f" })).toBeUndefined();
    expect(broadFilesystemScanReason("bash", { command: "Get-ChildItem C:\\ -Recurse" })).toContain("unbounded filesystem scan");
    expect(broadFilesystemScanReason("bash", { command: "Get-ChildItem C:\\Fitz\\pi -Recurse" })).toBeUndefined();
  });

  it("translates Pi text and tool lifecycle events behind the Fitz boundary", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined; let disposed = false;
    const runtime = new PiAgentRuntime({ cwd: "C:/project", tools: ["read"], apiKey: "private-pi-token", createSession: async (options) => { expect(options.tools).toEqual(["read"]); expect(options.apiKey).toBe("private-pi-token"); return { subscribe: (next) => { listener = next; return () => undefined; }, prompt: async (prompt) => { expect(prompt).toContain("USER: inspect this"); listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } }); listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } }); listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "done" }); }, abort: async () => undefined, dispose: () => { disposed = true; } }; } });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "inspect this" }] })) events.push(event);
    expect(events).toEqual([{ type: "assistant.delta", text: "hello" }, { type: "tool.started", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } }, { type: "tool.completed", toolCallId: "call-1", toolName: "read", result: "done" }]); expect(disposed).toBe(true);
  });

  it("propagates Pi session failures", async () => {
    const runtime = new PiAgentRuntime({ createSession: async () => { throw new Error("Pi unavailable"); } }); const consume = async () => { for await (const _event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hello" }] })) { /* consume */ } }; await expect(consume()).rejects.toThrow("Pi unavailable");
  });

  it("does not report an empty Pi turn as a successful run", async () => {
    const runtime = new PiAgentRuntime({ createSession: async () => ({ subscribe: () => () => undefined, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined }) });
    const consume = async () => { for await (const _event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hello" }] })) { /* consume */ } };
    await expect(consume()).rejects.toThrow("without an assistant response");
  });

  it("pauses risky tools in Ask first mode and emits the durable approval lifecycle", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({
      requestToolApproval: (request) => ({ approvalId: "approval-1", decision: Promise.resolve(request.toolName === "bash" ? "approved" : "denied") }),
      createSession: async (options) => ({
        subscribe: (next) => { listener = next; return () => undefined; },
        prompt: async () => {
          const decision = await options.approveTool({ toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } });
          expect(decision.allowed).toBe(true);
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const events = [];
    for await (const event of runtime.run({ model: "fast", sessionId: "session-1", accessMode: "ask", messages: [{ role: "user", content: "check" }] })) events.push(event);
    expect(events).toEqual([
      { type: "tool.approval.requested", approvalId: "approval-1", toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } },
      { type: "tool.approval.resolved", approvalId: "approval-1", toolCallId: "bash-1", toolName: "bash", decision: "approved" },
      { type: "assistant.delta", text: "done" },
    ]);
  });

  it("allows inspection but blocks commands in Read only mode", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({ createSession: async (options) => ({ subscribe: (next) => { listener = next; return () => undefined; }, prompt: async () => {
      expect(await options.approveTool({ toolCallId: "read-1", toolName: "read", input: { path: "README.md" } })).toEqual({ allowed: true });
      expect(await options.approveTool({ toolCallId: "bash-1", toolName: "bash", input: { command: "pwd" } })).toEqual({ allowed: false, reason: "bash is blocked in Read only mode" });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "blocked" } });
    }, abort: async () => undefined, dispose: () => undefined }) });
    const events = []; for await (const event of runtime.run({ model: "fast", accessMode: "read-only", messages: [{ role: "user", content: "inspect" }] })) events.push(event);
    expect(events).toEqual([{ type: "assistant.delta", text: "blocked" }]);
  });

  it("runs the real Pi loop against the selected Fitz route and executes coding tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fitz-pi-"));
    await writeFile(join(cwd, "probe.txt"), "PI_TOOL_OK", "utf8");
    const requests: any[] = []; const authorizations: Array<string | undefined> = [];
    const server = createServer(async (request, response) => handlePiRequest(request, response, requests, authorizations));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected server address");
    try {
      const runtime = new PiAgentRuntime({ cwd, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "private-pi-token" });
      const events = [];
      for await (const event of runtime.run({ model: "smart", messages: [{ role: "user", content: "Read probe.txt" }], maxTokens: 256 })) events.push(event);
      expect(requests).toHaveLength(2);
      expect(authorizations).toEqual(["Bearer private-pi-token", "Bearer private-pi-token"]);
      expect(requests[0].model).toBe("smart");
      expect(requests[0].tools[0]).toMatchObject({ type: "function", function: { name: "read" } });
      expect(requests[0].tools.map((tool: any) => tool.function?.name ?? tool.name)).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls"]));
      expect(requests[1].messages.some((message: any) => message.role === "tool" && JSON.stringify(message.content).includes("PI_TOOL_OK"))).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool.started", toolName: "read", input: { path: "probe.txt" } }),
        expect.objectContaining({ type: "tool.completed", toolName: "read" }),
        expect.objectContaining({ type: "assistant.delta", text: "Pi read PI_TOOL_OK" }),
      ]));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("blocks a denied command before the real Pi SDK executes it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fitz-pi-denied-")); const requests: any[] = [];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk; requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        sse(response, { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-bash", type: "function", function: { name: "bash", arguments: '{"command":"echo SHOULD_NOT_EXIST > denied.txt"}' } }] }, finish_reason: null }] });
        sse(response, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      } else {
        sse(response, { choices: [{ index: 0, delta: { role: "assistant", content: "Command denied" }, finish_reason: null }] });
        sse(response, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 4 } });
      }
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected server address");
    try {
      const runtime = new PiAgentRuntime({ cwd, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestToolApproval: () => ({ approvalId: "denied-1", decision: Promise.resolve("denied") }) });
      const events = []; for await (const event of runtime.run({ model: "fast", sessionId: "session-1", accessMode: "ask", messages: [{ role: "user", content: "write a marker" }], maxTokens: 128 })) events.push(event);
      await expect(import("node:fs/promises").then(({ access }) => access(join(cwd, "denied.txt")))).rejects.toThrow();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool.approval.requested", approvalId: "denied-1", toolName: "bash" }),
        expect.objectContaining({ type: "tool.approval.resolved", decision: "denied" }),
        expect.objectContaining({ type: "assistant.delta", text: "Command denied" }),
      ]));
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true }); }
  }, 30_000);
});

async function handlePiRequest(request: IncomingMessage, response: ServerResponse, requests: any[], authorizations: Array<string | undefined>): Promise<void> {
  let body = "";
  for await (const chunk of request) body += chunk;
  authorizations.push(request.headers.authorization);
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
