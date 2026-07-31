import { describe, expect, it } from "vitest";
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
});
