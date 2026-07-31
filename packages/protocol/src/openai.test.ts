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
});
