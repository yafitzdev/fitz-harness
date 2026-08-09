import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { ContextManager } from "./context-manager.js";

describe("ContextManager", () => {
  it("passes through within budget and compacts over-budget history", async () => {
    const store = SqliteStore.memory(); const manager = new ContextManager(store, undefined, { reserveOutputTokens: 64, compactionThreshold: 0.8, recentTokenFraction: 0.5 });
    const small = await manager.prepare({ model: "fast", messages: [{ role: "user", content: "hello" }] }, 1000); expect(small.compacted).toBe(false); expect(small.estimatedContextTokens).toBe(small.estimatedInputTokens);
    const large = await manager.prepare({ model: "fast", messages: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `${index}:${"x".repeat(300)}` })) }, 400); expect(large.compacted).toBe(true); expect(large.request.messages[0]?.content).toContain("Conversation summary"); expect(manager.estimate(large.request.messages)).toBeLessThanOrEqual(large.budgetTokens + 16); store.close();
  });

  it("rebuilds session context from canonical transcript and records compaction", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now }); store.appendTranscriptEntry({ id: "e", sessionId: "s", kind: "message", role: "user", content: { text: "old context ".repeat(100) }, createdAt: now });
    const manager = new ContextManager(store, undefined, { reserveOutputTokens: 32, compactionThreshold: 0.8, recentTokenFraction: 0.5 }); const result = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "new turn" }] }, 256); expect(result.compacted).toBe(true); expect(store.transcriptAfter("s", 0).at(-1)?.kind).toBe("compaction"); store.close();
  });

  it("never re-sends reasoning entries back into the model context", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "u", sessionId: "s", kind: "message", role: "user", content: { text: "task" }, createdAt: now });
    store.appendTranscriptEntry({ id: "r", sessionId: "s", kind: "reasoning", role: "assistant", content: { text: "hidden reasoning" }, createdAt: now });
    store.appendTranscriptEntry({ id: "a", sessionId: "s", kind: "message", role: "assistant", content: { text: "answer" }, createdAt: now });
    const manager = new ContextManager(store); const prepared = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "next" }] }, 10_000);
    expect(prepared.request.messages.map((message) => message.content)).toEqual(["task", "answer", "next"]);
    expect(prepared.request.messages.map((message) => message.content)).not.toContain("hidden reasoning");
    store.close();
  });

  it("creates a manual checkpoint while preserving the canonical transcript", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "old-user", sessionId: "s", kind: "message", role: "user", content: { text: "old question" }, createdAt: now }); store.appendTranscriptEntry({ id: "old-assistant", sessionId: "s", kind: "message", role: "assistant", content: { text: "old answer" }, createdAt: now });
    const manager = new ContextManager(store); const compacted = await manager.compactSession("s", 1_000); expect(compacted.entry.content).toEqual(expect.objectContaining({ manual: true, throughSequence: 2 })); expect(store.transcriptAfter("s", 0).filter((entry) => entry.kind === "message")).toHaveLength(2);
    store.appendTranscriptEntry({ id: "after", sessionId: "s", kind: "message", role: "assistant", content: { text: "after checkpoint" }, createdAt: now }); const prepared = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "next turn" }] }, 10_000);
    expect(prepared.request.messages.map((message) => message.content)).toEqual([expect.stringContaining("Conversation summary"), "after checkpoint", "next turn"]); store.close();
  });

  it("uses only the latest checkpoint and post-checkpoint activity for subsequent context", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "old-user", sessionId: "s", kind: "message", role: "user", content: { text: "old question that must not be replayed" }, createdAt: now });
    store.appendTranscriptEntry({ id: "old-tool", sessionId: "s", kind: "tool-result", role: "tool", content: { result: "old tool output that must not be recounted" }, createdAt: now });
    store.appendTranscriptEntry({ id: "checkpoint", sessionId: "s", kind: "compaction", role: "system", content: { summary: "durable summary", throughSequence: 2, manual: true }, createdAt: now });
    store.appendTranscriptEntry({ id: "recent", sessionId: "s", kind: "message", role: "assistant", content: { text: "recent answer" }, createdAt: now });
    const manager = new ContextManager(store); const prepared = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "next turn" }] }, 10_000);
    expect(prepared.request.messages.map((message) => message.content)).toEqual(["Conversation summary:\ndurable summary", "recent answer", "next turn"]);
    expect(manager.estimateSession("s")).toBe(manager.estimateSessionActivity(store.transcriptAfter("s", 2)));
    store.close();
  });

  it("compacts transcripts beyond one storage page", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    for (let index = 0; index < 1_001; index += 1) store.appendTranscriptEntry({ id: `e-${index}`, sessionId: "s", kind: "message", role: "user", content: { text: String(index) }, createdAt: now });
    const result = await new ContextManager(store).compactSession("s", 10_000); expect(result.originalMessageCount).toBe(1_001); expect(result.entry.content.throughSequence).toBe(1_001); store.close();
  });

  it("auto-compacts when tool activity pushes the session estimate over budget", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "u", sessionId: "s", kind: "message", role: "user", content: { text: "inspect the project" }, createdAt: now });
    for (let index = 0; index < 30; index += 1) {
      store.appendTranscriptEntry({ id: `tc-${index}`, sessionId: "s", kind: "tool-call", role: "tool", content: { toolName: "bash", input: { command: `ls ${index}` } }, createdAt: now });
      store.appendTranscriptEntry({ id: `tr-${index}`, sessionId: "s", kind: "tool-result", role: "tool", content: { toolName: "bash", result: "x".repeat(3_000) }, createdAt: now });
    }
    const manager = new ContextManager(store, undefined, { reserveOutputTokens: 64, compactionThreshold: 0.8, recentTokenFraction: 0.5 });
    const prepared = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "what now" }] }, 2_000);
    expect(prepared.compacted).toBe(true);
    expect(prepared.estimatedContextTokens).toBeLessThan(prepared.estimatedInputTokens);
    const checkpoint = store.transcriptAfter("s", 0).filter((entry) => entry.kind === "compaction").at(-1);
    expect(checkpoint?.content).toEqual(expect.objectContaining({ manual: false }));
    // 61 transcript entries: 1 user message + 30 tool-call/tool-result pairs, all checkpointed.
    expect(Number(checkpoint?.content.throughSequence)).toBe(61);
    // The compacted request re-sends summary + recent messages, never the raw tool dumps.
    expect(prepared.request.messages[0]?.content).toContain("Conversation summary");
    expect(prepared.request.messages.map((message) => message.content)).not.toContain("x".repeat(3_000));
    store.close();
  });

  it("keeps automatic compaction durable so the next run does not re-compact", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "u", sessionId: "s", kind: "message", role: "user", content: { text: "old turn" }, createdAt: now });
    store.appendTranscriptEntry({ id: "tc", sessionId: "s", kind: "tool-call", role: "tool", content: { toolName: "bash", input: { command: "ls" } }, createdAt: now });
    store.appendTranscriptEntry({ id: "tr", sessionId: "s", kind: "tool-result", role: "tool", content: { toolName: "bash", result: "y".repeat(5_000) }, createdAt: now });
    const manager = new ContextManager(store, undefined, { reserveOutputTokens: 64, compactionThreshold: 0.8, recentTokenFraction: 0.5 });
    const first = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "go" }] }, 1_000); expect(first.compacted).toBe(true);
    const second = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "continue" }] }, 1_000); expect(second.compacted).toBe(false);
    // The rebuilt canonical context is summary + post-checkpoint messages only.
    expect(second.request.messages.map((message) => message.content)).toEqual([expect.stringContaining("Conversation summary"), "continue"]);
    expect(store.transcriptAfter("s", 0).filter((entry) => entry.kind === "compaction")).toHaveLength(1);
    store.close();
  });
});
