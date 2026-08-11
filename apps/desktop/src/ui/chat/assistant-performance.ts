import type { RequestUsageRecord } from "@fitz/protocol";

type Json = Record<string, any>;

interface TrackedAssistant {
  target: HTMLElement;
  observedAt: string;
}

export interface AssistantPerformanceOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  apply: (target: HTMLElement, usage: RequestUsageRecord) => void;
}

/** Matches durable per-request model telemetry to the assistant bubble emitted
 * during that request. This also hydrates restored transcript messages. */
export class AssistantPerformance {
  readonly #options: AssistantPerformanceOptions;
  readonly #tracked = new Map<string, TrackedAssistant[]>();
  readonly #scheduled = new Set<string>();
  #generation = 0;

  constructor(options: AssistantPerformanceOptions) { this.#options = options; }

  reset(): void {
    this.#generation += 1;
    this.#tracked.clear();
    this.#scheduled.clear();
  }

  track(target: HTMLElement, runId: string, observedAt?: string): void {
    const time = target.closest("article.message")?.querySelector<HTMLTimeElement>("time.message-time");
    const timestamp = observedAt ?? time?.dateTime ?? new Date().toISOString();
    const tracked = this.#tracked.get(runId) ?? [];
    if (!tracked.some((item) => item.target === target)) tracked.push({ target, observedAt: timestamp });
    this.#tracked.set(runId, tracked);
    if (this.#scheduled.has(runId)) return;
    this.#scheduled.add(runId);
    queueMicrotask(() => {
      this.#scheduled.delete(runId);
      void this.refresh(runId);
    });
  }

  async refresh(runId: string): Promise<void> {
    const generation = this.#generation;
    try {
      const response = await this.#options.api(`/api/v1/agent/runs/${encodeURIComponent(runId)}/usage`);
      if (generation !== this.#generation) return;
      const usage = (Array.isArray(response.data) ? response.data : []) as RequestUsageRecord[];
      this.#apply(runId, usage.filter((record) => record.kind === "chat"));
    } catch {
      // Telemetry is supplementary; never turn a successful response into a UI error.
    }
  }

  #apply(runId: string, usage: RequestUsageRecord[]): void {
    const messages = (this.#tracked.get(runId) ?? []).filter((item) => item.target.isConnected);
    const used = new Set(messages.map((item) => item.target.dataset.usageId).filter(Boolean));
    for (const message of messages) {
      if (message.target.dataset.usageId) continue;
      const timestamp = Date.parse(message.observedAt);
      const candidate = usage
        .filter((record) => !used.has(record.id))
        .map((record) => ({ record, distance: usageDistance(timestamp, record) }))
        .sort((left, right) => left.distance - right.distance)[0]?.record;
      if (!candidate) continue;
      message.target.dataset.usageId = candidate.id;
      used.add(candidate.id);
      this.#options.apply(message.target, candidate);
    }
  }
}

/** Live messages are timestamped near first output; restored transcript entries
 * are timestamped near completion. Taking the nearer boundary handles both. */
function usageDistance(timestamp: number, usage: RequestUsageRecord): number {
  if (!Number.isFinite(timestamp)) return Number.MAX_SAFE_INTEGER;
  const boundaries = [usage.firstOutputAt, usage.startedAt, usage.completedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return boundaries.length ? Math.min(...boundaries.map((value) => Math.abs(timestamp - value))) : Number.MAX_SAFE_INTEGER;
}
