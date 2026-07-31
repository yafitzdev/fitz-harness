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
    expect(metrics.snapshot()).toEqual(
      expect.objectContaining({
        counters: expect.objectContaining({ model_loads_total: 1, inference_requests_completed_total: 1 }),
        gauges: { inference_queue_depth: 1 },
        timings: {
          http_request_duration_ms: { count: 2, sumMs: 30, averageMs: 15, maxMs: 20 },
        },
      }),
    );
  });
});
