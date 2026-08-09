import { textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

export interface SafetyRecoveryElements {
  trash: HTMLElement;
  snapshots: HTMLElement;
  toolActions: HTMLElement;
  emptyTrash: HTMLButtonElement;
  runRetention: HTMLButtonElement;
  confirmation: HTMLElement;
  confirmationText: HTMLElement;
  cancelEmptyTrash: HTMLButtonElement;
  confirmEmptyTrash: HTMLButtonElement;
}

export interface SafetyRecoveryOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  reload: () => Promise<void>;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

/** Owns trash, snapshots, tool-action audit, retention, and restore actions. */
export class SafetyRecoveryController {
  readonly #elements: SafetyRecoveryElements;
  readonly #options: SafetyRecoveryOptions;
  #pendingEmptyTrash = false;

  constructor(elements: SafetyRecoveryElements, options: SafetyRecoveryOptions) {
    this.#elements = elements;
    this.#options = options;
    elements.emptyTrash.addEventListener("click", () => this.#showEmptyTrashConfirmation());
    elements.cancelEmptyTrash.addEventListener("click", () => this.#hideEmptyTrashConfirmation());
    elements.confirmEmptyTrash.addEventListener("click", () => void this.#applyEmptyTrash());
    elements.runRetention.addEventListener("click", () => void this.#runRetention());
  }

  renderTrash(entries: Json[]): void {
    this.#elements.trash.replaceChildren();
    for (const entry of entries) {
      const row = safetyRow(entry.originalPath, `${entry.workspaceRoot ?? ""} · ${entry.restoredAt ? "restored" : "in trash"} · ${formatDate(entry.createdAt)}`.trim());
      if (!entry.restoredAt) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.textContent = "Restore";
        restore.addEventListener("click", () => void this.#restoreTrashEntry(entry.id));
        row.append(restore);
      }
      this.#elements.trash.append(row);
    }
    if (!entries.length) this.#elements.trash.append(emptyState("Nothing in the trash"));
  }

  renderSnapshots(snapshots: Json[]): void {
    this.#elements.snapshots.replaceChildren();
    for (const snapshot of snapshots) {
      const row = safetyRow(snapshot.runId, `${snapshot.status} · ${Number(snapshot.fileCount ?? 0).toLocaleString()} files · ${formatDate(snapshot.createdAt)}`.trim());
      if (snapshot.status === "active") {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.textContent = "Restore snapshot";
        restore.addEventListener("click", () => void this.#restoreSnapshot(snapshot.runId));
        row.append(restore);
      }
      this.#elements.snapshots.append(row);
    }
    if (!snapshots.length) this.#elements.snapshots.append(emptyState("No snapshots yet"));
  }

  renderToolActions(actions: Json[]): void {
    this.#elements.toolActions.replaceChildren();
    for (const action of actions) {
      this.#elements.toolActions.append(safetyRow(
        `${action.toolName} · ${action.effect}`,
        `${action.runId ?? ""}${action.path ? ` · ${action.path}` : ""} · ${formatDate(action.timestamp)}`.trim(),
      ));
    }
    if (!actions.length) this.#elements.toolActions.append(emptyState("No tool actions recorded yet"));
  }

  #showEmptyTrashConfirmation(): void {
    this.#pendingEmptyTrash = true;
    this.#elements.confirmationText.textContent = "Permanently delete every file in the agent trash? This cannot be undone — restored files are not affected.";
    this.#elements.confirmation.hidden = false;
  }

  #hideEmptyTrashConfirmation(): void {
    this.#pendingEmptyTrash = false;
    this.#elements.confirmation.hidden = true;
  }

  async #applyEmptyTrash(): Promise<void> {
    if (!this.#pendingEmptyTrash) return;
    this.#elements.confirmEmptyTrash.disabled = true;
    try {
      const response = await this.#options.api("/api/v1/management/trash", "DELETE");
      this.#hideEmptyTrashConfirmation();
      await this.#options.reload();
      this.#options.showToast(`Trash emptied (${response.data?.removed ?? 0} file${response.data?.removed === 1 ? "" : "s"} removed)`);
    } catch (error) { this.#options.showToast(this.#options.errorMessage(error)); }
    finally { this.#elements.confirmEmptyTrash.disabled = false; }
  }

  async #runRetention(): Promise<void> {
    this.#elements.runRetention.disabled = true;
    try {
      const response = await this.#options.api("/api/v1/management/trash/gc", "POST", { maxAgeDays: 30 });
      await this.#options.reload();
      const result = response.data ?? {};
      this.#options.showToast(`Retention swept ${Number(result.trash ?? 0)} trashed file${Number(result.trash) === 1 ? "" : "s"} and ${Number(result.snapshots ?? 0)} snapshot${Number(result.snapshots) === 1 ? "" : "s"}`);
    } catch (error) { this.#options.showToast(this.#options.errorMessage(error)); }
    finally { this.#elements.runRetention.disabled = false; }
  }

  async #restoreTrashEntry(id: string): Promise<void> {
    try {
      await this.#options.api(`/api/v1/management/trash/${encodeURIComponent(id)}/restore`, "POST");
      await this.#options.reload();
      this.#options.showToast("File restored");
    } catch (error) { this.#options.showToast(this.#options.errorMessage(error)); }
  }

  async #restoreSnapshot(runId: string): Promise<void> {
    try {
      await this.#options.api(`/api/v1/management/snapshots/${encodeURIComponent(runId)}/restore`, "POST");
      await this.#options.reload();
      this.#options.showToast(`Workspace restored from run ${runId}`);
    } catch (error) { this.#options.showToast(this.#options.errorMessage(error)); }
  }
}

function safetyRow(title: string, detailText: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "admin-safety-row";
  const detail = document.createElement("span");
  detail.className = "admin-safety-detail";
  detail.append(
    Object.assign(document.createElement("strong"), { textContent: title }),
    Object.assign(document.createElement("small"), { textContent: detailText }),
  );
  row.append(detail);
  return row;
}

function formatDate(value: unknown): string { return value ? new Date(String(value)).toLocaleString() : ""; }
function emptyState(message: string): HTMLElement { return textBlock("panel-empty", message); }
