interface PendingReader<T> {
  resolve(value: IteratorResult<T>): void;
  reject(reason: unknown): void;
}

interface BufferedItem<T> {
  value: T;
  size: number;
}

interface PendingWriter<T> extends BufferedItem<T> {
  resolve(): void;
  reject(reason: unknown): void;
  detachAbort?: () => void;
}

export interface AsyncChannelOptions<T> {
  /** Maximum number of values waiting for a consumer. */
  capacity?: number;
  /** Optional second bound for variable-sized values. */
  maxBufferedSize?: number;
  sizeOf?: (value: T) => number;
  /** Permit one value larger than maxBufferedSize when it is the only buffered
   * value. This matches stream high-water-mark behavior for protocols whose
   * terminal result is an intrinsically atomic payload. */
  allowSingleOversizedItem?: boolean;
}

export class AsyncChannelClosedError extends Error {
  constructor() {
    super("Async channel is closed");
    this.name = "AsyncChannelClosedError";
  }
}

export class AsyncChannel<T> implements AsyncIterable<T> {
  readonly #items: BufferedItem<T>[] = [];
  readonly #readers: PendingReader<T>[] = [];
  readonly #writers: PendingWriter<T>[] = [];
  readonly #capacity: number;
  readonly #maxBufferedSize: number;
  readonly #sizeOf: (value: T) => number;
  readonly #allowSingleOversizedItem: boolean;
  #bufferedSize = 0;
  #closed = false;
  #error: unknown;

  constructor(options: AsyncChannelOptions<T> = {}) {
    this.#capacity = positiveInteger(options.capacity ?? 64, "capacity");
    this.#maxBufferedSize = positiveInteger(options.maxBufferedSize ?? Number.MAX_SAFE_INTEGER, "maxBufferedSize");
    this.#sizeOf = options.sizeOf ?? (() => 1);
    this.#allowSingleOversizedItem = options.allowSingleOversizedItem ?? false;
  }

  get bufferedCount(): number { return this.#items.length }
  get bufferedSize(): number { return this.#bufferedSize }
  get pendingWriters(): number { return this.#writers.length }

  async push(item: T, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw this.#error ?? new AsyncChannelClosedError();
    if (signal?.aborted) throw abortError();
    const size = normalizedSize(this.#sizeOf(item));
    const reader = this.#readers.shift();
    if (reader) {
      reader.resolve({ value: item, done: false });
      return;
    }
    if (size > this.#maxBufferedSize && !this.#allowSingleOversizedItem) throw new RangeError(`Channel item size ${size} exceeds maximum ${this.#maxBufferedSize}`);
    if (this.#canBuffer(size)) {
      this.#buffer({ value: item, size });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const writer: PendingWriter<T> = { value: item, size, resolve, reject };
      if (signal) {
        const abort = () => {
          const index = this.#writers.indexOf(writer);
          if (index >= 0) this.#writers.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", abort, { once: true });
        writer.detachAbort = () => signal.removeEventListener("abort", abort);
      }
      this.#writers.push(writer);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectWriters(new AsyncChannelClosedError());
    for (const reader of this.#readers.splice(0)) {
      reader.resolve({ value: undefined, done: true });
    }
  }

  fail(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = reason;
    this.#rejectWriters(reason);
    for (const reader of this.#readers.splice(0)) reader.reject(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) {
          this.#bufferedSize -= item.size;
          this.#admitWriters();
          return { value: item.value, done: false };
        }
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { value: undefined, done: true };
        const writer = this.#writers.shift();
        if (writer) {
          writer.detachAbort?.();
          writer.resolve();
          return { value: writer.value, done: false };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#readers.push({ resolve, reject });
        });
      },
    };
  }

  #canBuffer(size: number): boolean {
    if (this.#items.length >= this.#capacity) return false;
    if (this.#bufferedSize + size <= this.#maxBufferedSize) return true;
    return this.#allowSingleOversizedItem && this.#items.length === 0;
  }

  #buffer(item: BufferedItem<T>): void {
    this.#items.push(item);
    this.#bufferedSize += item.size;
  }

  #admitWriters(): void {
    while (this.#writers.length > 0) {
      const writer = this.#writers[0]!;
      const reader = this.#readers.shift();
      if (reader) {
        this.#writers.shift();
        writer.detachAbort?.();
        writer.resolve();
        reader.resolve({ value: writer.value, done: false });
        continue;
      }
      if (!this.#canBuffer(writer.size)) return;
      this.#writers.shift();
      writer.detachAbort?.();
      this.#buffer(writer);
      writer.resolve();
    }
  }

  #rejectWriters(reason: unknown): void {
    for (const writer of this.#writers.splice(0)) {
      writer.detachAbort?.();
      writer.reject(reason);
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function normalizedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Channel item size must be a non-negative integer");
  return value;
}

function abortError(): Error {
  const error = new Error("Async channel write was aborted");
  error.name = "AbortError";
  return error;
}
