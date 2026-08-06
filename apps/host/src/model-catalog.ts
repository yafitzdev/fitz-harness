import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface CatalogModel {
  id: string;
  downloads: number;
  likes: number;
  pipelineTag?: string;
  updatedAt?: string;
}

/** Shared catalog sort keys, passed through to HF's `sort`/`direction` params. */
export type CatalogSortKey = "downloads" | "updated" | "name" | "likes";
export type CatalogSortDirection = "asc" | "desc";

const CATALOG_SORT_KEYS: readonly string[] = ["downloads", "updated", "name", "likes"];
const HF_SORT_BY: Record<CatalogSortKey, string> = { downloads: "downloads", updated: "lastModified", name: "name", likes: "likes" };

export function normalizeCatalogSort(value: unknown): CatalogSortKey {
  return typeof value === "string" && CATALOG_SORT_KEYS.includes(value) ? value as CatalogSortKey : "downloads";
}

export function normalizeCatalogDirection(value: unknown): CatalogSortDirection {
  return value === "asc" ? "asc" : "desc";
}

export interface ModelFile {
  path: string;
  size?: number;
}

export interface DownloadedModel {
  repoId: string;
  fileName: string;
  path: string;
  size: number;
}

export type DownloadStatus = "active" | "done" | "cancelled" | "failed";

export interface DownloadRecord {
  id: string;
  repoId: string;
  fileName: string;
  received: number;
  total?: number;
  status: DownloadStatus;
  path?: string;
  error?: string;
}

export interface ModelCatalogServiceOptions {
  /** Root folder that downloaded GGUF files land in; each repo gets its own subfolder. */
  modelRoot: string;
  /** Hugging Face base URL; override for tests or mirrors. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

export class DownloadNotFoundError extends Error {
  constructor(id: string) { super(`Download ${id} was not found`); }
}

interface ActiveDownload {
  record: DownloadRecord;
  controller: AbortController;
}

const DEFAULT_ENDPOINT = "https://huggingface.co";
const USER_AGENT = "Fitz-Codex";

/**
 * Browse and download GGUF models from Hugging Face. The catalog search maps
 * HF's `/api/models` results (filtered to GGUF text-generation models) the same
 * way the Pi catalog maps npm search results, and downloads stream into
 * `{modelRoot}/<org>/<repo>/<file>.gguf` with resume support: an interrupted
 * download leaves a `.part` file that the next attempt continues from.
 */
export class ModelCatalogService {
  readonly #modelRoot: string;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #downloads = new Map<string, ActiveDownload>();

  constructor(options: ModelCatalogServiceOptions) {
    this.#modelRoot = resolve(options.modelRoot);
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async search(query = "", offset = 0, limit = 50, pipelineTag = "text-generation", sort: CatalogSortKey = "downloads", direction: CatalogSortDirection = "desc"): Promise<{ total: number; models: CatalogModel[] }> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    const url = new URL(`${this.#endpoint}/api/models`);
    const text = query.trim();
    if (text) url.searchParams.set("search", text);
    url.searchParams.set("filter", "gguf");
    url.searchParams.set("pipeline_tag", pipelineTag);
    url.searchParams.set("sort", HF_SORT_BY[sort]);
    url.searchParams.set("direction", direction === "desc" ? "-1" : "1");
    url.searchParams.set("limit", String(safeLimit));
    url.searchParams.set("offset", String(safeOffset));
    const response = await this.#fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Hugging Face catalog request failed (${response.status})`);
    const payload = await response.json() as { count?: unknown; items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    const models = items.map(catalogModel).filter((value): value is CatalogModel => Boolean(value));
    const total = Array.isArray(payload) ? models.length : Number(payload.count ?? models.length);
    return { total, models };
  }

  /** Lists the `.gguf` files in a model repo (sizes are included for LFS files). */
  async files(repoId: string): Promise<ModelFile[]> {
    requireRepoId(repoId);
    const url = new URL(`${this.#endpoint}/api/models/${encodeURIComponent(repoId)}`);
    const response = await this.#fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Hugging Face model lookup failed (${response.status})`);
    const payload = await response.json() as { siblings?: Array<{ rfilename?: unknown; size?: unknown }> };
    return (Array.isArray(payload.siblings) ? payload.siblings : [])
      .filter((entry) => typeof entry.rfilename === "string" && entry.rfilename.endsWith(".gguf"))
      .map((entry) => ({ path: entry.rfilename as string, ...(typeof entry.size === "number" ? { size: entry.size } : {}) }));
  }

  /**
   * Starts (or resumes) a download. When `fileName` is omitted the recommended
   * GGUF file is picked automatically. Returns an id that the caller polls via
   * `progress()` until the record reaches a terminal status.
   */
  async start(repoId: string, fileName?: string): Promise<DownloadRecord> {
    requireRepoId(repoId);
    const resolvedFileName = fileName ?? await this.#pick(repoId);
    if (!resolvedFileName) throw new Error("No GGUF file found in this repository");
    requireFileName(resolvedFileName);
    const targetDir = this.#targetDir(repoId);
    await mkdir(targetDir, { recursive: true });
    const target = join(targetDir, resolvedFileName);
    if (existsSync(target)) throw new Error("Model file is already downloaded");
    const running = [...this.#downloads.values()].find((entry) => entry.record.repoId === repoId && entry.record.fileName === resolvedFileName && entry.record.status === "active");
    if (running) return running.record;
    for (const [id, entry] of this.#downloads) {
      if (entry.record.repoId === repoId && entry.record.fileName === resolvedFileName) this.#downloads.delete(id);
    }
    const id = randomUUID();
    const record: DownloadRecord = { id, repoId, fileName: resolvedFileName, received: 0, status: "active" };
    const download: ActiveDownload = { record, controller: new AbortController() };
    this.#downloads.set(id, download);
    void this.#run(download, target);
    return record;
  }

  progress(id: string): DownloadRecord {
    const entry = this.#downloads.get(id);
    if (!entry) throw new DownloadNotFoundError(id);
    return { ...entry.record };
  }

  cancel(id: string): DownloadRecord {
    const entry = this.#downloads.get(id);
    if (!entry) throw new DownloadNotFoundError(id);
    entry.controller.abort();
    entry.record.status = "cancelled";
    entry.record.error = "Cancelled";
    return { ...entry.record };
  }

  /** Active downloads; terminal records are pruned on read. */
  list(): DownloadRecord[] {
    const records: DownloadRecord[] = [];
    for (const [id, entry] of this.#downloads) {
      if (entry.record.status !== "active") { this.#downloads.delete(id); continue; }
      records.push({ ...entry.record });
    }
    return records;
  }

  /** Every finished `.gguf` under the model root (`.part` files are skipped). */
  async downloaded(): Promise<DownloadedModel[]> {
    const found: DownloadedModel[] = [];
    await this.#walk(this.#modelRoot, 0, found);
    return found;
  }

  async removeDownloaded(repoId: string, fileName: string): Promise<void> {
    requireRepoId(repoId);
    requireFileName(fileName);
    for (const entry of this.#downloads.values()) {
      if (entry.record.repoId === repoId && entry.record.fileName === fileName) {
        entry.controller.abort();
        entry.record.status = "cancelled";
      }
    }
    const targetDir = this.#targetDir(repoId);
    await rm(join(targetDir, fileName), { force: true });
    await this.#pruneEmptyParents(targetDir, this.#modelRoot);
  }

  async #pick(repoId: string): Promise<string | undefined> {
    const files = await this.files(repoId);
    return pickGgufFile(files)?.path;
  }

  async #run(download: ActiveDownload, target: string): Promise<void> {
    const { record, controller } = download;
    const part = `${target}.part`;
    try {
      const url = new URL(`${this.#endpoint}/${record.repoId}/resolve/main/${record.fileName}`);
      const partialSize = existsSync(part) ? (await stat(part)).size : 0;
      const headers: Record<string, string> = { "user-agent": USER_AGENT };
      if (partialSize > 0) headers.range = `bytes=${partialSize}-`;
      const response = await this.#fetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const append = response.status === 206;
      record.received = append ? partialSize : 0;
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 0) record.total = contentLength + (append ? partialSize : 0);
      const body = Readable.fromWeb(response.body as ReadableStream);
      // Count bytes inside the pipeline: attaching a `data` listener before
      // `pipeline` can let the source flow and drain first, which would count
      // bytes that are never written.
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          record.received += chunk.length;
          callback(null, chunk);
        },
      });
      await mkdir(dirname(part), { recursive: true });
      await pipeline(body, counter, createWriteStream(part, { flags: append ? "a" : "w" }));
      await rename(part, target);
      record.status = "done";
      record.path = target;
    } catch (error) {
      if (controller.signal.aborted) { record.status = "cancelled"; record.error = "Cancelled"; }
      else { record.status = "failed"; record.error = errorMessage(error); }
    }
  }

  async #walk(dir: string, depth: number, found: DownloadedModel[]): Promise<void> {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await this.#walk(full, depth + 1, found); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".gguf")) continue;
      const relativeDir = relative(this.#modelRoot, dir);
      if (!relativeDir || relativeDir.startsWith("..") || isAbsolute(relativeDir)) continue;
      const stats = await stat(full).catch(() => undefined);
      if (!stats?.isFile()) continue;
      found.push({ repoId: relativeDir.split(sep).join("/"), fileName: entry.name, path: full, size: stats.size });
    }
  }

  async #pruneEmptyParents(dir: string, stopAt: string): Promise<void> {
    let current = resolve(dir);
    const root = resolve(stopAt);
    while (current !== root && current.startsWith(`${root}${sep}`)) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) return;
        // rmdir only removes empty directories, so a concurrent write keeps its folder.
        await rmdir(current);
      } catch { return; }
      current = dirname(current);
    }
  }

  #targetDir(repoId: string): string {
    requireRepoId(repoId);
    const root = resolve(this.#modelRoot);
    const target = resolve(root, ...repoId.split("/"));
    const child = relative(root, target);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new TypeError("Model repository must stay inside the model root");
    return target;
  }
}

/** Picks the GGUF file to download: Q4_K_M, then Q4_0, then the largest file. */
export function pickGgufFile(files: ModelFile[]): ModelFile | undefined {
  const candidates = files.filter((file) => file.path.endsWith(".gguf"));
  if (candidates.length === 0) return undefined;
  const rank = (file: ModelFile): number => {
    const name = file.path.toLowerCase();
    if (name.includes("q4_k_m")) return 0;
    if (name.includes("q4_0")) return 1;
    if (name.includes("q5_k_m")) return 2;
    if (name.includes("q8_0")) return 3;
    return 4;
  };
  return [...candidates].sort((left, right) => rank(left) - rank(right) || (right.size ?? 0) - (left.size ?? 0))[0];
}

function catalogModel(entry: Record<string, unknown>): CatalogModel | undefined {
  if (typeof entry.id !== "string") return undefined;
  return {
    id: entry.id,
    downloads: typeof entry.downloads === "number" ? entry.downloads : 0,
    likes: typeof entry.likes === "number" ? entry.likes : 0,
    ...(typeof entry.pipeline_tag === "string" ? { pipelineTag: entry.pipeline_tag } : {}),
    ...(typeof entry.lastModified === "string" ? { updatedAt: entry.lastModified } : {}),
  };
}

/** `owner/name` with safe characters only; at most three path segments. */
function requireRepoId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}$/.test(value)) {
    throw new TypeError("Model repository must look like owner/name");
  }
}

function requireFileName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/i.test(value)) {
    throw new TypeError("Model file must be a .gguf file");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
