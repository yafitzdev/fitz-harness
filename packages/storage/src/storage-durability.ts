import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArtifactRepository } from "./artifact-repository.js";
import { LocalBlobStore } from "./blob-store.js";

export interface StorageBackupManifest {
  version: 1;
  id: string;
  createdAt: string;
  databaseSha256: string;
  objects: number;
  bytes: number;
}

export interface StorageDurabilityPaths {
  dataRoot: string;
  databasePath: string;
  artifactsDir: string;
  backupsDir: string;
}

export interface BackupValidation { manifest: StorageBackupManifest; integrity: "ok"; objects: number; bytes: number }

export class StorageDurabilityService {
  readonly #artifacts: ArtifactRepository;
  readonly #paths: StorageDurabilityPaths;
  constructor(artifacts: ArtifactRepository, paths: StorageDurabilityPaths) { this.#artifacts = artifacts; this.#paths = paths; }

  async createBackup(): Promise<StorageBackupManifest> {
    await mkdir(this.#paths.backupsDir, { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const temporary = this.#backupPath(`${id}.part`);
    const destination = this.#backupPath(id);
    await mkdir(temporary, { recursive: false });
    try {
      const snapshot = await this.#artifacts.snapshotTo(join(temporary, "fitz.db"), new LocalBlobStore(join(temporary, "artifacts")));
      const manifest: StorageBackupManifest = { version: 1, id, createdAt: new Date().toISOString(), databaseSha256: await sha256File(join(temporary, "fitz.db")), objects: snapshot.objects, bytes: snapshot.bytes };
      await writeJsonAtomic(join(temporary, "manifest.json"), manifest);
      await validateBackupDirectory(temporary, true);
      await rename(temporary, destination);
      return manifest;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }

  async listBackups(): Promise<StorageBackupManifest[]> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try { names = await readdir(this.#paths.backupsDir); } catch (error) { if (isMissing(error)) return []; throw error; }
    const manifests: StorageBackupManifest[] = [];
    for (const name of names) {
      if (name.endsWith(".part") || name.startsWith("restore-rollback-")) continue;
      try { manifests.push(await readManifest(this.#backupPath(name))); } catch { /* Invalid/incomplete backups are omitted from the restore list. */ }
    }
    return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async validateBackup(id: string, verifyChecksums = true): Promise<BackupValidation> { return validateBackupDirectory(this.#backupPath(id), verifyChecksums); }

  async scheduleRestore(id: string): Promise<{ backupId: string; restartRequired: true }> {
    await this.validateBackup(id, true);
    await writeJsonAtomic(join(this.#paths.dataRoot, "pending-storage-restore.json"), { version: 1, backupId: id, requestedAt: new Date().toISOString() });
    return { backupId: id, restartRequired: true };
  }

  #backupPath(id: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || id.includes("..")) throw new TypeError("Invalid backup id");
    return resolve(this.#paths.backupsDir, id);
  }
}

/** Apply a scheduled restore before SQLite opens. The previous database and
 * object directory are preserved together as a rollback snapshot. */
export async function applyPendingStorageRestore(paths: StorageDurabilityPaths): Promise<{ backupId: string; rollbackDir: string } | undefined> {
  const markerPath = join(paths.dataRoot, "pending-storage-restore.json");
  let marker: { version: number; backupId: string };
  try { marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker; } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (marker.version !== 1 || !/^[a-zA-Z0-9._-]+$/.test(marker.backupId) || marker.backupId.includes("..")) throw new Error("Invalid pending storage restore marker");
  const backupDir = resolve(paths.backupsDir, marker.backupId);
  await validateBackupDirectory(backupDir, true);
  const transaction = randomUUID();
  const stagingRoot = join(paths.dataRoot, `.restore-${transaction}`);
  const stagedDatabaseDir = join(stagingRoot, "database");
  const stagedArtifactsDir = join(stagingRoot, "artifacts");
  const rollbackDir = join(paths.backupsDir, `restore-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}-${transaction.slice(0, 8)}`);
  const databaseDir = dirname(paths.databasePath);
  await mkdir(stagedDatabaseDir, { recursive: true });
  await cp(join(backupDir, "fitz.db"), join(stagedDatabaseDir, "fitz.db"));
  await cp(join(backupDir, "artifacts"), stagedArtifactsDir, { recursive: true, force: false }).catch(async (error) => { if (isMissing(error)) await mkdir(stagedArtifactsDir, { recursive: true }); else throw error; });
  await mkdir(rollbackDir, { recursive: true });
  let databaseMoved = false; let artifactsMoved = false; let restoredDatabase = false; let restoredArtifacts = false;
  try {
    if (await exists(databaseDir)) { await rename(databaseDir, join(rollbackDir, "database")); databaseMoved = true; }
    await rename(stagedDatabaseDir, databaseDir); restoredDatabase = true;
    if (await exists(paths.artifactsDir)) { await rename(paths.artifactsDir, join(rollbackDir, "artifacts")); artifactsMoved = true; }
    await rename(stagedArtifactsDir, paths.artifactsDir); restoredArtifacts = true;
    await rm(markerPath, { force: true });
    await rm(stagingRoot, { recursive: true, force: true });
    return { backupId: marker.backupId, rollbackDir };
  } catch (error) {
    if (restoredArtifacts) await rm(paths.artifactsDir, { recursive: true, force: true });
    if (artifactsMoved) await rename(join(rollbackDir, "artifacts"), paths.artifactsDir).catch(() => undefined);
    if (restoredDatabase) await rm(databaseDir, { recursive: true, force: true });
    if (databaseMoved) await rename(join(rollbackDir, "database"), databaseDir).catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function validateBackupDirectory(directory: string, verifyChecksums: boolean): Promise<BackupValidation> {
  const manifest = await readManifest(directory);
  const databasePath = join(directory, "fitz.db");
  if (await sha256File(databasePath) !== manifest.databaseSha256) throw new Error("Backup database checksum mismatch");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows: Array<{ object_key: string; byte_size: number; sha256: string }>;
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error(`Backup database integrity failed: ${integrity?.integrity_check ?? "unknown"}`);
    rows = database.prepare(`SELECT object_key, byte_size, sha256 FROM artifacts WHERE storage_backend = 'local-sha256' GROUP BY object_key, byte_size, sha256 ORDER BY object_key`).all() as unknown as typeof rows;
  } finally { database.close(); }
  const blobs = new LocalBlobStore(join(directory, "artifacts")); let bytes = 0;
  for (const row of rows) {
    const info = await blobs.stat(row.object_key); if (!info) throw new Error(`Backup object is missing: ${row.object_key}`);
    if (info.byteSize !== row.byte_size) throw new Error(`Backup object size mismatch: ${row.object_key}`);
    if (verifyChecksums) {
      const content = await blobs.read(row.object_key);
      if (createHash("sha256").update(content).digest("hex") !== row.sha256) throw new Error(`Backup object checksum mismatch: ${row.object_key}`);
    }
    bytes += row.byte_size;
  }
  if (rows.length !== manifest.objects || bytes !== manifest.bytes) throw new Error("Backup manifest object totals do not match its database");
  return { manifest, integrity: "ok", objects: rows.length, bytes };
}

async function readManifest(directory: string): Promise<StorageBackupManifest> {
  const value = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Partial<StorageBackupManifest>;
  if (value.version !== 1 || typeof value.id !== "string" || typeof value.createdAt !== "string" || !/^[a-f0-9]{64}$/.test(value.databaseSha256 ?? "") || !Number.isSafeInteger(value.objects) || Number(value.objects) < 0 || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) throw new Error("Invalid storage backup manifest");
  return value as StorageBackupManifest;
}
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function writeJsonAtomic(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.part`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); await rename(temporary, path); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
