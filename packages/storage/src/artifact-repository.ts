import type { ArtifactRecord } from "@fitz/protocol";
import { BlobSizeLimitError, type BlobRange, type BlobReadResult, type BlobSource, type BlobStore } from "./blob-store.js";
import type { SqliteStore } from "./sqlite-store.js";

export type ArtifactDraft = Omit<ArtifactRecord, "byteSize" | "sha256"> & Partial<Pick<ArtifactRecord, "byteSize" | "sha256">>;

/** Transaction boundary between immutable payloads and SQLite metadata. */
export class ArtifactRepository {
  readonly #database: SqliteStore;
  readonly #blobs: BlobStore;
  constructor(database: SqliteStore, blobs: BlobStore) { this.#database = database; this.#blobs = blobs; }

  async initialize(): Promise<{ migrated: number; collected: number }> {
    let migrated = 0;
    for (let legacy = this.#database.nextLegacyArtifactContent(); legacy; legacy = this.#database.nextLegacyArtifactContent()) {
      const stored = await this.#blobs.put(legacy.content);
      this.#database.migrateArtifactStorage(legacy.artifactId, stored, { backend: this.#blobs.backend, objectKey: stored.key });
      migrated += 1;
    }
    if (this.#database.countLegacyArtifactRefs() > 0) throw new Error("Artifact migration is incomplete: legacy metadata has no payload row");
    this.#database.dropLegacyArtifacts();
    if (migrated > 0) this.#database.compactArtifactMigration();
    const referenced = new Set(this.#database.listArtifactStorage(this.#blobs.backend).map((entry) => entry.objectKey));
    let collected = await (this.#blobs.collectTemporary?.() ?? Promise.resolve(0));
    for await (const key of this.#blobs.keys()) if (!referenced.has(key)) { await this.#blobs.delete(key); collected += 1; }
    return { migrated, collected };
  }

  async create(draft: ArtifactDraft, source: BlobSource, options: { maxBytes?: number } = {}): Promise<ArtifactRecord> {
    const stored = await this.#blobs.put(source, {
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(draft.sha256 ? { expectedSha256: draft.sha256 } : {}),
    });
    if (draft.byteSize !== undefined && draft.byteSize !== stored.byteSize) {
      throw new Error(`Artifact size mismatch: expected ${draft.byteSize}, received ${stored.byteSize}`);
    }
    const artifact: ArtifactRecord = { ...draft, byteSize: stored.byteSize, sha256: stored.sha256 };
    // Metadata publication is intentionally last. If the process dies here,
    // startup orphan collection removes the unreferenced immutable object. We
    // never eagerly delete it because a concurrent deduplicated writer may be
    // about to publish another reference to the same digest.
    this.#database.createArtifact(artifact, { backend: this.#blobs.backend, objectKey: stored.key });
    return artifact;
  }

  async read(id: string): Promise<Uint8Array | undefined> {
    const storage = this.#database.getArtifactStorage(id);
    if (!storage || storage.backend !== this.#blobs.backend) return undefined;
    try { return await this.#blobs.read(storage.objectKey); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async open(id: string, range?: BlobRange): Promise<BlobReadResult | undefined> {
    const artifact = this.#database.getArtifact(id); const storage = this.#database.getArtifactStorage(id);
    if (!artifact || !storage || storage.backend !== this.#blobs.backend) return undefined;
    const info = await this.#blobs.stat(storage.objectKey);
    if (!info) return undefined;
    if (info.byteSize !== artifact.byteSize) throw new Error(`Artifact ${id} failed its size integrity check`);
    return this.#blobs.open(storage.objectKey, range);
  }

  async delete(id: string): Promise<boolean> {
    if (!this.#database.getArtifactStorage(id)) return false;
    // Request-time deletion only removes the metadata reference. Deleting the
    // immutable object here can race a concurrent deduplicated writer between
    // its blob put and metadata publication. Startup reconciliation runs before
    // the host accepts writes, so it is the safe place to collect unreferenced
    // objects.
    return this.#database.deleteArtifact(id);
  }

  async verify(id: string): Promise<boolean> {
    const artifact = this.#database.getArtifact(id); const bytes = await this.read(id);
    if (!artifact || !bytes || bytes.byteLength !== artifact.byteSize) return false;
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bytes).digest("hex") === artifact.sha256;
  }

}

export { BlobSizeLimitError };
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
