import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export type BlobSource = Uint8Array | AsyncIterable<Uint8Array>;
export interface BlobRange { start: number; end: number }
export interface BlobPutOptions { maxBytes?: number; expectedSha256?: string }
export interface BlobPutResult { key: string; sha256: string; byteSize: number; deduplicated: boolean }
export interface BlobReadResult { stream: Readable; byteSize: number; start: number; end: number }

export interface BlobStore {
  readonly backend: string;
  put(source: BlobSource, options?: BlobPutOptions): Promise<BlobPutResult>;
  open(key: string, range?: BlobRange): Promise<BlobReadResult>;
  read(key: string): Promise<Uint8Array>;
  stat(key: string): Promise<{ byteSize: number } | undefined>;
  delete(key: string): Promise<void>;
  keys(): AsyncIterable<string>;
  collectTemporary?(): Promise<number>;
}

export class BlobSizeLimitError extends Error {
  constructor(readonly byteSize: number, readonly limit: number) {
    super(`Blob exceeds the ${limit} byte limit`);
    this.name = "BlobSizeLimitError";
  }
}

/** Files are immutable and named by their digest. Writes are staged, fsynced,
 * and atomically renamed, making retry and process-crash behavior deterministic. */
export class LocalBlobStore implements BlobStore {
  readonly backend = "local-sha256";
  readonly #root: string;
  readonly #objects: string;
  readonly #staging: string;

  constructor(root: string) {
    this.#root = resolve(root);
    this.#objects = join(this.#root, "sha256");
    this.#staging = join(this.#root, "staging");
  }

  async put(source: BlobSource, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    await mkdir(this.#staging, { recursive: true });
    const temporary = join(this.#staging, `${randomUUID()}.part`);
    const handle = await open(temporary, "wx");
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const raw of chunks(source)) {
        const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        byteSize += chunk.byteLength;
        if (options.maxBytes !== undefined && byteSize > options.maxBytes) {
          throw new BlobSizeLimitError(byteSize, options.maxBytes);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    const sha256 = hash.digest("hex");
    if (options.expectedSha256 && options.expectedSha256 !== sha256) {
      await unlink(temporary).catch(() => undefined);
      throw new Error(`Blob checksum mismatch: expected ${options.expectedSha256}, received ${sha256}`);
    }
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const target = this.#path(key);
    await mkdir(dirname(target), { recursive: true });
    const existing = await this.stat(key);
    let deduplicated = Boolean(existing);
    if (existing) {
      if (existing.byteSize !== byteSize) throw new Error(`Digest collision at ${key}`);
      await unlink(temporary).catch(() => undefined);
    } else {
      try { await rename(temporary, target); }
      catch (error) {
        const raced = await this.stat(key);
        if (!raced || raced.byteSize !== byteSize) throw error;
        deduplicated = true;
        await unlink(temporary).catch(() => undefined);
      }
    }
    return { key, sha256, byteSize, deduplicated };
  }

  async open(key: string, range?: BlobRange): Promise<BlobReadResult> {
    const info = await stat(this.#path(key));
    if (info.size === 0 && !range) return { stream: Readable.from([]), byteSize: 0, start: 0, end: -1 };
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    if (start < 0 || end < start || end >= info.size) throw new RangeError("Invalid blob byte range");
    return { stream: createReadStream(this.#path(key), { start, end }), byteSize: info.size, start, end };
  }

  async read(key: string): Promise<Uint8Array> {
    const opened = await this.open(key);
    const parts: Buffer[] = [];
    for await (const chunk of opened.stream) parts.push(Buffer.from(chunk));
    return new Uint8Array(Buffer.concat(parts));
  }

  async stat(key: string): Promise<{ byteSize: number } | undefined> {
    try { return { byteSize: (await stat(this.#path(key))).size }; }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  }

  async delete(key: string): Promise<void> { await unlink(this.#path(key)).catch((error) => { if (!isMissing(error)) throw error; }); }

  async *keys(): AsyncIterable<string> {
    const { readdir } = await import("node:fs/promises");
    let prefixes: string[];
    try { prefixes = await readdir(this.#objects); } catch (error) { if (isMissing(error)) return; throw error; }
    for (const prefix of prefixes) {
      for (const name of await readdir(join(this.#objects, prefix))) yield `${prefix}/${name}`;
    }
  }

  async collectTemporary(): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    let names: string[];
    try { names = await readdir(this.#staging); } catch (error) { if (isMissing(error)) return 0; throw error; }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".part")) continue;
      await unlink(join(this.#staging, name)).catch((error) => { if (!isMissing(error)) throw error; });
      removed += 1;
    }
    return removed;
  }

  #path(key: string): string {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new TypeError("Invalid blob key");
    const target = resolve(this.#objects, ...key.split("/"));
    if (!target.startsWith(`${this.#objects}${sep}`)) throw new TypeError("Blob key escaped its root");
    return target;
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly backend = "memory-sha256";
  readonly #values = new Map<string, Uint8Array>();
  async put(source: BlobSource, options: BlobPutOptions = {}): Promise<BlobPutResult> {
    const parts: Uint8Array[] = []; let byteSize = 0; const hash = createHash("sha256");
    for await (const chunk of chunks(source)) {
      byteSize += chunk.byteLength;
      if (options.maxBytes !== undefined && byteSize > options.maxBytes) throw new BlobSizeLimitError(byteSize, options.maxBytes);
      hash.update(chunk); parts.push(chunk);
    }
    const sha256 = hash.digest("hex");
    if (options.expectedSha256 && options.expectedSha256 !== sha256) throw new Error("Blob checksum mismatch");
    const key = `${sha256.slice(0, 2)}/${sha256}`; const deduplicated = this.#values.has(key);
    if (!deduplicated) this.#values.set(key, new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part)))));
    return { key, sha256, byteSize, deduplicated };
  }
  async open(key: string, range?: BlobRange): Promise<BlobReadResult> {
    const value = this.#values.get(key); if (!value) throw Object.assign(new Error("Blob not found"), { code: "ENOENT" });
    if (value.byteLength === 0 && !range) return { stream: Readable.from([]), byteSize: 0, start: 0, end: -1 };
    const start = range?.start ?? 0; const end = range?.end ?? value.byteLength - 1;
    if (start < 0 || end < start || end >= value.byteLength) throw new RangeError("Invalid blob byte range");
    return { stream: Readable.from(Buffer.from(value.subarray(start, end + 1))), byteSize: value.byteLength, start, end };
  }
  async read(key: string): Promise<Uint8Array> { const value = this.#values.get(key); if (!value) throw Object.assign(new Error("Blob not found"), { code: "ENOENT" }); return value.slice(); }
  async stat(key: string): Promise<{ byteSize: number } | undefined> { const value = this.#values.get(key); return value ? { byteSize: value.byteLength } : undefined; }
  async delete(key: string): Promise<void> { this.#values.delete(key); }
  async *keys(): AsyncIterable<string> { yield* this.#values.keys(); }
  async collectTemporary(): Promise<number> { return 0; }
}

async function* chunks(source: BlobSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) { yield source; return; }
  for await (const chunk of source) yield chunk;
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
