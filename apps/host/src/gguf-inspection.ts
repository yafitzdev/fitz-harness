import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 1_000_000;
const READ_BUFFER_BYTES = 1024 * 1024;

/** Inspect tensor descriptors without touching the multi-gigabyte tensor data
 * section. Tokenizer metadata can make real GGUF headers exceed 10 MiB, so a
 * fixed prefix scan is not sufficient. */
export function ggufHasTensor(path: string, matches: (name: string) => boolean): boolean {
  let descriptor = -1;
  try {
    descriptor = openSync(path, "r");
    const reader = new GgufHeaderReader(descriptor, fstatSync(descriptor).size);
    if (reader.text(4) !== "GGUF") return false;
    const version = reader.u32();
    if (version < 2 || version > 3) return false;
    const tensorCount = reader.count();
    const metadataCount = reader.count();
    if (tensorCount > MAX_COLLECTION_ITEMS || metadataCount > MAX_COLLECTION_ITEMS) return false;

    for (let index = 0; index < metadataCount; index += 1) {
      reader.skipString();
      reader.skipValue(reader.u32());
    }
    for (let index = 0; index < tensorCount; index += 1) {
      const name = reader.string();
      const dimensions = reader.u32();
      if (dimensions > 16) return false;
      reader.skip(dimensions * 8);
      reader.skip(4 + 8); // ggml type + tensor-data offset
      if (matches(name)) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

class GgufHeaderReader {
  #position = 0;
  readonly #buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  #bufferStart = -1;
  #bufferLength = 0;

  constructor(readonly descriptor: number, readonly fileBytes: number) {}

  u32(): number { return this.bytes(4).readUInt32LE(0); }

  count(): number {
    const value = Number(this.bytes(8).readBigUInt64LE(0));
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid GGUF collection length");
    return value;
  }

  text(length: number): string { return this.bytes(length).toString("utf8"); }

  string(): string {
    const length = this.count();
    if (length > MAX_HEADER_BYTES) throw new RangeError("GGUF string exceeds header boundary");
    return this.text(length);
  }

  skipString(): void { this.skip(this.count()); }

  skipValue(type: number): void {
    const fixedBytes = [1, 1, 2, 2, 4, 4, 4, 1, undefined, undefined, 8, 8, 8][type];
    if (fixedBytes !== undefined) { this.skip(fixedBytes); return; }
    if (type === 8) { this.skipString(); return; }
    if (type !== 9) throw new TypeError(`Unsupported GGUF metadata type ${type}`);
    const itemType = this.u32();
    const count = this.count();
    if (count > MAX_COLLECTION_ITEMS) throw new RangeError("GGUF array exceeds inspection boundary");
    const itemBytes = [1, 1, 2, 2, 4, 4, 4, 1, undefined, undefined, 8, 8, 8][itemType];
    if (itemBytes !== undefined) { this.skip(count * itemBytes); return; }
    for (let index = 0; index < count; index += 1) this.skipValue(itemType);
  }

  skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid GGUF field length");
    const next = this.#position + length;
    if (next > this.fileBytes || next > MAX_HEADER_BYTES) throw new RangeError("GGUF header exceeds inspection boundary");
    this.#position = next;
  }

  bytes(length: number): Buffer {
    if (length > this.#buffer.length) {
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readSync(this.descriptor, buffer, 0, length, this.#position);
      if (bytesRead !== length) throw new RangeError("Truncated GGUF header");
      this.#position += length;
      if (this.#position > MAX_HEADER_BYTES) throw new RangeError("GGUF header exceeds inspection boundary");
      return buffer;
    }
    const bufferEnd = this.#bufferStart + this.#bufferLength;
    if (this.#position < this.#bufferStart || this.#position + length > bufferEnd) {
      this.#bufferStart = this.#position;
      this.#bufferLength = readSync(this.descriptor, this.#buffer, 0, this.#buffer.length, this.#bufferStart);
    }
    const offset = this.#position - this.#bufferStart;
    if (offset < 0 || offset + length > this.#bufferLength) throw new RangeError("Truncated GGUF header");
    const value = this.#buffer.subarray(offset, offset + length);
    this.#position += length;
    if (this.#position > MAX_HEADER_BYTES) throw new RangeError("GGUF header exceeds inspection boundary");
    return value;
  }
}
