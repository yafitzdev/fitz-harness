import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "./artifact-repository.js";
import { LocalBlobStore, MemoryBlobStore } from "./blob-store.js";
import { SqliteStore } from "./sqlite-store.js";

describe("ArtifactRepository", () => {
  it("collects a deduplicated blob only during race-free startup reconciliation", async () => {
    const database = SqliteStore.memory();
    const blobs = new MemoryBlobStore();
    const artifacts = new ArtifactRepository(database, blobs);
    database.createSession({ id: "session", title: "Artifacts", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    for (const id of ["one", "two"]) await artifacts.create({ id, sessionId: "session", name: `${id}.txt`, mimeType: "text/plain", kind: "text", createdAt: new Date(0).toISOString(), metadata: {} }, Buffer.from("shared"));
    const oneStorage = database.getArtifactStorage("one")!;
    expect(database.getArtifactStorage("two")?.objectKey).toBe(oneStorage.objectKey);
    await artifacts.delete("one");
    expect(Buffer.from((await artifacts.read("two"))!).toString()).toBe("shared");
    await artifacts.delete("two");
    expect(await blobs.stat(oneStorage.objectKey)).toEqual({ byteSize: 6 });
    expect(await artifacts.initialize()).toEqual({ migrated: 0, collected: 1 });
    expect(await blobs.stat(oneStorage.objectKey)).toBeUndefined();
    database.close();
  });

  it("migrates existing SQLite BLOBs and drops the legacy payload table", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-artifact-migration-"));
    const databasePath = join(root, "fitz.db");
    try {
      const original = new SqliteStore(databasePath);
      original.createSession({ id: "session", title: "Legacy", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
      original.close();
      const raw = new DatabaseSync(databasePath);
      raw.prepare(`INSERT INTO artifacts_legacy (id, session_id, name, mime_type, kind, byte_size, sha256, content, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("legacy", "session", "legacy.bin", "application/octet-stream", "binary", 6, "obsolete", Buffer.from("legacy"), new Date(0).toISOString(), "{}");
      raw.prepare(`INSERT INTO artifacts (id, session_id, name, mime_type, kind, byte_size, sha256, storage_backend, object_key, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("legacy", "session", "legacy.bin", "application/octet-stream", "binary", 6, "obsolete", "legacy-sqlite", "legacy", new Date(0).toISOString(), "{}");
      raw.close();

      const database = new SqliteStore(databasePath);
      const artifacts = new ArtifactRepository(database, new LocalBlobStore(join(root, "artifacts")));
      expect(await artifacts.initialize()).toEqual({ migrated: 1, collected: 0 });
      expect(Buffer.from((await artifacts.read("legacy"))!).toString()).toBe("legacy");
      expect(await artifacts.verify("legacy")).toBe(true);
      database.close();

      const inspected = new DatabaseSync(databasePath);
      expect(inspected.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts_legacy'`).get()).toBeUndefined();
      const columns = inspected.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("content");
      inspected.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports corruption, enforces the configured quota, and collects orphans explicitly", async () => {
    const database = SqliteStore.memory();
    let quota = 6;
    const blobs = new MemoryBlobStore();
    const artifacts = new ArtifactRepository(database, blobs, { quotaBytes: () => quota });
    database.createSession({ id: "session", title: "Storage", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    await artifacts.create({ id: "one", sessionId: "session", name: "one.txt", mimeType: "text/plain", kind: "text", createdAt: new Date(0).toISOString(), metadata: {} }, Buffer.from("shared"));
    await expect(artifacts.create({ id: "two", sessionId: "session", name: "two.txt", mimeType: "text/plain", kind: "text", createdAt: new Date(0).toISOString(), metadata: {} }, Buffer.from("larger!"))).rejects.toThrow("quota exceeded");
    quota = 100;
    await blobs.put(Buffer.from("orphan"));
    const report = await artifacts.inspect({ verifyChecksums: true });
    expect(report).toMatchObject({ artifacts: 1, objects: 1, referencedBytes: 6, orphanObjects: 1, quotaBytes: 100, issues: [] });
    expect(await artifacts.collectGarbage()).toMatchObject({ objects: 1, bytes: 6 });
    expect((await artifacts.inspect()).orphanObjects).toBe(0);
    database.close();
  });

  it("does not garbage-collect an immutable object while a response is streaming it", async () => {
    const database = SqliteStore.memory();
    const blobs = new MemoryBlobStore();
    const artifacts = new ArtifactRepository(database, blobs);
    database.createSession({ id: "session", title: "Leases", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    await artifacts.create({ id: "leased", sessionId: "session", name: "leased.txt", mimeType: "text/plain", kind: "text", createdAt: new Date(0).toISOString(), metadata: {} }, Buffer.from("still streaming"));
    const opened = await artifacts.open("leased");
    expect(opened).toBeDefined();
    await artifacts.delete("leased");
    expect(await artifacts.collectGarbage()).toMatchObject({ objects: 0 });
    const received: Buffer[] = [];
    for await (const chunk of opened!.stream) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received).toString()).toBe("still streaming");
    expect(await artifacts.collectGarbage()).toMatchObject({ objects: 1 });
    database.close();
  });
});
