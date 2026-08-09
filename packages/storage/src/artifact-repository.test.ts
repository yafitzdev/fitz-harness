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
});
