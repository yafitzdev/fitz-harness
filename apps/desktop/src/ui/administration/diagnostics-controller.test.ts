// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsController, type DiagnosticsElements } from "./diagnostics-controller.js";

function setup() {
  const elements: DiagnosticsElements = {
    generatedAt: document.createElement("p"), summary: document.createElement("div"), metrics: document.createElement("div"),
    failures: document.createElement("div"), exportStatus: document.createElement("p"), exportButton: document.createElement("button"),
  };
  const bridge = { saveDiagnostics: vi.fn(async () => "C:\\tmp\\diagnostics.json") };
  const controller = new DiagnosticsController(elements, { bridge, errorMessage: (error) => String(error) });
  return { controller, elements, bridge };
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
    const { controller, elements, bridge } = setup();
    controller.render({ generatedAt: "now", secret: "already-redacted-by-host" });
    elements.exportButton.click();
    await vi.waitFor(() => expect(bridge.saveDiagnostics).toHaveBeenCalledOnce());
    expect(String(bridge.saveDiagnostics.mock.calls[0]?.[0])).toContain("already-redacted-by-host");
    expect(elements.exportStatus.textContent).toBe("Saved to C:\\tmp\\diagnostics.json");
    expect(elements.exportStatus.getAttribute("role")).toBe("status");
  });

  it("renders export failures inline", async () => {
    const { controller, elements, bridge } = setup();
    bridge.saveDiagnostics.mockRejectedValue(new Error("disk full"));
    controller.render({ generatedAt: "now" });

    elements.exportButton.click();

    await vi.waitFor(() => expect(elements.exportStatus.textContent).toContain("disk full"));
    expect(elements.exportStatus.getAttribute("role")).toBe("alert");
    expect(elements.exportStatus.dataset.state).toBe("error");
  });
});
