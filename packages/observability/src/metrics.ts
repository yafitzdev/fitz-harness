import type { InferenceLifecycleEvent, RequestUsageRecord } from "@fitz/protocol";

export interface MetricsSnapshot {
  capturedAt: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  timings: Record<string, { count: number; sumMs: number; averageMs: number; maxMs: number }>;
}

interface TimingAccumulator {
  count: number;
  sumMs: number;
  maxMs: number;
}

export class MetricsRegistry {
  readonly #counters = new Map<string, number>();
  readonly #gauges = new Map<string, number>();
  readonly #timings = new Map<string, TimingAccumulator>();

  increment(name: string, amount = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  gauge(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  observe(name: string, milliseconds: number): void {
    const current = this.#timings.get(name) ?? { count: 0, sumMs: 0, maxMs: 0 };
    current.count += 1;
    current.sumMs += milliseconds;
    current.maxMs = Math.max(current.maxMs, milliseconds);
    this.#timings.set(name, current);
  }

  observeLifecycleEvent(event: InferenceLifecycleEvent): void {
    if (event.type === "queue.updated") {
      this.gauge("inference_queue_depth", event.data.depth);
      if (event.data.status !== "queued") {
        this.increment(`inference_requests_${event.data.status}_total`);
      }
      return;
    }
    this.increment(`instance_state_${event.data.state.toLowerCase()}_total`);
    if (event.data.state === "READY" && event.data.previousState === "LOADING") {
      this.increment("model_loads_total");
    }
    if (event.data.state === "UNLOADED" && event.data.previousState === "EVICTING") {
      this.increment("model_evictions_total");
    }
  }

  /** Fold the terminal accounting fact into process diagnostics. Request
   * timing already has one authoritative calculation in the scheduler; the
   * metrics layer aggregates those values instead of reconstructing spans
   * from loosely related lifecycle timestamps. */
  observeRequestUsage(record: RequestUsageRecord): void {
    this.increment("inference_usage_records_total");
    if (record.promptTokens !== undefined) this.increment("inference_prompt_tokens_total", record.promptTokens);
    if (record.completionTokens !== undefined) this.increment("inference_completion_tokens_total", record.completionTokens);
    if (record.queueWaitMs !== undefined) this.observe("inference_queue_wait_ms", record.queueWaitMs);
    if (record.ttftMs !== undefined) this.observe("inference_ttft_ms", record.ttftMs);
    if (record.generationMs !== undefined) this.observe("inference_generation_ms", record.generationMs);
    if (record.durationMs !== undefined) this.observe("inference_request_duration_ms", record.durationMs);
  }

  snapshot(): MetricsSnapshot {
    return {
      capturedAt: new Date().toISOString(),
      counters: Object.fromEntries([...this.#counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
      gauges: Object.fromEntries([...this.#gauges.entries()].sort(([a], [b]) => a.localeCompare(b))),
      timings: Object.fromEntries(
        [...this.#timings.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => [
            name,
            {
              ...value,
              averageMs: value.count === 0 ? 0 : value.sumMs / value.count,
            },
          ]),
      ),
    };
  }
}
