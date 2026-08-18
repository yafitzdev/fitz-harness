import type { InferenceEvidenceDelta } from "@fitz/protocol";

export type EvidenceDeltaBatchSink = (records: readonly InferenceEvidenceDelta[]) => void | Promise<void>;

export interface EvidenceDeltaBufferOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Removes durable evidence I/O from the inference stream's delivery path.
 *
 * Enqueue is deliberately synchronous and allocation-only. Batches are
 * serialized through one background tail so a synchronous SQLite sink can
 * commit many deltas in one transaction without running once per token. A
 * terminal caller awaits flush(evidenceId), which establishes durability
 * before the request itself is recorded as complete.
 */
export class EvidenceDeltaBuffer {
  readonly #sink: EvidenceDeltaBatchSink | undefined;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #setTimer: NonNullable<EvidenceDeltaBufferOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<EvidenceDeltaBufferOptions["clearTimer"]>;
  readonly #pending = new Map<string, InferenceEvidenceDelta[]>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #writeTail: Promise<void> = Promise.resolve();

  constructor(sink: EvidenceDeltaBatchSink | undefined, options: EvidenceDeltaBufferOptions = {}) {
    this.#sink = sink;
    this.#batchSize = positiveInteger(options.batchSize ?? 64, "Evidence delta batch size");
    this.#flushIntervalMs = positiveInteger(options.flushIntervalMs ?? 100, "Evidence delta flush interval");
    this.#setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  enqueue(record: InferenceEvidenceDelta): void {
    if (!this.#sink) return;
    const records = this.#pending.get(record.evidenceId) ?? [];
    if (!this.#pending.has(record.evidenceId)) this.#pending.set(record.evidenceId, records);
    records.push(record);
    if (records.length >= this.#batchSize) {
      void this.flush(record.evidenceId);
      return;
    }
    if (!this.#timers.has(record.evidenceId)) {
      const timer = this.#setTimer(() => {
        this.#timers.delete(record.evidenceId);
        void this.flush(record.evidenceId);
      }, this.#flushIntervalMs);
      this.#timers.set(record.evidenceId, timer);
    }
  }

  /** Flushes pending records for one inference request and joins all earlier writes. */
  flush(evidenceId: string): Promise<void> {
    const timer = this.#timers.get(evidenceId);
    if (timer !== undefined) {
      this.#clearTimer(timer);
      this.#timers.delete(evidenceId);
    }
    const records = this.#pending.get(evidenceId);
    if (!records?.length || !this.#sink) return this.#writeTail;
    this.#pending.delete(evidenceId);
    const batch = records.slice();
    this.#writeTail = this.#writeTail
      .then(() => this.#sink!(batch))
      .then(() => undefined)
      .catch(() => undefined);
    return this.#writeTail;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}
