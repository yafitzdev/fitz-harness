import { OwnerFairQueue } from "./owner-fair-queue.js";

export type WorkLaneStatus = "queued" | "started" | "cancelled" | "completed" | "failed";

export interface LaneWorkItem {
  id: string;
  controller: AbortController;
}

export interface WorkLaneSnapshot<T extends LaneWorkItem> {
  active: readonly T[];
  queued: readonly T[];
}

export interface BoundedWorkLaneOptions<T extends LaneWorkItem> {
  concurrency: number;
  maxQueued: number;
  execute(item: T): Promise<void>;
  settleQueuedCancellation(item: T): void;
  onStateChange(item: T, status: WorkLaneStatus, position: number, depth: number): void;
  ownerOf?(item: T): string;
}

export type WorkLaneEnqueueResult = "accepted" | "full" | "closed";

/** A bounded, cancellation-aware, owner-fair lane. The concurrency limit is
 * the resource contract: the GPU lane uses one; cloud work uses a small bound. */
export class BoundedWorkLane<T extends LaneWorkItem> {
  readonly #queued: OwnerFairQueue<T>;
  readonly #active = new Set<T>();
  readonly #idleWaiters: Array<() => void> = [];
  readonly #options: BoundedWorkLaneOptions<T>;
  #accepting = true;

  constructor(options: BoundedWorkLaneOptions<T>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new TypeError("Work-lane concurrency must be a positive integer");
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 1) {
      throw new TypeError("Work-lane queue capacity must be a positive integer");
    }
    this.#options = options;
    this.#queued = new OwnerFairQueue(options.ownerOf ?? (() => "shared"));
  }

  get depth(): number {
    return this.#active.size + this.#queued.length;
  }

  enqueue(item: T): WorkLaneEnqueueResult {
    if (!this.#accepting) return "closed";
    if (this.#queued.length >= this.#options.maxQueued && this.#active.size >= this.#options.concurrency) return "full";
    this.#queued.enqueue(item);
    this.#publishQueuedPositions();
    this.#pump();
    return "accepted";
  }

  cancel(item: T): boolean {
    if (item.controller.signal.aborted) return false;
    item.controller.abort();
    if (this.#queued.remove(item)) {
      this.#options.settleQueuedCancellation(item);
      this.#options.onStateChange(item, "cancelled", 0, this.depth);
      this.#publishQueuedPositions();
      this.#resolveIdleIfNeeded();
      return true;
    }
    return this.#active.has(item);
  }

  snapshot(): WorkLaneSnapshot<T> {
    return { active: [...this.#active], queued: this.#queued.values() };
  }

  async shutdown(): Promise<void> {
    this.#accepting = false;
    for (const item of this.#queued.values()) this.cancel(item);
    for (const item of this.#active) item.controller.abort();
    if (this.depth > 0) await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #pump(): void {
    while (this.#active.size < this.#options.concurrency) {
      const item = this.#queued.dequeue();
      if (!item) break;
      if (item.controller.signal.aborted) continue;
      this.#active.add(item);
      this.#options.onStateChange(item, "started", 0, this.depth);
      this.#publishQueuedPositions();
      void this.#run(item);
    }
  }

  async #run(item: T): Promise<void> {
    try {
      await this.#options.execute(item);
      this.#options.onStateChange(item, "completed", 0, this.depth - 1);
    } catch {
      this.#options.onStateChange(item, item.controller.signal.aborted ? "cancelled" : "failed", 0, this.depth - 1);
    } finally {
      this.#active.delete(item);
      this.#pump();
      this.#resolveIdleIfNeeded();
    }
  }

  #publishQueuedPositions(): void {
    this.#queued.values().forEach((item, index) => this.#options.onStateChange(item, "queued", index + 1, this.depth));
  }

  #resolveIdleIfNeeded(): void {
    if (this.depth !== 0) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
