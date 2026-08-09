// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SafetyRecoveryController, type SafetyRecoveryElements } from "./safety-recovery-controller.js";

function button(): HTMLButtonElement { return document.createElement("button"); }
function element(): HTMLElement { return document.createElement("div"); }

function setup() {
  const elements: SafetyRecoveryElements = {
    trash: element(), snapshots: element(), toolActions: element(), emptyTrash: button(), runRetention: button(), confirmation: element(),
    confirmationText: element(), cancelEmptyTrash: button(), confirmEmptyTrash: button(),
  };
  elements.confirmation.hidden = true;
  const api = vi.fn(async (path: string) => path.endsWith("/trash") ? { data: { removed: 2 } } : { data: { trash: 1, snapshots: 2 } });
  const reload = vi.fn(async () => undefined);
  const showToast = vi.fn();
  const controller = new SafetyRecoveryController(elements, { api, reload, showToast, errorMessage: (error) => String(error) });
  return { controller, elements, api, reload, showToast };
}

beforeEach(() => document.body.replaceChildren());

describe("SafetyRecoveryController", () => {
  it("renders trash, snapshots, and tool actions with working restore controls", async () => {
    const { controller, elements, api, showToast } = setup();
    controller.renderTrash([{ id: "trash-1", originalPath: "notes.md", workspaceRoot: "C:\\work", createdAt: "2026-08-04T09:00:00Z" }]);
    controller.renderSnapshots([{ runId: "run-1", status: "active", fileCount: 42, createdAt: "2026-08-04T09:00:00Z" }]);
    controller.renderToolActions([{ runId: "run-1", toolName: "bash", effect: "rewrite", path: "notes.md" }]);
    expect(elements.trash.textContent).toContain("notes.md");
    expect(elements.snapshots.textContent).toContain("42 files");
    expect(elements.toolActions.textContent).toContain("bash · rewrite");
    elements.trash.querySelector("button")?.click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/trash/trash-1/restore", "POST"));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("File restored"));
  });

  it("requires confirmation before emptying trash and runs bounded retention", async () => {
    const { elements, api, reload, showToast } = setup();
    elements.emptyTrash.click();
    expect(elements.confirmation.hidden).toBe(false);
    elements.confirmEmptyTrash.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Trash emptied (2 files removed)"));
    expect(api).toHaveBeenCalledWith("/api/v1/management/trash", "DELETE");
    elements.runRetention.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Retention swept 1 trashed file and 2 snapshots"));
    expect(api).toHaveBeenCalledWith("/api/v1/management/trash/gc", "POST", { maxAgeDays: 30 });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
