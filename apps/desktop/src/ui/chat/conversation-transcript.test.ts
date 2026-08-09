// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscript } from "./conversation-transcript.js";

beforeEach(() => document.body.replaceChildren());

describe("ConversationTranscript", () => {
  it("restores messages, commentary, tools, reasoning, compaction, and history", () => {
    const messages = document.createElement("main");
    const toolRow = document.createElement("div");
    const reasoningRow = document.createElement("div");
    const activity = {
      clear: vi.fn(), appendTool: vi.fn(() => toolRow), completeTool: vi.fn(),
      appendReasoning: vi.fn(() => reasoningRow), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn(() => document.createElement("div")),
    };
    const appendMessage = vi.fn(() => document.createElement("div"));
    const appendCommentary = vi.fn(() => document.createElement("div"));
    const rebuildHistory = vi.fn();
    const view = new ConversationTranscript({ messages, activity, appendMessage, appendCommentary, rebuildHistory });
    const tokens = view.restore([
      { kind: "message", role: "user", content: { text: "hello" } },
      { kind: "message", role: "assistant", content: { phase: "commentary", text: "checking" } },
      { kind: "tool-call", id: "call", content: { toolCallId: "call", toolName: "read", input: { path: "a.ts" } } },
      { kind: "tool-result", id: "result", content: { toolCallId: "call", result: "source" } },
      { kind: "reasoning", content: { text: "thinking" } },
      { kind: "compaction", content: { manual: false } },
    ]);
    expect(rebuildHistory).toHaveBeenCalledWith(["hello"]);
    expect(appendMessage).toHaveBeenCalledWith("user", "hello", undefined);
    expect(appendCommentary).toHaveBeenCalledWith("checking", undefined);
    expect(activity.completeTool).toHaveBeenCalledWith(toolRow, "read", { path: "a.ts" }, "source", false, undefined);
    expect(activity.appendReasoningDelta).toHaveBeenCalledWith(reasoningRow, "thinking");
    expect(activity.appendContext).toHaveBeenCalledWith("Context automatically compacted", undefined);
    expect(tokens).toBeGreaterThan(0);
  });

  it("creates a fallback tool row for orphan results", () => {
    const messages = document.createElement("main");
    const row = document.createElement("div");
    const activity = { clear: vi.fn(), appendTool: vi.fn(() => row), completeTool: vi.fn(), appendReasoning: vi.fn(), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() };
    new ConversationTranscript({ messages, activity, appendMessage: vi.fn(), appendCommentary: vi.fn(), rebuildHistory: vi.fn() })
      .restore([{ kind: "tool-result", id: "late", content: { toolName: "bash", result: "ok" } }]);
    expect(activity.appendTool).toHaveBeenCalledWith("bash", undefined, "late", true, undefined);
    expect(activity.completeTool).toHaveBeenCalledWith(row, "bash", undefined, "ok", false, undefined);
  });
});
