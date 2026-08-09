/**
 * A deterministic round-robin queue across owners, with FIFO ordering inside
 * each owner's bucket. It prevents one client burst from monopolizing a shared
 * resource while keeping every individual client's work in submission order.
 */
export class OwnerFairQueue<T> {
  readonly #buckets = new Map<string, T[]>();
  readonly #owners: string[] = [];
  #lastServedOwner: string | undefined;

  constructor(readonly ownerOf: (item: T) => string) {}

  get length(): number {
    let total = 0;
    for (const bucket of this.#buckets.values()) total += bucket.length;
    return total;
  }

  enqueue(item: T): void {
    const owner = this.#owner(item);
    const existing = this.#buckets.get(owner);
    if (existing) {
      existing.push(item);
      return;
    }
    this.#buckets.set(owner, [item]);
    // If the last owner served queued more work before newcomers arrived, put
    // every newcomer ahead of that owner's next turn. Inserting immediately
    // before the last-served owner preserves arrival order among newcomers.
    const lastServedIndex = this.#lastServedOwner === undefined
      ? -1
      : this.#owners.indexOf(this.#lastServedOwner);
    if (lastServedIndex >= 0 && owner !== this.#lastServedOwner) {
      this.#owners.splice(lastServedIndex, 0, owner);
    } else {
      this.#owners.push(owner);
    }
  }

  dequeue(): T | undefined {
    const owner = this.#owners.shift();
    if (owner === undefined) return undefined;
    const bucket = this.#buckets.get(owner);
    const item = bucket?.shift();
    if (!bucket || item === undefined) throw new Error(`Fair queue bucket disappeared: ${owner}`);
    this.#lastServedOwner = owner;
    if (bucket.length > 0) this.#owners.push(owner);
    else this.#buckets.delete(owner);
    return item;
  }

  remove(item: T): boolean {
    const owner = this.#owner(item);
    const bucket = this.#buckets.get(owner);
    if (!bucket) return false;
    const index = bucket.indexOf(item);
    if (index < 0) return false;
    bucket.splice(index, 1);
    if (bucket.length === 0) {
      this.#buckets.delete(owner);
      const ownerIndex = this.#owners.indexOf(owner);
      if (ownerIndex >= 0) this.#owners.splice(ownerIndex, 1);
    }
    return true;
  }

  values(): T[] {
    const buckets = new Map(
      [...this.#buckets.entries()].map(([owner, items]) => [owner, [...items]]),
    );
    const owners = [...this.#owners];
    const result: T[] = [];
    while (owners.length > 0) {
      const owner = owners.shift()!;
      const bucket = buckets.get(owner);
      const item = bucket?.shift();
      if (!bucket || item === undefined) throw new Error(`Fair queue snapshot bucket disappeared: ${owner}`);
      result.push(item);
      if (bucket.length > 0) owners.push(owner);
    }
    return result;
  }

  #owner(item: T): string {
    const owner = this.ownerOf(item).trim();
    if (!owner) throw new TypeError("Fair queue owner must not be empty");
    return owner;
  }
}
