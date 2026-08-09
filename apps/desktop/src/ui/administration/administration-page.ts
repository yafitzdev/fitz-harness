import { FIXED_ROUTES } from "../connections/connection-workspace.js";
import { CollapsibleSection } from "../layout/collapsible-section.js";
import { createCopyButton } from "../primitives/copy-button.js";
import { textBlock } from "../primitives/dom.js";
import { DesktopUpdateController, type DesktopUpdateBridge } from "./desktop-update-controller.js";
import { DiagnosticsController, type DiagnosticsBridge } from "./diagnostics-controller.js";
import { HostLifecycleController } from "./host-lifecycle-controller.js";
import { SafetyRecoveryController } from "./safety-recovery-controller.js";

type Json = Record<string, any>;

export type AdministrationPageApi = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface AdministrationPageBridge extends DesktopUpdateBridge, DiagnosticsBridge {
  copyText(text: string): Promise<void>;
}

export interface AdministrationPageElements {
  refresh: HTMLButtonElement;
  /** Root that owns every collapsible admin section; toggles are resolved from it. */
  sections: HTMLElement;
  refreshRemoteAccess: HTMLButtonElement;
  cancelRemoteAccess: HTMLButtonElement;
  refreshHostStartup: HTMLButtonElement;
  cancelHostStartup: HTMLButtonElement;
  pairingCodeForm: HTMLFormElement;
  pairingCodeRole: HTMLSelectElement;
  pairingCodeTtl: HTMLSelectElement;
  pairingCodeResult: HTMLElement;
  issuedPairingCode: HTMLElement;
  issuedPairingExpiry: HTMLElement;
  copyPairingCode: HTMLButtonElement;
  createUserForm: HTMLFormElement;
  createUserName: HTMLInputElement;
  createUserRole: HTMLSelectElement;
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
  exportDiagnostics: HTMLButtonElement;
  remoteAccessStatus: HTMLElement;
  remoteAccessConfirmation: HTMLElement;
  remoteAccessConfirmationText: HTMLElement;
  enableRemoteAccess: HTMLButtonElement;
  disableRemoteAccess: HTMLButtonElement;
  confirmRemoteAccess: HTMLButtonElement;
  hostStartupStatus: HTMLElement;
  hostStartupConfirmation: HTMLElement;
  hostStartupConfirmationText: HTMLElement;
  installHostStartup: HTMLButtonElement;
  removeHostStartup: HTMLButtonElement;
  confirmHostStartup: HTMLButtonElement;
  checkDesktopUpdate: HTMLButtonElement;
  installDesktopUpdate: HTMLButtonElement;
  desktopUpdateLabel: HTMLElement;
  desktopUpdateVersion: HTMLElement;
  desktopUpdateProgress: HTMLElement;
  updateButton: HTMLButtonElement;
}

export interface AdministrationPageOptions {
  api: AdministrationPageApi;
  bridge: AdministrationPageBridge;
  isAdministrator: () => boolean;
  currentUserId: () => string | undefined;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

export class AdministrationPageController {
  readonly elements: AdministrationPageElements;
  private readonly options: AdministrationPageOptions;
  private users: Json[] = [];
  private policies: Json[] = [];
  private readonly hostLifecycle: HostLifecycleController;
  private readonly diagnostics: DiagnosticsController;
  private readonly safetyRecovery: SafetyRecoveryController;

  constructor(elements: AdministrationPageElements, options: AdministrationPageOptions) {
    this.elements = elements;
    this.options = options;
    CollapsibleSection.adoptAll(this.elements.sections, { storageKey: "fitz-collapsed-admin-sections" });
    this.hostLifecycle = new HostLifecycleController({
      refreshRemote: elements.refreshRemoteAccess,
      cancelRemote: elements.cancelRemoteAccess,
      remoteStatus: elements.remoteAccessStatus,
      remoteConfirmation: elements.remoteAccessConfirmation,
      remoteConfirmationText: elements.remoteAccessConfirmationText,
      enableRemote: elements.enableRemoteAccess,
      disableRemote: elements.disableRemoteAccess,
      confirmRemote: elements.confirmRemoteAccess,
      refreshStartup: elements.refreshHostStartup,
      cancelStartup: elements.cancelHostStartup,
      startupStatus: elements.hostStartupStatus,
      startupConfirmation: elements.hostStartupConfirmation,
      startupConfirmationText: elements.hostStartupConfirmationText,
      installStartup: elements.installHostStartup,
      removeStartup: elements.removeHostStartup,
      confirmStartup: elements.confirmHostStartup,
    }, {
      api: options.api,
      reload: () => this.load(),
      showToast: options.showToast,
      errorMessage: options.errorMessage,
    });
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
      exportButton: elements.exportDiagnostics,
    }, {
      bridge: options.bridge,
      showToast: options.showToast,
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
      reload: () => this.load(),
      showToast: options.showToast,
      errorMessage: options.errorMessage,
    });
    this.bind();
  }

  showLoading(): void {
    this.elements.adminUsers.replaceChildren(emptyState("Loading users…"));
  }

  async load(): Promise<void> {
    if (!this.options.isAdministrator()) return;
    try {
      const [users, policies, audit, diagnostics, remote, startup, trash, snapshots, toolActions] = await Promise.all([
        this.options.api("/api/v1/management/users"),
        this.options.api("/api/v1/management/tool-policies"),
        this.options.api("/api/v1/management/audit-events?limit=50"),
        this.options.api("/api/v1/management/diagnostics"),
        this.options.api("/api/v1/management/connectivity/status"),
        this.options.api("/api/v1/management/startup"),
        this.options.api("/api/v1/management/trash"),
        this.options.api("/api/v1/management/snapshots"),
        this.options.api("/api/v1/management/tool-actions?limit=100"),
      ]);
      this.users = users.data ?? [];
      this.policies = policies.data ?? [];
      const access = await Promise.all(this.users.map((user) =>
        this.options.api(`/api/v1/management/users/${user.id}/access`).then((response) => response.data),
      ));
      this.elements.adminUsers.replaceChildren(...access.map((entry) => this.renderAdminUser(entry)));
      if (!access.length) this.elements.adminUsers.append(emptyState("No users yet"));
      this.renderToolPolicySubjects();
      this.renderToolPolicies();
      this.renderAdminAuditEvents(audit.data ?? []);
      this.safetyRecovery.renderTrash(trash.data ?? []);
      this.safetyRecovery.renderSnapshots(snapshots.data ?? []);
      this.safetyRecovery.renderToolActions(toolActions.data ?? []);
      this.diagnostics.render(diagnostics);
      this.hostLifecycle.renderRemote(remote.data);
      this.hostLifecycle.renderStartup(startup.data);
    } catch (error) {
      this.elements.adminUsers.replaceChildren(emptyState(`Administration unavailable: ${this.options.errorMessage(error)}`));
    }
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.load());
    this.elements.pairingCodeForm.addEventListener("submit", (event) => { event.preventDefault(); void this.issuePairingCode(); });
    const copyPairingCode = createCopyButton({
      copyText: (text) => void this.options.bridge.copyText(text),
      value: () => this.elements.issuedPairingCode.textContent ?? "",
      title: "Copy pairing code",
      className: "pairing-code-copy",
      text: true,
    });
    copyPairingCode.id = "copy-pairing-code";
    this.elements.copyPairingCode.replaceWith(copyPairingCode);
    this.elements.copyPairingCode = copyPairingCode;
    this.elements.createUserForm.addEventListener("submit", (event) => { event.preventDefault(); void this.createAdminUser(); });
    this.elements.toolPolicySubjectType.addEventListener("change", () => this.renderToolPolicySubjects());
    this.elements.toolPolicyForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveToolPolicy(); });
  }

  private async issuePairingCode(): Promise<void> {
    setFormBusy(this.elements.pairingCodeForm, true);
    try {
      const response = await this.options.api("/api/v1/management/pairing-codes", "POST", {
        intendedRole: this.elements.pairingCodeRole.value,
        ttlSeconds: Number(this.elements.pairingCodeTtl.value),
      });
      this.elements.issuedPairingCode.textContent = response.data.code;
      this.elements.issuedPairingExpiry.textContent = `Expires ${new Date(response.data.expiresAt).toLocaleString()}`;
      this.elements.pairingCodeResult.hidden = false;
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.pairingCodeForm, false); }
  }

  private async createAdminUser(): Promise<void> {
    setFormBusy(this.elements.createUserForm, true);
    try {
      await this.options.api("/api/v1/management/users", "POST", {
        displayName: this.elements.createUserName.value.trim(),
        role: this.elements.createUserRole.value,
      });
      this.elements.createUserName.value = "";
      await this.load();
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.createUserForm, false); }
  }

  private renderAdminUser(access: Json): HTMLElement {
    const user = access.user as Json;
    const activeDevices = (access.devices ?? []).filter((device: Json) => !device.revokedAt).length;
    const details = document.createElement("details");
    details.className = "admin-user";

    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "admin-user-title";
    title.append(
      Object.assign(document.createElement("strong"), { textContent: user.displayName }),
      Object.assign(document.createElement("small"), { textContent: `${activeDevices} active device${activeDevices === 1 ? "" : "s"}` }),
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
    const routesHeading = document.createElement("h3");
    routesHeading.textContent = "Routes";
    const routeList = document.createElement("div");
    routeList.className = "admin-routes";
    for (const route of FIXED_ROUTES) {
      const label = document.createElement("label");
      label.className = "admin-route";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = route.id;
      input.checked = user.role === "administrator" || (access.routeIds ?? []).includes(route.id);
      input.disabled = user.role === "administrator";
      label.append(input, route.label);
      routeList.append(label);
    }

    const quotaHeading = document.createElement("h3");
    quotaHeading.textContent = "Quotas";
    const quota = document.createElement("div");
    quota.className = "admin-access";
    const quotaFields = [
      ["maxRequestsPerMinute", "Requests / minute"],
      ["maxPromptChars", "Prompt characters"],
      ["maxOutputTokens", "Output tokens"],
      ["maxQueueDepth", "Queue depth"],
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
    devicesHeading.textContent = "Devices";
    const devices = document.createElement("div");
    devices.className = "admin-devices";
    for (const device of access.devices ?? []) {
      const item = document.createElement("span");
      item.className = "admin-device";
      const current = device.id === access.currentDeviceId;
      item.append(Object.assign(document.createElement("span"), {
        textContent: `${device.name}${current ? " · current" : ""}${device.revokedAt ? " · revoked" : ""}`,
      }));
      if (!device.revokedAt && !current) {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.title = `Revoke ${device.name}`;
        revoke.setAttribute("aria-label", revoke.title);
        revoke.textContent = "×";
        revoke.addEventListener("click", () => void this.revokeAdminDevice(device.id));
        item.append(revoke);
      }
      devices.append(item);
    }
    if (!(access.devices ?? []).length) devices.append(emptyState("No devices"));

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
      toggle.textContent = user.status === "active" ? "Disable user" : "Enable user";
      toggle.addEventListener("click", () => void this.updateAdminUser(user.id, { status: user.status === "active" ? "disabled" : "active" }));
      actions.append(toggle);
    }
    body.append(routesHeading, routeList, quotaHeading, quota, devicesHeading, devices, actions);
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
      await this.load();
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.toolPolicyForm, false); }
  }

  private async updateAdminUser(userId: string, update: Json): Promise<void> {
    try {
      await this.options.api(`/api/v1/management/users/${userId}`, "PATCH", update);
      await this.load();
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }

  private async revokeAdminDevice(deviceId: string): Promise<void> {
    try {
      await this.options.api(`/api/v1/management/devices/${deviceId}`, "DELETE");
      await this.load();
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }

  private async saveAdminAccess(userId: string, card: HTMLElement, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const routeIds = [...card.querySelectorAll<HTMLInputElement>(".admin-route input:checked")].map((input) => input.value);
      const quota: Json = {};
      for (const input of card.querySelectorAll<HTMLInputElement>("[data-quota]")) quota[input.dataset.quota!] = Number(input.value);
      await Promise.all([
        this.options.api(`/api/v1/management/users/${userId}/routes`, "PUT", { routeIds }),
        this.options.api(`/api/v1/management/users/${userId}/quota`, "PUT", quota),
      ]);
      this.options.showToast("Access saved");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { button.disabled = false; }
  }
}

function emptyState(message: string): HTMLElement {
  return textBlock("panel-empty", message);
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}
