import { describe, expect, it } from "vitest";
import { ArtifactRepository, MemoryBlobStore, SqliteStore } from "@fitz/storage";
import { createSessionReader } from "./session-reader.js";

describe("createSessionReader forensic sections", () => {
  it("serves the complete normalized bundle, including reasoning and optional artifact bytes", async () => {
    const store = SqliteStore.memory();
    const artifacts = new ArtifactRepository(store, new MemoryBlobStore());
    const now = new Date(0).toISOString();
    store.createSession({ id: "reader-session", ownerUserId: "owner-1", title: "Reader", status: "active", createdAt: now, updatedAt: now });
    store.appendTranscriptEntry({ id: "reader-user", sessionId: "reader-session", kind: "message", role: "user", content: { text: "diagnose this" }, createdAt: now });
    store.appendTranscriptEntry({ id: "reader-thinking", sessionId: "reader-session", kind: "reasoning", role: "assistant", content: { text: "Inspect the failure" }, createdAt: now });
    store.recordInferenceEvidence({ id: "reader-request", kind: "chat", status: "failed", routeId: "default", sessionId: "reader-session", executionLane: "gpu", enqueuedAt: now, completedAt: now, request: { messages: [{ role: "user", content: "diagnose this" }] }, error: { name: "EngineError", message: "fixture" } });
    await artifacts.create({ id: "reader-artifact", sessionId: "reader-session", name: "result.txt", mimeType: "text/plain", kind: "text", createdAt: now, metadata: {} }, Buffer.from("evidence"));

    const reader = createSessionReader(store, { artifacts });
    const snapshot = await reader("reader-session", { section: "all", includeArtifactContent: true });
    expect(snapshot?.forensics?.transcript.map((entry) => entry.kind)).toEqual(["message", "reasoning"]);
    expect(snapshot?.forensics?.evidence[0]?.error).toEqual({ name: "EngineError", message: "fixture" });
    expect(snapshot?.forensics?.artifacts[0]?.contentBase64).toBe(Buffer.from("evidence").toString("base64"));
    expect(snapshot?.forensics?.coverage.artifactContent).toBe("included");

    const overview = await reader("reader-session", { section: "overview" });
    expect(overview?.forensics?.coverage.artifactContent).toBe("metadata-only");
    expect(await reader("reader-session", { section: "overview", ownerUserId: "other-user" })).toBeUndefined();
    store.close();
  });
});
