import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { broadFilesystemScanReason, buildFitzSystemInstructions, createSessionLookupTool, formatSessionSnapshot, PiAgentRuntime, readEnabledExtensionDirs, SESSION_LOOKUP_TOOL, type PiSession, type PiSessionReader, type PiSessionSnapshot } from "./pi-agent-runtime.js";

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

  it("translates Pi thinking events into the reasoning stream, separate from text", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({
      cwd: "C:/project",
      createSession: async () => ({
        subscribe: (next) => { listener = next; return () => undefined; },
        prompt: async () => {
          listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Let me " } });
          listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "inspect it." } });
          listener({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "Let me inspect it." } });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Inspection complete." } });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "plan" }] })) events.push(event);
    expect(events).toEqual([
      { type: "reasoning.delta", text: "Let me " },
      { type: "reasoning.delta", text: "inspect it." },
      { type: "reasoning.completed" },
      { type: "assistant.delta", text: "Inspection complete." },
    ]);
  });

  it("passes the configured thinking level through the session factory boundary", async () => {
    let seenThinkingLevel: string | undefined;
    const runtime = new PiAgentRuntime({
      thinkingLevel: "medium",
      createSession: async (options) => {
        seenThinkingLevel = options.thinkingLevel;
        return { subscribe: (listener) => { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }); return () => undefined; }, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined };
      },
    });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(seenThinkingLevel).toBe("medium");
    expect(events).toEqual([{ type: "assistant.delta", text: "ok" }]);
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

  it("forwards steering messages to the live session and emits user.steer at delivery", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const steered: string[] = [];
    const runtime = new PiAgentRuntime({
      cwd: "C:/project",
      createSession: async () => ({
        subscribe: (next) => { listener = next; return () => undefined; },
        prompt: async () => {
          listener({ type: "message_start", message: { role: "user", content: "initial prompt" } });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
          await promptGate;
        },
        steer: async (text) => { steered.push(text); },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const run = runtime.run({ model: "fast", messages: [{ role: "user", content: "initial prompt" }] });
    const events: Array<{ type: string; text?: string }> = [];
    const collected = (async () => { for await (const event of run) events.push(event); })();
    // Wait for the session to be created and its subscription to become active.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await run.steer!("focus on the tests");
    expect(steered).toEqual(["focus on the tests"]);
    // Pi delivers the steering message by emitting a user message_start.
    listener({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "focus on the tests" }] } });
    listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " second" } });
    releasePrompt();
    await collected;
    expect(events).toEqual([
      { type: "assistant.delta", text: "working" },
      { type: "user.steer", text: "focus on the tests" },
      { type: "assistant.delta", text: " second" },
    ]);
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

  it("routes read-only tools through the host policy engine when configured", async () => {
    const requests: Array<{ toolName: string; cwd?: string; runId?: string }> = [];
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({
      cwd: "C:/project",
      toolPolicy: async (request) => { requests.push(request); return { action: "block", reason: `blocked ${request.toolName}` }; },
      createSession: async (options) => ({
        subscribe: (next) => { listener = next; listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }); return () => undefined; },
        prompt: async () => {
          const read = await options.evaluateTool!({ toolCallId: "read-1", toolName: "read", input: { path: "C:/Users/me/.ssh/id_rsa" } });
          expect(read).toEqual({ action: "block", reason: "blocked read" });
          const bash = await options.evaluateTool!({ toolCallId: "bash-1", toolName: "bash", input: { command: "rm x" } });
          expect(bash).toEqual({ action: "block", reason: "blocked bash" });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "checked" } });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const events = [];
    for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "check" }] }, undefined, { runId: "run-abc" })) events.push(event);
    expect(requests).toEqual([
      expect.objectContaining({ toolName: "read", cwd: "C:/project", runId: "run-abc" }),
      expect.objectContaining({ toolName: "bash", cwd: "C:/project", runId: "run-abc" }),
    ]);
    expect(events).toEqual([{ type: "assistant.delta", text: "done" }, { type: "assistant.delta", text: "checked" }]);
  });

  it("keeps Read only mode blocking writes while the policy still gates reads", async () => {
    const evaluated: string[] = [];
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({
      cwd: "C:/project",
      toolPolicy: async (request) => { evaluated.push(request.toolName); return { action: "allow" }; },
      createSession: async (options) => ({
        subscribe: (next) => { listener = next; listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }); return () => undefined; },
        prompt: async () => {
          const bash = await options.evaluateTool!({ toolCallId: "bash-1", toolName: "bash", input: { command: "pwd" } });
          expect(bash).toEqual({ action: "block", reason: "bash is blocked in Read only mode" });
          const read = await options.evaluateTool!({ toolCallId: "read-1", toolName: "read", input: { path: "README.md" } });
          expect(read).toEqual({ action: "allow" });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "read-only ok" } });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const events = [];
    for await (const event of runtime.run({ model: "fast", accessMode: "read-only", messages: [{ role: "user", content: "inspect" }] })) events.push(event);
    expect(evaluated).toEqual(["read"]);
    expect(events).toEqual([{ type: "assistant.delta", text: "done" }, { type: "assistant.delta", text: "read-only ok" }]);
  });

  it("escalates policy ask outcomes to the durable approval gate", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({
      cwd: "C:/project",
      toolPolicy: async () => ({ action: "ask" }),
      requestToolApproval: (request) => ({ approvalId: "approval-1", decision: Promise.resolve(request.toolName === "bash" ? "approved" : "denied") }),
      createSession: async (options) => ({
        subscribe: (next) => { listener = next; listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }); return () => undefined; },
        prompt: async () => {
          const decision = await options.evaluateTool!({ toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } });
          expect(decision).toEqual({ action: "allow" });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "approved" } });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const events = [];
    for await (const event of runtime.run({ model: "fast", sessionId: "session-1", accessMode: "ask", messages: [{ role: "user", content: "check" }] })) events.push(event);
    expect(events).toEqual([
      { type: "assistant.delta", text: "done" },
      { type: "tool.approval.requested", approvalId: "approval-1", toolCallId: "bash-1", toolName: "bash", input: { command: "git status" } },
      { type: "tool.approval.resolved", approvalId: "approval-1", toolCallId: "bash-1", toolName: "bash", decision: "approved" },
      { type: "assistant.delta", text: "approved" },
    ]);
  });

  it("registers host custom tools with the run context", async () => {
    const seen: Array<{ cwd: string; runId?: string }> = [];
    const runtime = new PiAgentRuntime({
      cwd: "C:/project",
      customTools: (context) => { seen.push(context); return []; },
      createSession: async (options) => {
        expect(options.customTools).toEqual([]);
        return { subscribe: (listener) => { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }); return () => undefined; }, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined };
      },
    });
    const events = [];
    for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hi" }] }, undefined, { runId: "run-xyz" })) events.push(event);
    expect(seen).toEqual([{ cwd: "C:/project", runId: "run-xyz" }]);
    expect(events).toEqual([{ type: "assistant.delta", text: "ok" }]);
  });
});

describe("fitz.session session lookup tool", () => {
  const snapshot: PiSessionSnapshot = {
    title: "Find the session",
    status: "completed",
    updatedAt: "2026-08-06T00:31:00Z",
    messages: [
      { sequence: 1, role: "user", text: "Where is my session?" },
      { sequence: 2, role: "assistant", text: "Let me look it up." },
    ],
  };

  it("formats a snapshot as a readable transcript", () => {
    expect(formatSessionSnapshot(snapshot)).toBe([
      "Session: Find the session",
      "Status: completed",
      "Updated: 2026-08-06T00:31:00Z",
      "[1] USER: Where is my session?",
      "[2] ASSISTANT: Let me look it up.",
    ].join("\n"));
  });

  it("returns the formatted transcript when the session exists", async () => {
    const tool = createSessionLookupTool(async (sessionId) => (sessionId === "abc-123" ? snapshot : undefined));
    expect(tool.name).toBe(SESSION_LOOKUP_TOOL);
    const result = await tool.execute("call-1", { sessionId: "abc-123" });
    expect(result).toEqual({
      content: [{ type: "text", text: formatSessionSnapshot(snapshot) }],
      details: { source: "fitz.session" },
    });
  });

  it("reports a missing session gracefully", async () => {
    const tool = createSessionLookupTool(async () => undefined);
    const result = await tool.execute("call-1", { sessionId: "missing" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "No Fitz session found with id missing." });
  });

  it("turns reader failures into an agent-readable message instead of crashing the tool", async () => {
    const tool = createSessionLookupTool(async () => { throw new Error("store locked"); });
    const result = await tool.execute("call-1", { sessionId: "abc-123" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "Could not read Fitz session abc-123: store locked" });
  });

  it("forwards the session reader to the session factory boundary", async () => {
    const reader: PiSessionReader = async () => snapshot;
    let seenReader: PiSessionReader | undefined;
    const runtime = new PiAgentRuntime({
      sessionReader: reader,
      createSession: async (options) => {
        seenReader = options.sessionReader;
        return { subscribe: (listener) => { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }); return () => undefined; }, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined };
      },
    });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(seenReader).toBe(reader);
    expect(events).toEqual([{ type: "assistant.delta", text: "ok" }]);
  });

  it("does not surface a session reader when none is configured", async () => {
    let seenReader: unknown = "unset";
    const runtime = new PiAgentRuntime({
      createSession: async (options) => {
        seenReader = options.sessionReader;
        return { subscribe: (listener) => { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }); return () => undefined; }, prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined };
      },
    });
    const events = []; for await (const event of runtime.run({ model: "fast", messages: [{ role: "user", content: "hi" }] })) events.push(event);
    expect(seenReader).toBeUndefined();
    expect(events).toEqual([{ type: "assistant.delta", text: "ok" }]);
  });

  it("is treated as read-only by the approval gate", async () => {
    let listener: Parameters<PiSession["subscribe"]>[0] = () => undefined;
    const runtime = new PiAgentRuntime({
      sessionReader: async () => snapshot,
      createSession: async (options) => ({
        subscribe: (next) => { listener = next; return () => undefined; },
        prompt: async () => {
          const decision = await options.approveTool({ toolCallId: "fitz-session-1", toolName: SESSION_LOOKUP_TOOL, input: { sessionId: "abc-123" } });
          expect(decision).toEqual({ allowed: true });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "read" } });
        },
        abort: async () => undefined,
        dispose: () => undefined,
      }),
    });
    const events = [];
    for await (const event of runtime.run({ model: "fast", accessMode: "read-only", messages: [{ role: "user", content: "read my session" }] })) events.push(event);
    expect(events).toEqual([{ type: "assistant.delta", text: "read" }]);
  });
});

describe("readEnabledExtensionDirs", () => {
  it("returns the dirs of enabled registry packages only", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fitz-pi-registry-"));
    try {
      await mkdir(join(agentDir, "extensions", "pi-a"), { recursive: true });
      await mkdir(join(agentDir, "extensions", "pi-b"), { recursive: true });
      await writeFile(join(agentDir, "extensions", "registry.json"), JSON.stringify({
        version: 1,
        packages: [
          { source: "npm:pi-a", name: "pi-a", enabled: true },
          { source: "npm:pi-b", name: "pi-b", enabled: false },
          { source: "local:/missing", name: "pi-gone", enabled: true },
        ],
      }));
      // Disabled packages are excluded, and so are enabled entries whose dir vanished.
      expect(await readEnabledExtensionDirs(agentDir)).toEqual([join(agentDir, "extensions", "pi-a")]);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });

  it("returns an empty list when the registry is missing or corrupt", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "fitz-pi-registry-"));
    try {
      expect(await readEnabledExtensionDirs(agentDir)).toEqual([]);
      await mkdir(join(agentDir, "extensions"), { recursive: true });
      await writeFile(join(agentDir, "extensions", "registry.json"), "not json", "utf8");
      expect(await readEnabledExtensionDirs(agentDir)).toEqual([]);
    } finally { await rm(agentDir, { recursive: true, force: true }); }
  });
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
