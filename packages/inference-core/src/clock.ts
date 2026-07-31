export interface ScheduledTask {
  cancel(): void;
}

export interface Clock {
  now(): number;
  schedule(delayMs: number, callback: () => void | Promise<void>): ScheduledTask;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  schedule(delayMs: number, callback: () => void | Promise<void>): ScheduledTask {
    const handle = setTimeout(() => void callback(), Math.max(0, delayMs));
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  }
}

interface ManualTask {
  id: number;
  dueAt: number;
  callback: () => void | Promise<void>;
  cancelled: boolean;
}

export class ManualClock implements Clock {
  #now: number;
  #nextId = 1;
  readonly #tasks: ManualTask[] = [];

  constructor(initialTime = 0) {
    this.#now = initialTime;
  }

  now(): number {
    return this.#now;
  }

  schedule(delayMs: number, callback: () => void | Promise<void>): ScheduledTask {
    const task: ManualTask = {
      id: this.#nextId++,
      dueAt: this.#now + Math.max(0, delayMs),
      callback,
      cancelled: false,
    };
    this.#tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  async advanceBy(milliseconds: number): Promise<void> {
    const target = this.#now + milliseconds;
    while (true) {
      const next = this.#tasks
        .filter((task) => !task.cancelled && task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      next.cancelled = true;
      this.#now = next.dueAt;
      await next.callback();
    }
    this.#now = target;
  }
}
