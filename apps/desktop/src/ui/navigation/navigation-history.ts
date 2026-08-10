export type AppLocation =
  | { view: "conversation"; projectId?: string; sessionId?: string; newChat?: boolean }
  | { view: "playbooks" | "connections" | "plugins" | "models" | "usage" | "administration" };

export interface NavigationHistoryOptions {
  blocked: () => boolean;
  replay: (location: AppLocation) => void | Promise<void>;
}

/** Owns task/page history independently from the views that replay entries. */
export class NavigationHistoryController {
  readonly #options: NavigationHistoryOptions;
  readonly #entries: AppLocation[] = [];
  #index = -1;
  #replaying = false;

  constructor(options: NavigationHistoryOptions) { this.#options = options; }

  remember(location: AppLocation): void {
    if (this.#replaying) return;
    const previous = this.#entries[this.#index];
    if (previous && sameLocation(previous, location)) return;
    this.#entries.splice(this.#index + 1);
    this.#entries.push(location);
    this.#index = this.#entries.length - 1;
  }

  async navigate(offset: -1 | 1): Promise<void> {
    const nextIndex = this.#index + offset;
    const location = this.#entries[nextIndex];
    if (!location || this.#options.blocked()) return;
    this.#index = nextIndex;
    this.#replaying = true;
    try { await this.#options.replay(location); }
    finally { this.#replaying = false; }
  }
}

function sameLocation(left: AppLocation, right: AppLocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
