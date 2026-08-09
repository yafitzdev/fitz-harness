// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsController, type DiagnosticsElements } from "./diagnostics-controller.js";

function setup() {
  const elements: DiagnosticsElements = {
    generatedAt: document.createElement("p"), summary: document.createElement("div"), metrics: document.createElement("div"),
    failures: document.createElement("div"), exportButton: document.createElement("button"),
  };
  const bridge = { saveDiagnostics: vi.fn(async () => "C:\\tmp\\diagnostics.json") };
  const showToast = vi.fn();
  const controller = new DiagnosticsController(elements, { bridge, showToast, errorMessage: (error) => String(error) });
  return { controller, elements, bridge, showToast };
}

beforeEach(() => document.body.replaceChildren());

describe("DiagnosticsController", () => {
  it("renders resource, metric, and failure summaries", () => {
    const { controller, elements } = setup();
    controller.render({
      generatedAt: "2026-08-04T10:00:00Z", engine: { state: "LOADED" }, queueDepth: 2,
      resources: { freeRamMiB: 8192, totalRamMiB: 16384, freeVramMiB: 4096, totalVramMiB: 32768 },
      metrics: { counters: { requests: 12 }, gauges: { queue: 2 }, timings: { generation: { averageMs: 42.25 } } },
      recentRequests: [{ routeId: "smart", status: "failed", errorCode: "E001" }],
      recentLifecycleEvents: [{ data: { state: "FAILED", recipeId: "h3", reason: "thermal" } }],
    });
    expect(elements.summary.querySelectorAll(".diagnostic-stat")).toHaveLength(4);
    expect(elements.summary.textContent).toContain("LOADED");
    expect(elements.metrics.textContent).toContain("42.3 ms avg");
    expect(elements.failures.textContent).toContain("E001");
    expect(elements.failures.textContent).toContain("thermal");
  });

  it("exports the latest redacted bundle", async () => {
    const { controller, elements, bridge, showToast } = setup();
    controller.render({ generatedAt: "now", secret: "already-redacted-by-host" });
    elements.exportButton.click();
    await vi.waitFor(() => expect(bridge.saveDiagnostics).toHaveBeenCalledOnce());
    expect(String(bridge.saveDiagnostics.mock.calls[0]?.[0])).toContain("already-redacted-by-host");
    expect(showToast).toHaveBeenCalledWith("Diagnostics saved to C:\\tmp\\diagnostics.json");
  });
});
