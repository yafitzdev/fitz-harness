// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentQueueController } from "./agent-queue.js";

beforeEach(() => document.body.replaceChildren());

describe("AgentQueueController", () => {
  it("renders running and queued requests and cancels through the host", async () => {
    const list = document.createElement("div");
    const count = document.createElement("span");
    const api = vi.fn()
      .mockResolvedValueOnce({ data: [
        { runId: "run-1", status: "running", sessionTitle: "Current task", projectName: "Fitz" },
        { runId: "run-2", status: "queued", routeId: "smart", projectName: "Demo", position: 2 },
      ] })
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: [] });
    const controller = new AgentQueueController({ list, count, api, showToast: vi.fn(), errorMessage: String });

    await controller.refresh();
    expect(count.textContent).toBe("2");
    expect(list.textContent).toContain("Current taskFitz · Running");
    expect(list.textContent).toContain("smart taskDemo · Position 2");

    list.querySelector<HTMLButtonElement>(".queue-cancel")!.click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/agent/runs/run-1", "DELETE"));
    await vi.waitFor(() => expect(count.textContent).toBe("0"));
    expect(list.textContent).toContain("No active requests");
  });

  it("shows a stable unavailable state when the host cannot be reached", async () => {
    const list = document.createElement("div");
    const count = document.createElement("span");
    const controller = new AgentQueueController({
      list,
      count,
      api: vi.fn().mockRejectedValue(new Error("offline")),
      showToast: vi.fn(),
      errorMessage: String,
    });
    await controller.refresh();
    expect(count.textContent).toBe("—");
    expect(list.textContent).toBe("Queue unavailable");
  });
});
