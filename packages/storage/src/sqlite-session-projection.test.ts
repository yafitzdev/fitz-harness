import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("SqliteStore session projections", () => {
  it("rebuilds counts and checkpoint boundaries from canonical transcript rows", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createSession({ id: "projection-session", title: "Projection", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "user", sessionId: "projection-session", kind: "message", role: "user", content: { text: "hello" }, createdAt: now });
    store.appendTranscriptEntry({ id: "reasoning", sessionId: "projection-session", kind: "reasoning", role: "assistant", content: { text: "thinking" }, createdAt: now });
    store.appendTranscriptEntry({ id: "checkpoint", sessionId: "projection-session", kind: "compaction", role: "system", content: { summary: "hello", throughSequence: 2 }, createdAt: now });

    expect(store.getSessionProjection("projection-session")).toMatchObject({
      sourceRevision: 3,
      sourceTranscriptSequence: 3,
      transcriptEntryCount: 3,
      messageCount: 1,
      reasoningCount: 1,
      compactionCount: 1,
      latestCompactionSequence: 3,
      latestCompactionThroughSequence: 2,
    });

    store.appendTranscriptEntry({ id: "answer", sessionId: "projection-session", kind: "message", role: "assistant", content: { text: "done" }, createdAt: now });
    expect(store.getSessionProjection("projection-session")).toMatchObject({ sourceRevision: 4, transcriptEntryCount: 4, messageCount: 2 });

    store.withImmediateTransaction(() => {
      expect(store.deleteTranscriptFrom("projection-session", 3)).toBe(2);
    });
    expect(store.getSessionProjection("projection-session")).toMatchObject({
      sourceRevision: 5,
      sourceTranscriptSequence: 2,
      transcriptEntryCount: 2,
      compactionCount: 0,
    });
    store.close();
  });

  it("returns no projection for an unknown session", () => {
    const store = SqliteStore.memory();
    expect(store.getSessionProjection("missing")).toBeUndefined();
    expect(store.rebuildSessionProjection("missing")).toBeUndefined();
    store.close();
  });
});
