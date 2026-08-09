// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageDurabilityController, type StorageDurabilityElements } from "./storage-durability-controller.js";

function node<T extends keyof HTMLElementTagNameMap>(tag: T): HTMLElementTagNameMap[T] { return document.createElement(tag); }
function setup() {
  const elements: StorageDurabilityElements = {
    summary: node("div"), issues: node("div"), backups: node("div"), quota: node("input"),
    verify: node("button"), collectGarbage: node("button"), createBackup: node("button"), saveQuota: node("button"),
    confirmation: node("div"), confirmationText: node("span"), cancelRestore: node("button"), confirmRestore: node("button"),
  };
  elements.confirmation.hidden = true;
  const api = vi.fn(async () => ({ data: {} }));
  const reload = vi.fn(async () => undefined);
  const showStatus = vi.fn();
  const controller = new StorageDurabilityController(elements, { api, reload, showStatus, errorMessage: String });
  return { controller, elements, api, reload, showStatus };
}
function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
async function settle(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }

beforeEach(() => document.body.replaceChildren());

describe("StorageDurabilityController", () => {
  it("renders integrity state, quota, and restorable backups", () => {
    const { controller, elements } = setup();
    controller.render({ report: { artifacts: 3, objects: 2, referencedBytes: 2048, orphanObjects: 1, orphanBytes: 12, quotaBytes: 2 * 1024 ** 3, issues: [] }, backups: [{ id: "backup-1", createdAt: "2026-08-09T12:00:00Z", objects: 2, bytes: 2048 }], available: true });
    expect(elements.summary.textContent).toContain("Artifacts3");
    expect(elements.quota.value).toBe("2");
    expect(elements.issues.textContent).toContain("No integrity problems");
    expect(elements.backups.textContent).toContain("Restore");
  });

  it("verifies, creates backups, saves quota, and schedules confirmed restore", async () => {
    const { controller, elements, api, reload } = setup();
    controller.render({ report: {}, backups: [{ id: "backup-1", createdAt: "2026-08-09T12:00:00Z", objects: 0, bytes: 0 }], available: true });
    click(elements.verify); await settle();
    expect(api).toHaveBeenCalledWith("/api/v1/management/storage/verify", "POST", { verifyChecksums: true });
    elements.quota.value = "3.5"; click(elements.saveQuota); await settle();
    expect(api).toHaveBeenCalledWith("/api/v1/management/storage/quota", "PUT", { quotaBytes: Math.round(3.5 * 1024 ** 3) });
    click(elements.backups.querySelector("button")!);
    expect(elements.confirmation.hidden).toBe(false);
    click(elements.confirmRestore); await settle();
    expect(api).toHaveBeenCalledWith("/api/v1/management/backups/backup-1/restore", "POST");
    expect(reload).toHaveBeenCalled();
  });
});
