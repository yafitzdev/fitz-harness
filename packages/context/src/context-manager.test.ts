import { describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import { ContextManager } from "./context-manager.js";

describe("ContextManager", () => {
  it("passes through within budget and compacts over-budget history", async () => {
    const store = SqliteStore.memory(); const manager = new ContextManager(store, undefined, { reserveOutputTokens: 64, compactionThreshold: 0.8, recentTokenFraction: 0.5 });
    const small = await manager.prepare({ model: "fast", messages: [{ role: "user", content: "hello" }] }, 1000); expect(small.compacted).toBe(false);
    const large = await manager.prepare({ model: "fast", messages: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `${index}:${"x".repeat(300)}` })) }, 400); expect(large.compacted).toBe(true); expect(large.request.messages[0]?.content).toContain("Conversation summary"); expect(manager.estimate(large.request.messages)).toBeLessThanOrEqual(large.budgetTokens + 16); store.close();
  });

  it("rebuilds session context from canonical transcript and records compaction", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now }); store.appendTranscriptEntry({ id: "e", sessionId: "s", kind: "message", role: "user", content: { text: "old context ".repeat(100) }, createdAt: now });
    const manager = new ContextManager(store, undefined, { reserveOutputTokens: 32, compactionThreshold: 0.8, recentTokenFraction: 0.5 }); const result = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "new turn" }] }, 256); expect(result.compacted).toBe(true); expect(store.transcriptAfter("s", 0).at(-1)?.kind).toBe("compaction"); store.close();
  });

  it("creates a manual checkpoint while preserving the canonical transcript", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "old-user", sessionId: "s", kind: "message", role: "user", content: { text: "old question" }, createdAt: now }); store.appendTranscriptEntry({ id: "old-assistant", sessionId: "s", kind: "message", role: "assistant", content: { text: "old answer" }, createdAt: now });
    const manager = new ContextManager(store); const compacted = await manager.compactSession("s", 1_000); expect(compacted.entry.content).toEqual(expect.objectContaining({ manual: true, throughSequence: 2 })); expect(store.transcriptAfter("s", 0).filter((entry) => entry.kind === "message")).toHaveLength(2);
    store.appendTranscriptEntry({ id: "after", sessionId: "s", kind: "message", role: "assistant", content: { text: "after checkpoint" }, createdAt: now }); const prepared = await manager.prepare({ model: "fast", sessionId: "s", messages: [{ role: "user", content: "next turn" }] }, 10_000);
    expect(prepared.request.messages.map((message) => message.content)).toEqual([expect.stringContaining("Conversation summary"), "after checkpoint", "next turn"]); store.close();
  });

  it("compacts transcripts beyond one storage page", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    for (let index = 0; index < 1_001; index += 1) store.appendTranscriptEntry({ id: `e-${index}`, sessionId: "s", kind: "message", role: "user", content: { text: String(index) }, createdAt: now });
    const result = await new ContextManager(store).compactSession("s", 10_000); expect(result.originalMessageCount).toBe(1_001); expect(result.entry.content.throughSequence).toBe(1_001); store.close();
  });
});
