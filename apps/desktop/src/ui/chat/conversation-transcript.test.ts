// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTranscript } from "./conversation-transcript.js";

beforeEach(() => document.body.replaceChildren());

describe("ConversationTranscript", () => {
  it("passes a persisted typed document through when replaying an assistant message", () => {
    const appendMessage = vi.fn(() => globalThis.document.createElement("div"));
    const contentDocument = { version: 1 as const, blocks: [{ id: "markdown:0", type: "markdown" as const, start: 0, end: 5 }] };
    const view = new ConversationTranscript({ messages: documentNode(), activity: emptyActivity(), appendMessage, appendCommentary: vi.fn(), rebuildHistory: vi.fn() });
    view.restore([{ id: "answer", sequence: 2, kind: "message", role: "assistant", content: { text: "hello", document: contentDocument } }]);
    expect(appendMessage).toHaveBeenCalledWith("assistant", "hello", undefined, undefined, undefined, { id: "answer", sequence: 2, document: contentDocument });
  });

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
    const registerGeneratedFile = vi.fn();
    const view = new ConversationTranscript({ messages, activity, registerGeneratedFile, appendMessage, appendCommentary, rebuildHistory });
    const tokens = view.restore([
      { kind: "message", role: "user", content: { text: "hello" } },
      { kind: "message", role: "assistant", content: { phase: "commentary", text: "checking" } },
      { kind: "tool-call", id: "call", content: { toolCallId: "call", toolName: "read", input: { path: "a.ts" } } },
      { kind: "tool-result", id: "result", content: { toolCallId: "call", result: "source" } },
      { kind: "tool-call", id: "write-call", content: { toolCallId: "write-call", toolName: "write", input: { path: "src/generated.ts" } } },
      { kind: "tool-result", id: "write-result", content: { toolCallId: "write-call", result: "ok", isError: false } },
      { kind: "reasoning", content: { text: "thinking" } },
      { kind: "compaction", content: { manual: false } },
    ]);
    expect(rebuildHistory).toHaveBeenCalledWith(["hello"]);
    expect(appendMessage).toHaveBeenCalledWith("user", "hello", undefined);
    expect(appendCommentary).toHaveBeenCalledWith("checking", undefined);
    expect(activity.completeTool).toHaveBeenCalledWith(toolRow, "read", { path: "a.ts" }, "source", false, undefined);
    expect(registerGeneratedFile).toHaveBeenCalledWith("src/generated.ts", "created");
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

  it("restores durable attachment tiles with user messages", () => {
    const appendMessage = vi.fn(() => document.createElement("div"));
    const view = new ConversationTranscript({ messages: document.createElement("main"), activity: { clear: vi.fn(), appendTool: vi.fn(), completeTool: vi.fn(), appendReasoning: vi.fn(), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() }, appendMessage, appendCommentary: vi.fn(), rebuildHistory: vi.fn() });
    const attachment = { id: "artifact-1", name: "shot.png", mimeType: "image/png", kind: "image", byteSize: 42 };
    view.restore([{ kind: "message", role: "user", content: { text: "look", attachments: [attachment] } }]);
    expect(appendMessage).toHaveBeenCalledWith("user", "look", undefined, undefined, [attachment]);
  });

  it("keeps historical plan revisions out of the active composer artifact", () => {
    const messages = document.createElement("main");
    const activity = { clear: vi.fn(), appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(), appendReasoning: vi.fn(), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() };
    const resetPlan = vi.fn();
    const view = new ConversationTranscript({ messages, activity, appendMessage: vi.fn(), appendCommentary: vi.fn(), rebuildHistory: vi.fn(), resetPlan });
    const first = { details: { plan: { runId: "run-1", revision: 1, items: [] } } };
    const second = { details: { plan: { runId: "run-1", revision: 2, items: [] } } };

    view.restore([
      { kind: "tool-call", id: "plan-1", content: { toolCallId: "plan-1", toolName: "agent_plan", input: { action: "set" } } },
      { kind: "tool-result", id: "result-1", content: { toolCallId: "plan-1", result: first } },
      { kind: "tool-call", id: "plan-2", content: { toolCallId: "plan-2", toolName: "agent_plan", input: { action: "update" } } },
      { kind: "tool-result", id: "result-2", content: { toolCallId: "plan-2", result: second } },
    ]);

    expect(resetPlan).toHaveBeenCalledOnce();
    expect(activity.appendTool).not.toHaveBeenCalled();
    expect(activity.completeTool).not.toHaveBeenCalled();
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

  it("hydrates long transcripts in bounded turn-aligned windows without inserting pagination into the chat", async () => {
    const messages = document.createElement("main");
    const appendMessage = vi.fn(() => document.createElement("div"));
    const view = new ConversationTranscript({ messages, activity: { clear: vi.fn(), appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(), appendReasoning: vi.fn(() => document.createElement("div")), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() }, appendMessage, appendCommentary: vi.fn(), rebuildHistory: vi.fn() });
    view.restore(Array.from({ length: 600 }, (_, index) => ({ kind: "message", role: index % 3 === 0 ? "user" : "assistant", content: { text: String(index) } })));
    expect(appendMessage.mock.calls.length).toBeLessThanOrEqual(252);
    expect(messages.querySelector(".transcript-load-earlier")).toBeNull();
    const initiallyRendered = appendMessage.mock.calls.length;
    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(appendMessage.mock.calls.length).toBeGreaterThan(initiallyRendered));
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
    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(loadEarlier).toHaveBeenCalledWith(2));
    expect(rebuildHistory).toHaveBeenLastCalledWith(["old prompt", "recent prompt"]);
  });

  it("keeps live nodes connected while revealing an older local window", async () => {
    const messages = document.createElement("main");
    const activity = {
      clear: vi.fn(), isolateHistory: (render: () => void) => render(), finishWork: vi.fn(),
      appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(),
      appendReasoning: vi.fn(() => document.createElement("div")), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn(),
    };
    const appendMessage = vi.fn((role: string, text: string) => {
      const row = document.createElement("article"); row.className = role; row.textContent = text; messages.append(row); return row;
    });
    const view = new ConversationTranscript({ messages, activity, appendMessage, appendCommentary: vi.fn(), rebuildHistory: vi.fn() });
    view.restore(Array.from({ length: 300 }, (_, index) => ({ sequence: index + 1, kind: "message", role: "user", content: { text: `message-${index + 1}` } })));
    const live = document.createElement("article"); live.textContent = "live output"; messages.append(live);

    messages.scrollTop = 0;
    messages.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(appendMessage.mock.calls.length).toBe(300));

    expect(live.parentElement).toBe(messages);
    expect(messages.lastElementChild).toBe(live);
    expect(activity.clear).toHaveBeenCalledOnce();
  });

  it("discards an older page that resolves after another chat is restored", async () => {
    const messages = document.createElement("main");
    let resolveEarlier!: (value: { data: Record<string, any>[]; page: { hasEarlier: boolean } }) => void;
    const loadEarlier = vi.fn(() => new Promise<{ data: Record<string, any>[]; page: { hasEarlier: boolean } }>((resolve) => { resolveEarlier = resolve; }));
    const appendMessage = vi.fn((_role: string, text: string) => {
      const row = document.createElement("article"); row.textContent = text; messages.append(row); return row;
    });
    const activity = { clear: vi.fn(), appendTool: vi.fn(), completeTool: vi.fn(), appendReasoning: vi.fn(), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() };
    const view = new ConversationTranscript({ messages, activity, appendMessage, appendCommentary: vi.fn(), rebuildHistory: vi.fn(), loadEarlier });
    view.restore([{ sequence: 100, kind: "message", role: "user", content: { text: "chat A" } }], { hasEarlier: true });
    messages.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(loadEarlier).toHaveBeenCalledWith(100));

    view.restore([{ sequence: 200, kind: "message", role: "user", content: { text: "chat B" } }]);
    resolveEarlier({ data: [{ sequence: 1, kind: "message", role: "user", content: { text: "chat A earlier" } }], page: { hasEarlier: false } });
    await Promise.resolve(); await Promise.resolve();

    expect(messages.textContent).toBe("chat B");
    expect(appendMessage.mock.calls.some(([, text]) => text === "chat A earlier")).toBe(false);
  });

  it("prunes the discarded branch after an edited user message", () => {
    const rebuildHistory = vi.fn();
    const view = new ConversationTranscript({
      messages: document.createElement("main"),
      activity: { clear: vi.fn(), appendTool: vi.fn(() => document.createElement("div")), completeTool: vi.fn(), appendReasoning: vi.fn(() => document.createElement("div")), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() },
      appendMessage: vi.fn(() => document.createElement("div")), appendCommentary: vi.fn(), rebuildHistory,
    });
    view.restore([
      { sequence: 1, kind: "message", role: "user", content: { text: "before" } },
      { sequence: 2, kind: "message", role: "user", content: { text: "edited" } },
      { sequence: 3, kind: "message", role: "assistant", content: { text: "discarded" } },
    ]);
    view.truncateFrom(2);
    expect(rebuildHistory).toHaveBeenLastCalledWith(["before"]);
  });
});

function documentNode(): HTMLElement { return globalThis.document.createElement("main"); }
function emptyActivity() {
  return { clear: vi.fn(), appendTool: vi.fn(), completeTool: vi.fn(), appendReasoning: vi.fn(), appendReasoningDelta: vi.fn(), completeReasoning: vi.fn(), appendContext: vi.fn() };
}
