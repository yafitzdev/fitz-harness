interface PendingReader<T> {
  resolve(value: IteratorResult<T>): void;
  reject(reason: unknown): void;
}

export class AsyncChannel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #readers: PendingReader<T>[] = [];
  #closed = false;
  #error: unknown;

  push(item: T): void {
    if (this.#closed) return;
    const reader = this.#readers.shift();
    if (reader) reader.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) {
      reader.resolve({ value: undefined, done: true });
    }
  }

  fail(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = reason;
    for (const reader of this.#readers.splice(0)) reader.reject(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return { value: item, done: false };
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#readers.push({ resolve, reject });
        });
      },
    };
  }
}
