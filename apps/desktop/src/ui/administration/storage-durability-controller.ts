import { textBlock } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";

type Json = Record<string, any>;
type Api = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface StorageDurabilityElements {
  summary: HTMLElement;
  issues: HTMLElement;
  backups: HTMLElement;
  quota: HTMLInputElement;
  verify: HTMLButtonElement;
  collectGarbage: HTMLButtonElement;
  createBackup: HTMLButtonElement;
  saveQuota: HTMLButtonElement;
  confirmation: HTMLElement;
  confirmationText: HTMLElement;
  cancelRestore: HTMLButtonElement;
  confirmRestore: HTMLButtonElement;
}

export interface StorageDurabilityOptions {
  api: Api;
  reload: () => Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

export class StorageDurabilityController {
  readonly #elements: StorageDurabilityElements;
  readonly #options: StorageDurabilityOptions;
  #pendingRestoreId: string | undefined;

  constructor(elements: StorageDurabilityElements, options: StorageDurabilityOptions) {
    this.#elements = elements;
    this.#options = options;
    elements.verify.addEventListener("click", () => void this.#verify());
    elements.collectGarbage.addEventListener("click", () => void this.#collectGarbage());
    elements.createBackup.addEventListener("click", () => void this.#createBackup());
    elements.saveQuota.addEventListener("click", () => void this.#saveQuota());
    elements.cancelRestore.addEventListener("click", () => this.#cancelRestore());
    elements.confirmRestore.addEventListener("click", () => void this.#restore());
  }

  render(payload: Json): void {
    const report = payload.report ?? {};
    const cards = [
      stat("Artifacts", String(number(report.artifacts))),
      stat("Stored objects", String(number(report.objects))),
      stat("Referenced", formatBytes(number(report.referencedBytes))),
      stat("Unreferenced", `${number(report.orphanObjects)} · ${formatBytes(number(report.orphanBytes))}`),
    ];
    this.#elements.summary.replaceChildren(...cards);
    this.#elements.quota.value = report.quotaBytes ? String(bytesToGiB(number(report.quotaBytes))) : "";
    this.#renderIssues(payload.error ? [{ type: "unavailable", detail: payload.error }] : report.issues ?? []);
    this.#renderBackups(payload.backups ?? [], payload.available !== false);
  }

  #renderIssues(issues: Json[]): void {
    if (!issues.length) {
      this.#elements.issues.replaceChildren(empty("No integrity problems detected"));
      return;
    }
    this.#elements.issues.replaceChildren(...issues.map((issue) => {
      const row = document.createElement("div");
      row.className = "storage-integrity-row";
      row.append(textBlock("strong", String(issue.type ?? "integrity issue")), textBlock("span", String(issue.detail ?? issue.objectKey ?? "Unknown problem")));
      return row;
    }));
  }

  #renderBackups(backups: Json[], available: boolean): void {
    if (!available) {
      this.#elements.backups.replaceChildren(empty("Backups are unavailable in this host configuration"));
      return;
    }
    if (!backups.length) {
      this.#elements.backups.replaceChildren(empty("No backups yet"));
      return;
    }
    this.#elements.backups.replaceChildren(...backups.map((backup) => {
      const row = document.createElement("div");
      row.className = "storage-backup-row";
      const detail = document.createElement("span");
      detail.className = "storage-backup-detail";
      detail.append(textBlock("strong", new Date(String(backup.createdAt)).toLocaleString()), textBlock("small", `${number(backup.objects)} objects · ${formatBytes(number(backup.bytes))}`));
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "Restore";
      restore.addEventListener("click", () => this.#requestRestore(String(backup.id), String(backup.createdAt)));
      row.append(detail, restore);
      return row;
    }));
  }

  async #verify(): Promise<void> { await this.#run(this.#elements.verify, async () => { await this.#options.api("/api/v1/management/storage/verify", "POST", { verifyChecksums: true }); this.#options.showStatus("Storage verified", "success"); }); }
  async #collectGarbage(): Promise<void> { await this.#run(this.#elements.collectGarbage, async () => { const response = await this.#options.api("/api/v1/management/storage/gc", "POST"); const result = response.data ?? {}; this.#options.showStatus(`Removed ${number(result.objects)} unreferenced objects`, "success"); }); }
  async #createBackup(): Promise<void> { await this.#run(this.#elements.createBackup, async () => { await this.#options.api("/api/v1/management/backups", "POST"); this.#options.showStatus("Backup created and verified", "success"); }); }
  async #saveQuota(): Promise<void> {
    const raw = this.#elements.quota.value.trim();
    const gib = raw ? Number(raw) : undefined;
    if (gib !== undefined && (!Number.isFinite(gib) || gib <= 0)) { this.#options.showStatus("Quota must be a positive number of GiB, or blank for unlimited", "error"); return; }
    await this.#run(this.#elements.saveQuota, async () => {
      await this.#options.api("/api/v1/management/storage/quota", "PUT", { quotaBytes: gib === undefined ? null : Math.round(gib * 1024 ** 3) });
      this.#options.showStatus(gib === undefined ? "Artifact quota removed" : `Artifact quota set to ${gib} GiB`, "success");
    });
  }

  #requestRestore(id: string, createdAt: string): void {
    this.#pendingRestoreId = id;
    this.#elements.confirmationText.textContent = `Restore the coordinated database and artifact backup from ${new Date(createdAt).toLocaleString()} on the next host restart? Current storage is retained as a rollback copy.`;
    this.#elements.confirmation.hidden = false;
  }

  #cancelRestore(): void { this.#pendingRestoreId = undefined; this.#elements.confirmation.hidden = true; }

  async #restore(): Promise<void> {
    const id = this.#pendingRestoreId;
    if (!id) return;
    await this.#run(this.#elements.confirmRestore, async () => {
      await this.#options.api(`/api/v1/management/backups/${encodeURIComponent(id)}/restore`, "POST");
      this.#cancelRestore();
      this.#options.showStatus("Restore verified and scheduled. Restart the host to apply it.", "success");
    }, false);
  }

  async #run(button: HTMLButtonElement, operation: () => Promise<void>, reload = true): Promise<void> {
    button.disabled = true;
    try { await operation(); if (reload) await this.#options.reload(); }
    catch (error) { this.#options.showStatus(this.#options.errorMessage(error), "error"); }
    finally { button.disabled = false; }
  }
}

function stat(label: string, value: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "diagnostic-stat";
  element.append(textBlock("small", label), textBlock("strong", value));
  return element;
}
function empty(message: string): HTMLElement { const element = textBlock("div", message); element.className = "empty-state"; return element; }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; const units = ["KiB", "MiB", "GiB", "TiB"]; let value = bytes / 1024; let unit = units[0]!; for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]!; } return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`; }
function bytesToGiB(bytes: number): number { return Number((bytes / 1024 ** 3).toFixed(3)); }
