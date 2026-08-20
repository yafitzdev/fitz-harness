type Json = Record<string, any>;

export interface SidebarActivityOptions {
  api: (path: string, method?: string) => Promise<Json>;
  onChange: (processingSessionIds: ReadonlySet<string>) => void;
  /** How often the durable queue is checked while agent work is active. */
  pollIntervalMs?: number;
}

/**
 * Keeps the sidebar's processing indicators backed by the host's durable
 * queue rather than by whichever chat is currently selected. A chat can keep
 * running after its conversation view detaches, so selection-local state is
 * not sufficient here.
 */
export class SidebarActivityController {
  readonly #options: SidebarActivityOptions;
  readonly #pollIntervalMs: number;
  #processingSessionIds = new Set<string>();
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshing = false;
  #started = false;

  constructor(options: SidebarActivityOptions) {
    this.#options = options;
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 800);
  }

  get processingSessionIds(): ReadonlySet<string> { return this.#processingSessionIds; }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.refresh();
  }

  stop(): void {
    this.#started = false;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  /** Refresh once immediately. Polling continues only while agent work is active. */
  async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const response = await this.#options.api("/api/v1/work/queue");
      const next = processingSessionIds(response.data);
      if (!sameSet(this.#processingSessionIds, next)) {
        this.#processingSessionIds = next;
        this.#options.onChange(this.#processingSessionIds);
      }
    } catch {
      // Keep the last known state during a transient host reconnect. Clearing
      // the indicators here would make an active chat look idle while the
      // host is briefly unavailable.
    } finally {
      this.#refreshing = false;
      this.#scheduleNextRefresh();
    }
  }

  #scheduleNextRefresh(): void {
    if (!this.#started || this.#pollTimer || this.#processingSessionIds.size === 0) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      void this.refresh();
    }, this.#pollIntervalMs);
  }
}

/** Returns only durable agent work associated with a chat. Media jobs and
 * agent runs without a session must not paint a chat-row spinner. */
export function processingSessionIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  const result = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Json;
    if (record.kind !== "agent" || (record.status !== "queued" && record.status !== "running")) continue;
    if (typeof record.sessionId !== "string" || !record.sessionId.trim()) continue;
    result.add(record.sessionId);
  }
  return result;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
