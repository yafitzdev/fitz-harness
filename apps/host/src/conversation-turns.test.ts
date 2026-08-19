import { describe, expect, it } from "vitest";
import { ContextManager } from "@fitz/context";
import { SqliteStore } from "@fitz/storage";
import { ConversationTurnError, ConversationTurnService } from "./conversation-turns.js";

describe("ConversationTurnService", () => {
  it("atomically replaces the latest assistant turn and returns retained context", () => {
    const store = sessionStore();
    const context = new ContextManager(store);
    const service = new ConversationTurnService(store, context);
    createRun(store, "run-old", "2026-01-01T00:00:01.000Z");
    createRun(store, "run-target", "2026-01-01T00:00:02.000Z");
    append(store, "old-user", "message", "user", { text: "keep me" });
    append(store, "old-answer", "message", "assistant", { text: "retained", runId: "run-old", phase: "final" });
    append(store, "target-user", "message", "user", { text: "  regenerate me  " });
    append(store, "target-reasoning", "reasoning", "assistant", { text: "discarded reasoning", runId: "run-target" });
    append(store, "target-tool", "tool-call", "tool", { toolName: "read", input: { path: "README.md" }, runId: "run-target" });
    append(store, "target-commentary", "message", "assistant", { text: "discarded commentary", runId: "run-target", phase: "commentary" });
    append(store, "target-answer", "message", "assistant", { text: "discarded answer", runId: "run-target", phase: "final" });
    const retainedTokens = context.estimateSession("session-1");

    const result = service.regenerateLatestAssistant("session-1", "run-target");

    expect(result).toEqual({ prompt: "regenerate me", messageId: "target-user", sequence: 3, removedTranscriptEntries: 5, estimatedContextTokens: expect.any(Number) });
    expect(result.estimatedContextTokens).toBeLessThan(retainedTokens);
    expect(result.estimatedContextTokens).toBe(context.estimateSession("session-1"));
    expect(store.transcriptAfter("session-1", 0).map((entry) => entry.id)).toEqual(["old-user", "old-answer", "target-user"]);
    expect(store.getTranscriptEntry("target-user")?.content.text).toBe("regenerate me");
    store.close();
  });

  it("rolls transcript deletion back when post-mutation context projection fails", () => {
    const store = sessionStore();
    createRun(store, "run-target", "2026-01-01T00:00:01.000Z");
    append(store, "target-user", "message", "user", { text: "regenerate me" });
    append(store, "target-answer", "message", "assistant", { text: "answer", runId: "run-target", phase: "final" });
    const service = new ConversationTurnService(store, { estimateSession: () => { throw new Error("projection failed"); } });

    expect(() => service.regenerateLatestAssistant("session-1", "run-target")).toThrow("projection failed");
    expect(store.transcriptAfter("session-1", 0).map((entry) => entry.id)).toEqual(["target-user", "target-answer"]);
    store.close();
  });

  it("rejects asynchronous work at the transaction boundary", async () => {
    const store = sessionStore();
    expect(() => store.withImmediateTransaction(async () => "not atomic"))
      .toThrow("Store transactions must be synchronous");
    expect(store.getSession("session-1")).toBeDefined();
    store.close();
  });

  it("rejects replacement when the requested answer is no longer latest", () => {
    const store = sessionStore();
    const service = new ConversationTurnService(store, new ContextManager(store));
    createRun(store, "run-old", "2026-01-01T00:00:01.000Z");
    createRun(store, "run-new", "2026-01-01T00:00:02.000Z");
    append(store, "old-user", "message", "user", { text: "old" });
    append(store, "old-answer", "message", "assistant", { text: "old answer", runId: "run-old", phase: "final" });
    append(store, "new-user", "message", "user", { text: "new" });
    append(store, "new-answer", "message", "assistant", { text: "new answer", runId: "run-new", phase: "final" });

    expect(() => service.regenerateLatestAssistant("session-1", "run-old"))
      .toThrow(expect.objectContaining<Partial<ConversationTurnError>>({ code: "not-latest-assistant" }));
    expect(store.transcriptAfter("session-1", 0)).toHaveLength(4);
    store.close();
  });

  it("truncates the conversation at an edited user message, including stopped work", () => {
    const store = sessionStore();
    const context = new ContextManager(store);
    const service = new ConversationTurnService(store, context);
    createRun(store, "run-stopped", "2026-01-01T00:00:01.000Z");
    append(store, "user-before", "message", "user", { text: "before" });
    append(store, "edited-user", "message", "user", { text: "old prompt" });
    append(store, "stopped-reasoning", "reasoning", "assistant", { text: "stopped thought", runId: "run-stopped" });
    append(store, "stopped-tool", "tool-call", "tool", { toolName: "read", runId: "run-stopped" });

    const result = service.editUserTurn("session-1", { messageId: "edited-user", text: "new prompt", originalText: "old prompt" });

    expect(result).toEqual({ prompt: "new prompt", messageId: "edited-user", sequence: 2, removedTranscriptEntries: 3, estimatedContextTokens: expect.any(Number) });
    expect(store.transcriptAfter("session-1", 0).map((entry) => entry.id)).toEqual(["user-before", "edited-user"]);
    expect(store.getTranscriptEntry("edited-user")?.content.text).toBe("new prompt");
    store.close();
  });

  it("falls back to the latest matching user text when a live article has no durable id", () => {
    const store = sessionStore();
    const service = new ConversationTurnService(store, new ContextManager(store));
    append(store, "user-1", "message", "user", { text: "same" });
    append(store, "answer-1", "message", "assistant", { text: "old", runId: "run-1", phase: "final" });
    append(store, "user-2", "message", "user", { text: "same" });
    const result = service.editUserTurn("session-1", { originalText: "same", text: "replacement" });
    expect(result.messageId).toBe("user-2");
    expect(store.transcriptAfter("session-1", 0).map((entry) => entry.id)).toEqual(["user-1", "answer-1", "user-2"]);
    expect(store.getTranscriptEntry("user-2")?.content.text).toBe("replacement");
    store.close();
  });
});

function sessionStore(): SqliteStore {
  const store = SqliteStore.memory();
  const now = "2026-01-01T00:00:00.000Z";
  store.createSession({ id: "session-1", title: "Conversation", status: "active", createdAt: now, updatedAt: now });
  return store;
}

function createRun(store: SqliteStore, id: string, timestamp: string): void {
  store.createAgentRun({ id, sessionId: "session-1", routeId: "default", status: "completed", createdAt: timestamp, updatedAt: timestamp, lastSequence: 0 });
}

function append(
  store: SqliteStore,
  id: string,
  kind: "message" | "reasoning" | "tool-call",
  role: "user" | "assistant" | "tool",
  content: Record<string, unknown>,
): void {
  store.appendTranscriptEntry({ id, sessionId: "session-1", kind, role, content, createdAt: "2026-01-01T00:00:03.000Z" });
}
