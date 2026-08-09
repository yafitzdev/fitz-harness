import type { ArtifactRecord } from "@fitz/protocol";
import { BlobSizeLimitError, type BlobRange, type BlobReadResult, type BlobSource, type BlobStore } from "./blob-store.js";
import type { ArtifactStorageEntry, SqliteStore } from "./sqlite-store.js";

export type ArtifactDraft = Omit<ArtifactRecord, "byteSize" | "sha256"> & Partial<Pick<ArtifactRecord, "byteSize" | "sha256">>;
export interface ArtifactIntegrityIssue { artifactId?: string; objectKey: string; type: "unsupported-backend" | "missing" | "size-mismatch" | "checksum-mismatch" | "metadata-conflict"; detail: string }
export interface ArtifactStorageReport { artifacts: number; objects: number; referencedBytes: number; orphanObjects: number; orphanBytes: number; quotaBytes?: number; issues: ArtifactIntegrityIssue[]; verifiedChecksums: boolean }
export interface ArtifactGarbageCollection { objects: number; bytes: number; temporaryFiles: number }

export class ArtifactQuotaExceededError extends Error {
  constructor(readonly projectedBytes: number, readonly quotaBytes: number) {
    super(`Artifact storage quota exceeded: ${projectedBytes} bytes would exceed the ${quotaBytes} byte limit`);
    this.name = "ArtifactQuotaExceededError";
  }
}

/** Transaction boundary between immutable payloads and SQLite metadata. */
export class ArtifactRepository {
  readonly #database: SqliteStore;
  readonly #blobs: BlobStore;
  readonly #quotaBytes: (() => number | undefined) | undefined;
  readonly #activeReaders = new Map<string, number>();
  #operationTail: Promise<void> = Promise.resolve();
  constructor(database: SqliteStore, blobs: BlobStore, options: { quotaBytes?: () => number | undefined } = {}) { this.#database = database; this.#blobs = blobs; this.#quotaBytes = options.quotaBytes; }

  async initialize(): Promise<{ migrated: number; collected: number }> {
    return this.#exclusive(async () => {
      let migrated = 0;
      for (let legacy = this.#database.nextLegacyArtifactContent(); legacy; legacy = this.#database.nextLegacyArtifactContent()) {
        const stored = await this.#blobs.put(legacy.content);
        this.#database.migrateArtifactStorage(legacy.artifactId, stored, { backend: this.#blobs.backend, objectKey: stored.key });
        migrated += 1;
      }
      if (this.#database.countLegacyArtifactRefs() > 0) throw new Error("Artifact migration is incomplete: legacy metadata has no payload row");
      this.#database.dropLegacyArtifacts();
      if (migrated > 0) this.#database.compactArtifactMigration();
      const garbage = await this.#collectGarbage();
      return { migrated, collected: garbage.objects + garbage.temporaryFiles };
    });
  }

  async create(draft: ArtifactDraft, source: BlobSource, options: { maxBytes?: number } = {}): Promise<ArtifactRecord> {
    return this.#exclusive(async () => {
      const stored = await this.#blobs.put(source, {
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(draft.sha256 ? { expectedSha256: draft.sha256 } : {}),
      });
      if (draft.byteSize !== undefined && draft.byteSize !== stored.byteSize) throw new Error(`Artifact size mismatch: expected ${draft.byteSize}, received ${stored.byteSize}`);
      const quotaBytes = this.#quotaBytes?.();
      if (quotaBytes !== undefined) {
        const entries = this.#localEntries();
        const referenced = new Set(entries.map((entry) => entry.objectKey));
        const projectedBytes = uniqueBytes(entries) + (referenced.has(stored.key) ? 0 : stored.byteSize);
        if (projectedBytes > quotaBytes) {
          if (!referenced.has(stored.key)) await this.#blobs.delete(stored.key);
          throw new ArtifactQuotaExceededError(projectedBytes, quotaBytes);
        }
      }
      const artifact: ArtifactRecord = { ...draft, byteSize: stored.byteSize, sha256: stored.sha256 };
      // Metadata publication is intentionally last. A process crash leaves an
      // orphan that startup reconciliation safely collects.
      this.#database.createArtifact(artifact, { backend: this.#blobs.backend, objectKey: stored.key });
      return artifact;
    });
  }

  async read(id: string): Promise<Uint8Array | undefined> {
    const opened = await this.open(id);
    if (!opened) return undefined;
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const raw of opened.stream) { const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw); chunks.push(chunk); size += chunk.byteLength; }
      const result = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async open(id: string, range?: BlobRange): Promise<BlobReadResult | undefined> {
    return this.#exclusive(async () => {
      const artifact = this.#database.getArtifact(id); const storage = this.#database.getArtifactStorage(id);
      if (!artifact || !storage || storage.backend !== this.#blobs.backend) return undefined;
      const info = await this.#blobs.stat(storage.objectKey);
      if (!info) return undefined;
      if (info.byteSize !== artifact.byteSize) throw new Error(`Artifact ${id} failed its size integrity check`);
      const opened = await this.#blobs.open(storage.objectKey, range);
      this.#activeReaders.set(storage.objectKey, (this.#activeReaders.get(storage.objectKey) ?? 0) + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        const remaining = (this.#activeReaders.get(storage.objectKey) ?? 1) - 1;
        if (remaining > 0) this.#activeReaders.set(storage.objectKey, remaining); else this.#activeReaders.delete(storage.objectKey);
      };
      opened.stream.once("end", release);
      opened.stream.once("error", release);
      opened.stream.once("close", release);
      return opened;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.#exclusive(async () => this.#database.getArtifactStorage(id) ? this.#database.deleteArtifact(id) : false);
  }

  async verify(id: string): Promise<boolean> {
    const artifact = this.#database.getArtifact(id); const bytes = await this.read(id);
    if (!artifact || !bytes || bytes.byteLength !== artifact.byteSize) return false;
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bytes).digest("hex") === artifact.sha256;
  }

  async inspect(options: { verifyChecksums?: boolean } = {}): Promise<ArtifactStorageReport> {
    return this.#exclusive(async () => this.#inspect(Boolean(options.verifyChecksums)));
  }

  async collectGarbage(): Promise<ArtifactGarbageCollection> {
    return this.#exclusive(async () => this.#collectGarbage());
  }

  async snapshotTo(databasePath: string, target: BlobStore): Promise<{ objects: number; bytes: number }> {
    return this.#exclusive(async () => {
      await this.#database.backupTo(databasePath);
      const entries = uniqueEntries(this.#localEntries());
      let bytes = 0;
      for (const entry of entries) {
        const opened = await this.#blobs.open(entry.objectKey);
        const stored = await target.put(opened.stream, { expectedSha256: entry.sha256 });
        if (stored.key !== entry.objectKey || stored.byteSize !== entry.byteSize) throw new Error(`Backup object integrity mismatch for ${entry.objectKey}`);
        bytes += stored.byteSize;
      }
      return { objects: entries.length, bytes };
    });
  }

  async #inspect(verifyChecksums: boolean): Promise<ArtifactStorageReport> {
    const all = this.#database.listArtifactStorageEntries();
    const local = this.#localEntries();
    const issues: ArtifactIntegrityIssue[] = all.filter((entry) => entry.backend !== this.#blobs.backend).map((entry) => ({ artifactId: entry.artifactId, objectKey: entry.objectKey, type: "unsupported-backend", detail: `Expected ${this.#blobs.backend}, received ${entry.backend}` }));
    const unique = uniqueEntries(local, issues);
    const referenced = new Set(unique.map((entry) => entry.objectKey));
    for (const entry of unique) {
      const info = await this.#blobs.stat(entry.objectKey);
      if (!info) { issues.push({ artifactId: entry.artifactId, objectKey: entry.objectKey, type: "missing", detail: "Referenced object is missing" }); continue; }
      if (info.byteSize !== entry.byteSize) issues.push({ artifactId: entry.artifactId, objectKey: entry.objectKey, type: "size-mismatch", detail: `Metadata says ${entry.byteSize} bytes; object has ${info.byteSize}` });
      if (verifyChecksums) {
        const { createHash } = await import("node:crypto");
        const opened = await this.#blobs.open(entry.objectKey); const hash = createHash("sha256");
        for await (const chunk of opened.stream) hash.update(chunk);
        const actual = hash.digest("hex");
        if (actual !== entry.sha256) issues.push({ artifactId: entry.artifactId, objectKey: entry.objectKey, type: "checksum-mismatch", detail: `Expected ${entry.sha256}; received ${actual}` });
      }
    }
    let orphanObjects = 0; let orphanBytes = 0;
    for await (const key of this.#blobs.keys()) if (!referenced.has(key)) { orphanObjects += 1; orphanBytes += (await this.#blobs.stat(key))?.byteSize ?? 0; }
    const quotaBytes = this.#quotaBytes?.();
    return { artifacts: all.length, objects: unique.length, referencedBytes: uniqueBytes(unique), orphanObjects, orphanBytes, ...(quotaBytes !== undefined ? { quotaBytes } : {}), issues, verifiedChecksums: verifyChecksums };
  }

  async #collectGarbage(): Promise<ArtifactGarbageCollection> {
    const referenced = new Set(this.#localEntries().map((entry) => entry.objectKey));
    let objects = 0; let bytes = 0;
    for await (const key of this.#blobs.keys()) if (!referenced.has(key) && !this.#activeReaders.has(key)) { bytes += (await this.#blobs.stat(key))?.byteSize ?? 0; await this.#blobs.delete(key); objects += 1; }
    const temporaryFiles = await (this.#blobs.collectTemporary?.() ?? Promise.resolve(0));
    return { objects, bytes, temporaryFiles };
  }

  #localEntries(): ArtifactStorageEntry[] { return this.#database.listArtifactStorageEntries().filter((entry) => entry.backend === this.#blobs.backend); }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail; let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

}

export { BlobSizeLimitError };
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function uniqueEntries(entries: ArtifactStorageEntry[], issues: ArtifactIntegrityIssue[] = []): ArtifactStorageEntry[] {
  const unique = new Map<string, ArtifactStorageEntry>();
  for (const entry of entries) {
    const existing = unique.get(entry.objectKey);
    if (existing && (existing.byteSize !== entry.byteSize || existing.sha256 !== entry.sha256)) issues.push({ artifactId: entry.artifactId, objectKey: entry.objectKey, type: "metadata-conflict", detail: "Deduplicated references disagree about size or checksum" });
    else if (!existing) unique.set(entry.objectKey, entry);
  }
  return [...unique.values()];
}
function uniqueBytes(entries: ArtifactStorageEntry[]): number { return uniqueEntries(entries).reduce((total, entry) => total + entry.byteSize, 0); }
