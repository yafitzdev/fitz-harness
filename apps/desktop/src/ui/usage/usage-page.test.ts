// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@fitz/protocol";
import { createUsagePageClient, UsagePageController } from "./usage-page.js";

const report: UsageReport = {
  from: "2026-08-03T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z", bucket: "day",
  totals: { requests: 12, successful: 9, failed: 1, cancelled: 1, interrupted: 1, promptTokens: 8_000, completionTokens: 2_000, totalTokens: 10_000, tokenReportedRequests: 9, mediaJobs: 3, creditCostCents: 0, averageQueueWaitMs: 250, averageTtftMs: 900, averageDurationMs: 4_000, lastActiveAt: "2026-08-09T00:00:00.000Z" },
  timeline: [{ timestamp: "2026-08-09T00:00:00.000Z", requests: 12, failed: 1, interrupted: 1, mediaJobs: 3, promptTokens: 8_000, completionTokens: 2_000 }],
  routes: [{ key: "smart", label: "smart", requests: 8, failed: 1, interrupted: 1, totalTokens: 9_000, averageDurationMs: 4_000 }],
  recipes: [{ key: "qwen", label: "Qwen", requests: 8, failed: 1, interrupted: 1, totalTokens: 9_000, averageDurationMs: 4_000 }],
  modalities: [{ key: "chat", label: "Text", requests: 9, failed: 0, interrupted: 0, totalTokens: 10_000 }],
  users: [{ key: "user-1", label: "Ada", requests: 12, failed: 1, interrupted: 1, totalTokens: 10_000 }],
  devices: [{ key: "device-1", label: "Ada · Laptop", requests: 12, failed: 1, interrupted: 1, totalTokens: 10_000 }],
};

function apiMock() {
  return vi.fn(async (path: string) => {
    if (path === "/api/v1/management/usage-subjects") return { data: [
      { id: "user-1", displayName: "Ada", status: "active", devices: [{ id: "device-1", name: "Laptop" }] },
      { id: "user-2", displayName: "Grace", status: "active", devices: [{ id: "device-2", name: "Desktop" }] },
    ] };
    return { data: report };
  });
}

beforeEach(() => document.body.replaceChildren());

describe("UsagePageController", () => {
  it("rejects malformed usage envelopes at the typed API boundary", async () => {
    const client = createUsagePageClient(async () => ({ data: { totals: {} } }));
    await expect(client.report("/api/v1/management/usage")).rejects.toThrow("usage report is invalid");
  });

  it("renders aggregate KPIs, charts, and breakdowns", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const api = apiMock();
    const controller = new UsagePageController({ root, api: createUsagePageClient(api), errorMessage: String });

    await controller.load();

    expect(api).toHaveBeenCalledWith(expect.stringContaining("/api/v1/management/usage?"));
    expect(root.textContent).toContain("Requests");
    expect(root.textContent).toContain("12");
    expect(root.textContent).toContain("Success rate");
    expect(root.textContent).toContain("Qwen");
    expect(root.querySelector(".usage-line-chart")).not.toBeNull();
    expect(root.textContent).toContain("API keys");
    expect(root.querySelectorAll(".usage-kpi")).toHaveLength(8);
  });

  it("reloads with an hourly bucket when the 24 hour range is selected", async () => {
    const root = document.createElement("div");
    const api = apiMock();
    const controller = new UsagePageController({ root, api: createUsagePageClient(api), errorMessage: String });
    await controller.load();

    const day = [...root.querySelectorAll<HTMLButtonElement>(".usage-range button")].find((button) => button.textContent === "24 hours")!;
    day.click();
    await vi.waitFor(() => expect(api.mock.calls.some(([path]) => String(path).includes("bucket=hour"))).toBe(true));
    expect(api.mock.calls.some(([path]) => String(path).includes("bucket=hour"))).toBe(true);
  });

  it("filters the report by API key", async () => {
    const root = document.createElement("div");
    const api = apiMock();
    const controller = new UsagePageController({ root, api: createUsagePageClient(api), errorMessage: String });
    await controller.load();
    const select = root.querySelector(".usage-scope select") as HTMLSelectElement;
    select.value = "device:device-1";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(api.mock.calls.some(([path]) => String(path).includes("ownerDeviceId=device-1"))).toBe(true));
  });

  it("uses the user name as the user filter and separates users visually", async () => {
    const root = document.createElement("div");
    const api = apiMock();
    const controller = new UsagePageController({ root, api: createUsagePageClient(api), errorMessage: String });
    await controller.load();
    const select = root.querySelector(".usage-scope select") as HTMLSelectElement;
    expect([...select.options].find((item) => item.value === "user:user-1")?.textContent).toBe("Ada");
    expect(select.options[0]?.textContent).toBe("All");
    expect(select.options[1]).toEqual(expect.objectContaining({ disabled: true, value: "separator:all" }));
    expect([...select.options].filter((item) => item.disabled && item.value.startsWith("separator:"))).toHaveLength(2);
    select.value = "user:user-1";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(api.mock.calls.some(([path]) => String(path).includes("ownerUserId=user-1"))).toBe(true));
  });
});
