import { describe, expect, it } from "vitest";
import { parseChatCompletionRequest } from "./openai.js";

describe("parseChatCompletionRequest", () => {
  it("parses a minimal request", () => {
    expect(
      parseChatCompletionRequest({
        model: "default-agent",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    ).toEqual({
      model: "default-agent",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
  });

  it("rejects invalid messages", () => {
    expect(() =>
      parseChatCompletionRequest({
        model: "default-agent",
        messages: [{ role: "user", content: 42 }],
      }),
    ).toThrow("content must be a string");
  });

  it("preserves OpenAI function tools and assistant tool-call history", () => {
    expect(parseChatCompletionRequest({
      model: "default",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] },
        { role: "tool", content: "hello", tool_call_id: "call-1" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" }, strict: true } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    })).toMatchObject({
      messages: [
        expect.objectContaining({ role: "assistant", content: "", tool_calls: [expect.objectContaining({ id: "call-1" })] }),
        expect.objectContaining({ role: "tool", tool_call_id: "call-1" }),
      ],
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: "read" }) })],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
  });

  it("normalizes OpenAI text content parts for local inference", () => {
    expect(parseChatCompletionRequest({
      model: "default",
      messages: [{ role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "agent" }] }],
    }).messages[0]?.content).toBe("hello agent");
  });
});
