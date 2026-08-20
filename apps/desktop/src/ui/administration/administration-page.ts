import { CollapsibleSection } from "../layout/collapsible-section.js";
import { textBlock } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import { DesktopUpdateController, type DesktopUpdateBridge } from "./desktop-update-controller.js";
import { DiagnosticsController, type DiagnosticsBridge } from "./diagnostics-controller.js";
import { SafetyRecoveryController } from "./safety-recovery-controller.js";
import { StorageDurabilityController } from "./storage-durability-controller.js";

type Json = Record<string, any>;
const MEDIA_ACCESS_ROUTES = [
  { id: "image", label: "Image generation" },
  { id: "video", label: "Video generation" },
  { id: "audio", label: "Audio generation" },
] as const;

export type AdministrationPageApi = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface AdministrationPageBridge extends DesktopUpdateBridge, DiagnosticsBridge {
  copyText(text: string): Promise<void>;
}

export interface AdministrationPageElements {
  /** Root that owns every collapsible admin section; toggles are resolved from it. */
  sections: HTMLElement;
  createUserForm: HTMLFormElement;
  createUserName: HTMLInputElement;
  adminUsers: HTMLElement;
  toolPolicyForm: HTMLFormElement;
  toolPolicySubjectType: HTMLSelectElement;
  toolPolicySubject: HTMLSelectElement;
  toolPolicyName: HTMLInputElement;
  toolPolicyDecision: HTMLSelectElement;
  toolPolicies: HTMLElement;
  adminAuditEvents: HTMLElement;
  adminTrash: HTMLElement;
  adminSnapshots: HTMLElement;
  adminToolActions: HTMLElement;
  emptyTrashButton: HTMLButtonElement;
  gcRetentionButton: HTMLButtonElement;
  emptyTrashConfirmation: HTMLElement;
  emptyTrashConfirmationText: HTMLElement;
  cancelEmptyTrash: HTMLButtonElement;
  confirmEmptyTrash: HTMLButtonElement;
  diagnosticGeneratedAt: HTMLElement;
  diagnosticSummary: HTMLElement;
  diagnosticMetrics: HTMLElement;
  diagnosticFailures: HTMLElement;
  diagnosticExportStatus: HTMLElement;
  exportDiagnostics: HTMLButtonElement;
  checkDesktopUpdate: HTMLButtonElement;
  installDesktopUpdate: HTMLButtonElement;
  desktopUpdateLabel: HTMLElement;
  desktopUpdateVersion: HTMLElement;
  desktopUpdateProgress: HTMLElement;
  updateButton: HTMLButtonElement;
  storageSummary: HTMLElement;
  storageIssues: HTMLElement;
  storageBackups: HTMLElement;
  storageQuota: HTMLInputElement;
  verifyStorage: HTMLButtonElement;
  collectStorageGarbage: HTMLButtonElement;
  createStorageBackup: HTMLButtonElement;
  saveStorageQuota: HTMLButtonElement;
  storageRestoreConfirmation: HTMLElement;
  storageRestoreConfirmationText: HTMLElement;
  cancelStorageRestore: HTMLButtonElement;
  confirmStorageRestore: HTMLButtonElement;
}

export interface AdministrationPageOptions {
  api: AdministrationPageApi;
  bridge: AdministrationPageBridge;
  isAdministrator: () => boolean;
  currentUserId: () => string | undefined;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

export class AdministrationPageController {
  readonly elements: AdministrationPageElements;
  private readonly options: AdministrationPageOptions;
  private users: Json[] = [];
  private policies: Json[] = [];
  private revealUserId: string | undefined;
  private readonly diagnostics: DiagnosticsController;
  private readonly safetyRecovery: SafetyRecoveryController;
  private readonly storageDurability: StorageDurabilityController;

  constructor(elements: AdministrationPageElements, options: AdministrationPageOptions) {
    this.elements = elements;
    this.options = options;
    CollapsibleSection.adoptAll(this.elements.sections, { storageKey: "fitz-collapsed-admin-sections" });
    new DesktopUpdateController({
      check: elements.checkDesktopUpdate,
      install: elements.installDesktopUpdate,
      label: elements.desktopUpdateLabel,
      version: elements.desktopUpdateVersion,
      progress: elements.desktopUpdateProgress,
      globalInstall: elements.updateButton,
    }, options.bridge);
    this.diagnostics = new DiagnosticsController({
      generatedAt: elements.diagnosticGeneratedAt,
      summary: elements.diagnosticSummary,
      metrics: elements.diagnosticMetrics,
      failures: elements.diagnosticFailures,
      exportStatus: elements.diagnosticExportStatus,
      exportButton: elements.exportDiagnostics,
    }, {
      bridge: options.bridge,
      errorMessage: options.errorMessage,
    });
    this.safetyRecovery = new SafetyRecoveryController({
      trash: elements.adminTrash,
      snapshots: elements.adminSnapshots,
      toolActions: elements.adminToolActions,
      emptyTrash: elements.emptyTrashButton,
      runRetention: elements.gcRetentionButton,
      confirmation: elements.emptyTrashConfirmation,
      confirmationText: elements.emptyTrashConfirmationText,
      cancelEmptyTrash: elements.cancelEmptyTrash,
      confirmEmptyTrash: elements.confirmEmptyTrash,
    }, {
      api: options.api,
      reload: () => this.loadAdvanced(),
      showStatus: options.showStatus,
      errorMessage: options.errorMessage,
    });
    this.storageDurability = new StorageDurabilityController({
      summary: elements.storageSummary,
      issues: elements.storageIssues,
      backups: elements.storageBackups,
      quota: elements.storageQuota,
      verify: elements.verifyStorage,
      collectGarbage: elements.collectStorageGarbage,
      createBackup: elements.createStorageBackup,
      saveQuota: elements.saveStorageQuota,
      confirmation: elements.storageRestoreConfirmation,
      confirmationText: elements.storageRestoreConfirmationText,
      cancelRestore: elements.cancelStorageRestore,
      confirmRestore: elements.confirmStorageRestore,
    }, {
      api: options.api,
      reload: () => this.loadAdvanced(),
      showStatus: options.showStatus,
      errorMessage: options.errorMessage,
    });
    this.bind();
  }

  showLoading(): void {
    this.elements.adminUsers.replaceChildren(emptyState("Loading users…"));
  }

  async load(): Promise<void> {
    await Promise.all([this.loadUsers(), this.loadAdvanced()]);
  }

  async loadUsers(): Promise<void> {
    if (!this.options.isAdministrator()) return;
    try {
      const users = await this.options.api("/api/v1/management/users");
      this.users = users.data ?? [];
      const access = await Promise.all(this.users.map((user) =>
        this.options.api(`/api/v1/management/users/${user.id}/access`).then((response) => response.data),
      ));
      this.elements.adminUsers.replaceChildren(...access.map((entry) => this.renderAdminUser(entry)));
      if (!access.length) this.elements.adminUsers.append(emptyState("No users yet"));
      if (this.revealUserId) {
        const created = [...this.elements.adminUsers.querySelectorAll<HTMLDetailsElement>(".admin-user")]
          .find((item) => item.dataset.userId === this.revealUserId);
        if (created) {
          created.open = true;
          created.querySelector<HTMLInputElement>(".admin-issue-key input")?.focus();
        }
        this.revealUserId = undefined;
      }
    } catch (error) {
      this.elements.adminUsers.replaceChildren(emptyState(`Users unavailable: ${this.options.errorMessage(error)}`));
    }
  }

  async loadAdvanced(): Promise<void> {
    if (!this.options.isAdministrator()) return;
    try {
      const [users, policies, audit, diagnostics, trash, snapshots, toolActions, storage] = await Promise.all([
        this.options.api("/api/v1/management/users"),
        this.options.api("/api/v1/management/tool-policies"),
        this.options.api("/api/v1/management/audit-events?limit=50"),
        this.options.api("/api/v1/management/diagnostics"),
        this.options.api("/api/v1/management/trash"),
        this.options.api("/api/v1/management/snapshots"),
        this.options.api("/api/v1/management/tool-actions?limit=100"),
        this.options.api("/api/v1/management/storage").catch((error) => ({ data: { error: this.options.errorMessage(error), report: {}, backups: [], available: false } })),
      ]);
      this.users = users.data ?? [];
      this.policies = policies.data ?? [];
      this.renderToolPolicySubjects();
      this.renderToolPolicies();
      this.renderAdminAuditEvents(audit.data ?? []);
      this.safetyRecovery.renderTrash(trash.data ?? []);
      this.safetyRecovery.renderSnapshots(snapshots.data ?? []);
      this.safetyRecovery.renderToolActions(toolActions.data ?? []);
      this.diagnostics.render(diagnostics);
      this.storageDurability.render(storage.data ?? {});
    } catch (error) {
      this.options.showStatus(`Advanced administration unavailable: ${this.options.errorMessage(error)}`, "error");
    }
  }

  private bind(): void {
    this.elements.createUserForm.addEventListener("submit", (event) => { event.preventDefault(); void this.createAdminUser(); });
    this.elements.toolPolicySubjectType.addEventListener("change", () => this.renderToolPolicySubjects());
    this.elements.toolPolicyForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveToolPolicy(); });
  }

  private async createAdminUser(): Promise<void> {
    setFormBusy(this.elements.createUserForm, true);
    try {
      const response = await this.options.api("/api/v1/management/hosting/users", "POST", {
        displayName: this.elements.createUserName.value.trim(),
      });
      this.revealUserId = typeof response.data?.user?.id === "string" ? response.data.user.id : undefined;
      this.elements.createUserName.value = "";
      await this.loadUsers();
      this.options.showStatus("User added. Add API keys from their user row.", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    finally { setFormBusy(this.elements.createUserForm, false); }
  }

  private renderAdminUser(access: Json): HTMLElement {
    const user = access.user as Json;
    const activeDevices = (access.devices ?? []).length;
    const details = document.createElement("details");
    details.className = "admin-user";
    details.dataset.userId = user.id;

    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "admin-user-title";
    title.append(
      Object.assign(document.createElement("strong"), { textContent: user.displayName }),
      Object.assign(document.createElement("small"), { textContent: `${activeDevices} active API key${activeDevices === 1 ? "" : "s"}` }),
    );
    const role = document.createElement("select");
    role.setAttribute("aria-label", `Role for ${user.displayName}`);
    for (const value of ["consumer", "agent", "administrator"]) {
      role.add(new Option(value[0]!.toUpperCase() + value.slice(1), value));
    }
    role.value = user.role;
    role.disabled = user.id === this.options.currentUserId();
    role.addEventListener("click", (event) => event.stopPropagation());
    role.addEventListener("change", () => void this.updateAdminUser(user.id, { role: role.value }));
    const status = document.createElement("span");
    status.className = "admin-user-status";
    status.textContent = user.id === this.options.currentUserId() ? "Current user" : user.status;
    summary.append(title, role, status);

    const body = document.createElement("div");
    body.className = "admin-user-body";
    const mediaHeading = document.createElement("h3");
    mediaHeading.textContent = "Media access";
    const mediaRoutes = document.createElement("div");
    mediaRoutes.className = "admin-access admin-media-access";
    for (const route of MEDIA_ACCESS_ROUTES) {
      const label = document.createElement("label");
      label.className = "admin-media-route";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.mediaRoute = route.id;
      input.checked = (access.routeIds ?? []).includes(route.id);
      label.append(input, document.createTextNode(route.label));
      mediaRoutes.append(label);
    }

    const quotaHeading = document.createElement("h3");
    quotaHeading.textContent = "Quotas";
    quotaHeading.title = "Queue depth is the maximum number of requests from this user that may be waiting or running at once.";
    const quota = document.createElement("div");
    quota.className = "admin-access";
    const quotaFields = [
      ["maxRequestsPerMinute", "Requests / minute"],
      ["maxPromptChars", "Prompt characters"],
      ["maxOutputTokens", "Output tokens"],
      ["maxQueueDepth", "Queue depth (waiting + running)"],
    ];
    for (const [key, labelText] of quotaFields) {
      const label = document.createElement("label");
      label.textContent = labelText!;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.value = String(access.quota?.[key!] ?? 1);
      input.dataset.quota = key!;
      label.append(input);
      quota.append(label);
    }

    const devicesHeading = document.createElement("h3");
    devicesHeading.textContent = "API keys";
    const devices = document.createElement("div");
    devices.className = "admin-devices";
    const deviceRecords = access.devices ?? [];
    for (const device of deviceRecords) {
      const item = document.createElement("span");
      item.className = "admin-device";
      const current = device.id === access.currentDeviceId;
      item.append(Object.assign(document.createElement("span"), {
        textContent: `${device.name}${current ? " · current" : ""}`,
      }));
      if (!current) {
        const rotate = document.createElement("button");
        rotate.type = "button";
        rotate.className = "admin-device-action";
        rotate.setAttribute("aria-label", `Rotate ${device.name} API key`);
        rotate.title = "Rotate API key";
        rotate.textContent = "↻";
        const rotatedKey = document.createElement("span");
        rotatedKey.className = "admin-api-key-result";
        rotatedKey.hidden = true;
        rotate.addEventListener("click", () => void this.rotateAdminDevice(device.id, rotatedKey));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "admin-device-action danger";
        remove.setAttribute("aria-label", `Delete ${device.name} API key`);
        remove.title = "Delete API key";
        remove.textContent = "×";
        remove.addEventListener("click", () => void this.deleteAdminDevice(device.id));
        item.append(rotate, remove, rotatedKey);
      }
      devices.append(item);
    }
    if (!deviceRecords.length) devices.append(emptyState("No API keys"));

    const issueKey = document.createElement("form");
    issueKey.className = "admin-issue-key";
    const keyName = document.createElement("input");
    keyName.required = true;
    keyName.maxLength = 100;
    keyName.placeholder = "Device or API client name";
    keyName.setAttribute("aria-label", `New API key name for ${user.displayName}`);
    const issue = document.createElement("button");
    issue.type = "submit";
    issue.textContent = "Issue API key";
    const keyResult = document.createElement("div");
    keyResult.className = "admin-api-key-result";
    keyResult.hidden = true;
    issueKey.append(keyName, issue);
    issueKey.addEventListener("submit", (event) => { event.preventDefault(); void this.issueAdminDevice(user.id, keyName.value, issueKey, keyResult); });

    const actions = document.createElement("div");
    actions.className = "admin-user-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save access";
    save.addEventListener("click", () => void this.saveAdminAccess(user.id, details, save));
    actions.append(save);
    if (user.id !== this.options.currentUserId()) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = user.status === "active" ? "danger" : "";
      toggle.textContent = user.status === "active" ? "Remove user" : "Restore user";
      toggle.addEventListener("click", () => user.status === "active" ? void this.removeAdminUser(user.id) : void this.updateAdminUser(user.id, { status: "active" }));
      actions.append(toggle);
    }
    body.append(mediaHeading, mediaRoutes, quotaHeading, quota, devicesHeading, devices, issueKey, keyResult, actions);
    details.append(summary, body);
    return details;
  }

  private renderToolPolicySubjects(): void {
    const previous = this.elements.toolPolicySubject.value;
    this.elements.toolPolicySubject.replaceChildren();
    if (this.elements.toolPolicySubjectType.value === "role") {
      for (const role of ["consumer", "agent", "administrator"]) this.elements.toolPolicySubject.add(new Option(role, role));
    } else {
      for (const user of this.users) this.elements.toolPolicySubject.add(new Option(user.displayName, user.id));
    }
    if ([...this.elements.toolPolicySubject.options].some((option) => option.value === previous)) this.elements.toolPolicySubject.value = previous;
  }

  private renderToolPolicies(): void {
    this.elements.toolPolicies.replaceChildren();
    for (const policy of this.policies) {
      const row = document.createElement("div");
      row.className = "tool-policy";
      const subject = policy.subjectType === "user"
        ? this.users.find((user) => user.id === policy.subjectId)?.displayName ?? policy.subjectId
        : policy.subjectId;
      row.append(
        Object.assign(document.createElement("strong"), { textContent: policy.toolName }),
        Object.assign(document.createElement("span"), { textContent: `${policy.subjectType}: ${subject}` }),
        Object.assign(document.createElement("em"), { textContent: policy.decision }),
      );
      this.elements.toolPolicies.append(row);
    }
    if (!this.policies.length) this.elements.toolPolicies.append(emptyState("No explicit tool policies"));
  }

  private renderAdminAuditEvents(events: Json[]): void {
    this.elements.adminAuditEvents.replaceChildren();
    for (const event of events) {
      const row = document.createElement("div");
      row.className = "admin-audit-event";
      const actor = this.users.find((user) => user.id === event.actorUserId)?.displayName ?? "System";
      const timestamp = String(event.timestamp ?? "");
      const target = event.targetType ?? "system";
      row.append(
        Object.assign(document.createElement("strong"), { textContent: event.action }),
        Object.assign(document.createElement("span"), { textContent: `${actor} · ${target}${event.targetId ? ` · ${event.targetId}` : ""}` }),
        Object.assign(document.createElement("time"), { textContent: timestamp ? new Date(timestamp).toLocaleString() : "", dateTime: timestamp }),
      );
      this.elements.adminAuditEvents.append(row);
    }
    if (!events.length) this.elements.adminAuditEvents.append(emptyState("No activity yet"));
  }

  private async saveToolPolicy(): Promise<void> {
    setFormBusy(this.elements.toolPolicyForm, true);
    try {
      const subjectType = this.elements.toolPolicySubjectType.value;
      const subjectId = this.elements.toolPolicySubject.value;
      const toolName = this.elements.toolPolicyName.value.trim();
      if (!subjectId) throw new Error("Choose a policy subject");
      await this.options.api(`/api/v1/management/tool-policies/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}/${encodeURIComponent(toolName)}`, "PUT", {
        decision: this.elements.toolPolicyDecision.value,
      });
      this.elements.toolPolicyName.value = "";
      await this.loadAdvanced();
      this.options.showStatus("Tool policy saved", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    finally { setFormBusy(this.elements.toolPolicyForm, false); }
  }

  private async updateAdminUser(userId: string, update: Json): Promise<void> {
    try {
      await this.options.api(`/api/v1/management/users/${userId}`, "PATCH", update);
      await this.loadUsers();
      this.options.showStatus("User updated", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private async deleteAdminDevice(deviceId: string): Promise<void> {
    try {
      await this.options.api(`/api/v1/management/devices/${deviceId}`, "DELETE");
      await this.loadUsers();
      this.options.showStatus("API key deleted", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private async rotateAdminDevice(deviceId: string, result: HTMLElement): Promise<void> {
    try {
      const response = await this.options.api(`/api/v1/management/devices/${deviceId}/rotate`, "POST", {});
      const token = String(response.data?.token ?? "");
      if (!token) throw new Error("The host did not return the rotated API key");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => void this.options.bridge.copyText(token));
      result.replaceChildren(Object.assign(document.createElement("code"), { textContent: token }), copy);
      result.hidden = false;
      this.options.showStatus("API key rotated", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private async removeAdminUser(userId: string): Promise<void> {
    try {
      await this.options.api(`/api/v1/management/users/${userId}`, "DELETE");
      await this.loadUsers();
      this.options.showStatus("User removed and API keys revoked", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private async issueAdminDevice(userId: string, name: string, form: HTMLFormElement, result: HTMLElement): Promise<void> {
    setFormBusy(form, true);
    try {
      const response = await this.options.api(`/api/v1/management/users/${userId}/devices`, "POST", { name: name.trim() });
      const token = String(response.data?.token ?? "");
      if (!token) throw new Error("The host did not return the one-time API key");
      const value = Object.assign(document.createElement("code"), { textContent: token });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => void this.options.bridge.copyText(token));
      result.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Copy this key now. Fitz cannot show it again." }), value, copy);
      result.hidden = false;
      const input = form.querySelector("input") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    finally { setFormBusy(form, false); }
  }

  private async saveAdminAccess(userId: string, card: HTMLElement, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const quota: Json = {};
      for (const input of card.querySelectorAll<HTMLInputElement>("[data-quota]")) quota[input.dataset.quota!] = Number(input.value);
      const routeIds = [...card.querySelectorAll<HTMLInputElement>("[data-media-route]")]
        .filter((input) => input.checked)
        .map((input) => input.dataset.mediaRoute!);
      await Promise.all([
        this.options.api(`/api/v1/management/users/${userId}/routes`, "PUT", { routeIds }),
        this.options.api(`/api/v1/management/users/${userId}/quota`, "PUT", quota),
      ]);
      this.options.showStatus("Access saved", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    finally { button.disabled = false; }
  }
}

function emptyState(message: string): HTMLElement {
  return textBlock("panel-empty", message);
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}
