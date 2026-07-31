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
});
