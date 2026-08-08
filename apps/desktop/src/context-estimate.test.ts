import { describe, expect, it } from "vitest";
import { estimateTokens, estimateTranscriptContext } from "./context-estimate.js";

function entry(sequence: number, kind: string, content: Record<string, unknown>): Record<string, unknown> {
  return { sequence, kind, content };
}

describe("estimateTokens", () => {
  it("counts roughly one token per four characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefghij")).toBe(3);
  });
});

describe("estimateTranscriptContext", () => {
  it("counts user and assistant message text", () => {
    const entries = [
      entry(1, "message", { text: "hello" }),
      entry(2, "message", { text: "hi there" }),
    ];
    expect(estimateTranscriptContext(entries)).toBe(estimateTokens("hello") + estimateTokens("hi there"));
  });

  it("counts reasoning, tool calls, and tool results toward the context", () => {
    const entries = [
      entry(1, "message", { text: "inspect this" }),
      entry(2, "reasoning", { text: "Let me look" }),
      entry(3, "tool-call", { toolName: "read", input: { path: "a.txt" } }),
      entry(4, "tool-result", { result: "file contents here" }),
    ];
    expect(estimateTranscriptContext(entries)).toBe(
      estimateTokens("inspect this") + estimateTokens("Let me look") + estimateTokens('{"path":"a.txt"}') + estimateTokens("file contents here"),
    );
  });

  it("counts only entries after the last manual compaction checkpoint", () => {
    const entries = [
      entry(1, "message", { text: "old" }),
      entry(2, "compaction", { summary: "so far", manual: true, throughSequence: 1 }),
      entry(3, "message", { text: "new" }),
      entry(4, "tool-result", { result: "more" }),
    ];
    expect(estimateTranscriptContext(entries)).toBe(
      estimateTokens("Conversation summary:\nso far") + estimateTokens("new") + estimateTokens("more"),
    );
  });

  it("honors automatic compaction entries as checkpoints too", () => {
    const entries = [
      entry(1, "message", { text: "all" }),
      entry(2, "compaction", { summary: "auto", throughSequence: 1 }),
      entry(3, "message", { text: "kept" }),
    ];
    expect(estimateTranscriptContext(entries)).toBe(estimateTokens("Conversation summary:\nauto") + estimateTokens("kept"));
  });

  it("returns zero for an empty transcript", () => {
    expect(estimateTranscriptContext([])).toBe(0);
  });
});
