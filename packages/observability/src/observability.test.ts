import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics.js";
import { redactSecrets } from "./redaction.js";

describe("observability", () => {
  it("redacts nested secrets without mutating the source", () => {
    const source = {
      authorization: "Bearer private",
      nested: { apiKey: "private", safe: "visible" },
      list: [{ password: "private" }],
    };
    expect(redactSecrets(source)).toEqual({
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "visible" },
      list: [{ password: "[REDACTED]" }],
    });
    expect(source.authorization).toBe("Bearer private");
  });

  it("records lifecycle counters, gauges, and timings", () => {
    const metrics = new MetricsRegistry();
    metrics.observeLifecycleEvent({
      sequence: 1,
      protocolVersion: "1",
      timestamp: new Date(0).toISOString(),
      type: "instance.state.changed",
      data: { previousState: "LOADING", state: "READY" },
    });
    metrics.observeLifecycleEvent({
      sequence: 2,
      protocolVersion: "1",
      timestamp: new Date(1).toISOString(),
      type: "queue.updated",
      data: {
        requestId: "request",
        routeId: "fast",
        position: 0,
        depth: 1,
        status: "completed",
      },
    });
    metrics.observe("http_request_duration_ms", 10);
    metrics.observe("http_request_duration_ms", 20);
    metrics.observeRequestUsage({
      id: "request-1", kind: "chat", status: "completed", routeId: "default", executionLane: "gpu",
      enqueuedAt: new Date(0).toISOString(), completedAt: new Date(4_000).toISOString(),
      queueWaitMs: 200, ttftMs: 600, generationMs: 3_000, durationMs: 3_800,
      promptTokens: 100, completionTokens: 40,
    });
    expect(metrics.snapshot()).toEqual(
      expect.objectContaining({
        counters: expect.objectContaining({
          model_loads_total: 1,
          inference_requests_completed_total: 1,
          inference_usage_records_total: 1,
          inference_prompt_tokens_total: 100,
          inference_completion_tokens_total: 40,
        }),
        gauges: { inference_queue_depth: 1 },
        timings: expect.objectContaining({
          http_request_duration_ms: { count: 2, sumMs: 30, averageMs: 15, maxMs: 20 },
          inference_ttft_ms: { count: 1, sumMs: 600, averageMs: 600, maxMs: 600 },
          inference_request_duration_ms: { count: 1, sumMs: 3_800, averageMs: 3_800, maxMs: 3_800 },
        }),
      }),
    );
  });
});
