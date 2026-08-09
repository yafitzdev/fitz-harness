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

  it("records the highest durable event sequence for each restored run", () => {
    const view = new ConversationTranscript({ messages: document.createElement("main"), activity: { clear: vi.fn(), appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(), appendReasoning: vi.fn(() => document.createElement("div")), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() }, appendMessage: vi.fn(), appendCommentary: vi.fn(), rebuildHistory: vi.fn() });
    view.restore([
      { kind: "message", role: "assistant", content: { text: "a", runId: "run-1", eventSequence: 4 } },
      { kind: "reasoning", role: "assistant", content: { text: "b", runId: "run-1", eventSequence: 7 } },
      { kind: "message", role: "assistant", content: { text: "c", runId: "run-2", eventSequence: 3 } },
    ]);
    expect(view.eventSequenceForRun("run-1")).toBe(7);
    expect(view.eventSequenceForRun("run-2")).toBe(3);
  });

  it("hydrates long transcripts in bounded turn-aligned windows", () => {
    const messages = document.createElement("main");
    const appendMessage = vi.fn(() => document.createElement("div"));
    const view = new ConversationTranscript({ messages, activity: { clear: vi.fn(), appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(), appendReasoning: vi.fn(() => document.createElement("div")), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() }, appendMessage, appendCommentary: vi.fn(), rebuildHistory: vi.fn() });
    view.restore(Array.from({ length: 600 }, (_, index) => ({ kind: "message", role: index % 3 === 0 ? "user" : "assistant", content: { text: String(index) } })));
    expect(appendMessage.mock.calls.length).toBeLessThanOrEqual(252);
    expect(messages.querySelector(".transcript-load-earlier")?.textContent).toContain("earlier events");
  });

  it("loads older server pages lazily while preserving recent prompt history", async () => {
    const messages = document.createElement("main");
    const rebuildHistory = vi.fn();
    const loadEarlier = vi.fn(async () => ({ data: [{ sequence: 1, kind: "message", role: "user", content: { text: "old prompt" } }], page: { hasEarlier: false } }));
    const view = new ConversationTranscript({
      messages,
      activity: { clear: vi.fn(), appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(), appendReasoning: vi.fn(() => document.createElement("div")), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() },
      appendMessage: vi.fn(() => document.createElement("div")), appendCommentary: vi.fn(), rebuildHistory, loadEarlier,
    });
    expect(view.restore([{ sequence: 2, kind: "message", role: "user", content: { text: "recent prompt" } }], { hasEarlier: true, estimatedContextTokens: 999 })).toBe(999);
    (messages.querySelector(".transcript-load-earlier") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(loadEarlier).toHaveBeenCalledWith(2));
    expect(rebuildHistory).toHaveBeenLastCalledWith(["old prompt", "recent prompt"]);
    expect(messages.querySelector(".transcript-load-earlier")).toBeNull();
  });
});
