// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkQueueController } from "./work-queue.js";
beforeEach(() => document.body.replaceChildren());
describe("WorkQueueController", () => {
  it("renders both resource lanes and cancels by work id", async () => {
    const list = document.createElement("div"); const count = document.createElement("span");
    const api = vi.fn().mockResolvedValueOnce({ data: [{ id: "run-1", status: "running", label: "Current task", lane: "gpu" }, { id: "cloud-1", status: "queued", routeId: "image", kind: "media", lane: "cloud", position: 1 }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({ data: [] });
    const controller = new WorkQueueController({ list, count, api, showStatus: vi.fn(), errorMessage: String });
    await controller.refresh(); expect(count.textContent).toBe("2"); expect(list.textContent).toContain("Current taskShared GPU · Running"); expect(list.textContent).toContain("image mediaCloud · Next");
    list.querySelector<HTMLButtonElement>(".queue-cancel")!.click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/work/queue/run-1", "DELETE"));
  });
});
