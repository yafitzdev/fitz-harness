import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "./artifact-repository.js";
import { LocalBlobStore } from "./blob-store.js";
import { SqliteStore } from "./sqlite-store.js";
import { applyPendingStorageRestore, StorageDurabilityService, type StorageDurabilityPaths } from "./storage-durability.js";

describe("StorageDurabilityService", () => {
  it("backs up SQLite and blobs together, validates them, and applies a scheduled restore before open", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-storage-durability-"));
    const paths: StorageDurabilityPaths = { dataRoot: root, databasePath: join(root, "database", "fitz.db"), artifactsDir: join(root, "artifacts"), backupsDir: join(root, "backups") };
    try {
      await mkdir(dirname(paths.databasePath), { recursive: true });
      const database = new SqliteStore(paths.databasePath);
      const artifacts = new ArtifactRepository(database, new LocalBlobStore(paths.artifactsDir));
      database.createSession({ id: "session", title: "Before", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
      database.recordQueueEvent(queueEvent(1, "interrupted-request", "queued"));
      database.recordQueueEvent(queueEvent(2, "completed-request", "queued"));
      database.recordQueueEvent(queueEvent(3, "completed-request", "completed"));
      await artifacts.create({ id: "artifact", sessionId: "session", name: "proof.txt", mimeType: "text/plain", kind: "text", createdAt: new Date(0).toISOString(), metadata: {} }, Buffer.from("durable"));
      const durability = new StorageDurabilityService(artifacts, paths);
      const backup = await durability.createBackup();
      expect(await durability.validateBackup(backup.id, true)).toMatchObject({ integrity: "ok", objects: 1, bytes: 7 });
      database.createSession({ id: "later", title: "After", status: "active", createdAt: new Date(1).toISOString(), updatedAt: new Date(1).toISOString() });
      await durability.scheduleRestore(backup.id);
      database.close();

      const applied = await applyPendingStorageRestore(paths);
      expect(applied?.backupId).toBe(backup.id);
      const restoredDatabase = new SqliteStore(paths.databasePath);
      const restoredArtifacts = new ArtifactRepository(restoredDatabase, new LocalBlobStore(paths.artifactsDir));
      expect(restoredDatabase.getSession("session")?.title).toBe("Before");
      expect(restoredDatabase.getSession("later")).toBeUndefined();
      expect(Buffer.from((await restoredArtifacts.read("artifact"))!).toString()).toBe("durable");
      expect(restoredDatabase.recoverInterruptedRequests()).toBe(1);
      expect(restoredDatabase.listInferenceRequests()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "interrupted-request", status: "interrupted", errorCode: "host_restarted" }),
        expect.objectContaining({ id: "completed-request", status: "completed" }),
      ]));
      restoredDatabase.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a backup whose database changed after the manifest was written", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-storage-corrupt-"));
    const paths: StorageDurabilityPaths = { dataRoot: root, databasePath: join(root, "database", "fitz.db"), artifactsDir: join(root, "artifacts"), backupsDir: join(root, "backups") };
    try {
      await mkdir(dirname(paths.databasePath), { recursive: true });
      const database = new SqliteStore(paths.databasePath);
      const artifacts = new ArtifactRepository(database, new LocalBlobStore(paths.artifactsDir));
      const durability = new StorageDurabilityService(artifacts, paths);
      const backup = await durability.createBackup();
      const backupDatabase = join(paths.backupsDir, backup.id, "fitz.db");
      const bytes = Buffer.from(await readFile(backupDatabase)); bytes[0] = bytes[0]! ^ 0xff; await writeFile(backupDatabase, bytes);
      await expect(durability.validateBackup(backup.id, true)).rejects.toThrow("checksum mismatch");
      database.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function queueEvent(sequence: number, requestId: string, status: "queued" | "completed") {
  return { sequence, protocolVersion: "1" as const, timestamp: new Date(sequence).toISOString(), type: "queue.updated" as const, data: { requestId, routeId: "default", position: status === "queued" ? 1 : 0, depth: 1, status } };
}
