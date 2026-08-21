export type LocalHostBootstrapState = "idle" | "connecting" | "retrying" | "ready" | "offline";

export interface LocalHostBootstrapSnapshot {
  state: LocalHostBootstrapState;
  detail?: string;
}

export interface LocalHostBootstrapOptions {
  connect: () => Promise<void>;
  restartHost: () => Promise<boolean>;
  onStateChange: (snapshot: LocalHostBootstrapSnapshot) => void;
  errorMessage?: (error: unknown) => string;
}

/** Serializes renderer bootstrap and makes host availability an explicit UI
 * state. Startup signals and manual retries share one attempt, so a slow host
 * cannot trigger duplicate workspace loads or an unbounded retry loop. */
export class LocalHostBootstrapController {
  readonly #options: LocalHostBootstrapOptions;
  #attempt: Promise<void> | undefined;
  #state: LocalHostBootstrapState = "idle";

  constructor(options: LocalHostBootstrapOptions) {
    this.#options = options;
  }

  get state(): LocalHostBootstrapState { return this.#state; }
  get isReady(): boolean { return this.#state === "ready"; }

  start(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return this.#run(false);
  }

  retry(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return this.#run(true);
  }

  #run(restart: boolean): Promise<void> {
    if (this.#attempt) return this.#attempt;
    const attempt = (async () => {
      this.#transition(restart ? "retrying" : "connecting");
      try {
        if (restart && !await this.#options.restartHost()) throw new Error("The local Fitz host could not be started.");
        await this.#options.connect();
        this.#transition("ready");
      } catch (error) {
        const detail = this.#options.errorMessage?.(error)
          ?? (error instanceof Error ? error.message : String(error));
        this.#transition("offline", detail);
      }
    })();
    this.#attempt = attempt;
    void attempt.finally(() => { if (this.#attempt === attempt) this.#attempt = undefined; });
    return attempt;
  }

  #transition(state: LocalHostBootstrapState, detail?: string): void {
    this.#state = state;
    this.#options.onStateChange({ state, ...(detail ? { detail } : {}) });
  }
}
