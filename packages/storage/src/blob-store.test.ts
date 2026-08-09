import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobSizeLimitError, LocalBlobStore } from "./blob-store.js";

describe("LocalBlobStore", () => {
  it("atomically deduplicates content and streams byte ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-blobs-"));
    try {
      const blobs = new LocalBlobStore(root);
      const first = await blobs.put(Buffer.from("0123456789abcdef"));
      const second = await blobs.put(Buffer.from("0123456789abcdef"));
      expect(second).toMatchObject({ key: first.key, sha256: first.sha256, deduplicated: true, byteSize: 16 });
      const range = await blobs.open(first.key, { start: 4, end: 7 });
      const chunks: Buffer[] = [];
      for await (const chunk of range.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("4567");
      expect(await readFile(join(root, "sha256", ...first.key.split("/")), "utf8")).toBe("0123456789abcdef");
      await blobs.delete(first.key);
      expect(await blobs.stat(first.key)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects oversized writes without leaving partial objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-blobs-limit-"));
    try {
      const blobs = new LocalBlobStore(root);
      await expect(blobs.put(Buffer.from("too large"), { maxBytes: 3 })).rejects.toBeInstanceOf(BlobSizeLimitError);
      const keys: string[] = [];
      for await (const key of blobs.keys()) keys.push(key);
      expect(keys).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
