import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "./artifact-repository.js";
import { MemoryBlobStore } from "./blob-store.js";
import { SqliteSessionQueryService } from "./sqlite-session-query.js";
import { SqliteStore } from "./sqlite-store.js";

describe("SqliteSessionQueryService", () => {
  it("uses one bounded contract for transcript pages, forensic sections, ownership, and artifacts", async () => {
    const store = SqliteStore.memory();
    const artifacts = new ArtifactRepository(store, new MemoryBlobStore());
    const now = new Date(0).toISOString();
    store.createSession({ id: "query-session", title: "Query", status: "active", ownerUserId: "owner", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "user", sessionId: "query-session", kind: "message", role: "user", content: { text: "inspect" }, createdAt: now });
    store.appendTranscriptEntry({ id: "reasoning", sessionId: "query-session", kind: "reasoning", role: "assistant", content: { text: "checking" }, createdAt: now });
    store.appendTranscriptEntry({ id: "assistant", sessionId: "query-session", kind: "message", role: "assistant", content: { text: "done" }, createdAt: now });
    await artifacts.create({ id: "query-artifact", sessionId: "query-session", name: "answer.txt", mimeType: "text/plain", kind: "text", createdAt: now, metadata: {} }, Buffer.from("evidence"));

    const service = new SqliteSessionQueryService(store, { artifacts, maxLimit: 2 });
    const first = await service.query({ sessionId: "query-session", section: "transcript", before: Number.MAX_SAFE_INTEGER, limit: 2, ownerUserId: "owner" });
    expect(first?.transcript.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(first?.page).toMatchObject({ direction: "backward", hasMore: true, nextBefore: 2 });
    expect(first?.snapshot.messages.map((message) => message.text)).toEqual(["[reasoning] checking", "done"]);

    const overview = await service.query({ sessionId: "query-session", section: "overview", ownerUserId: "owner" });
    expect(overview?.snapshot.forensics?.transcript).toHaveLength(3);
    expect(overview?.snapshot.forensics?.artifacts[0]?.contentBase64).toBeUndefined();

    const all = await service.query({ sessionId: "query-session", section: "all", includeArtifactContent: true, ownerUserId: "owner" });
    expect(all?.snapshot.forensics?.artifacts[0]?.contentBase64).toBe(Buffer.from("evidence").toString("base64"));
    expect(await service.query({ sessionId: "query-session", ownerUserId: "other" })).toBeUndefined();
    await expect(service.query({ sessionId: "query-session", after: 1, before: 3 })).rejects.toThrow(/cannot be combined/);
    store.close();
  });
});
