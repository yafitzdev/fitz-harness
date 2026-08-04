import type { DesktopUpdateStatus } from "../../preload.js";
import { FIXED_ROUTES } from "../connections/connection-workspace.js";
import { textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

export type AdministrationPageApi = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface AdministrationPageBridge {
  copyText(text: string): Promise<void>;
  saveDiagnostics(content: string): Promise<string | undefined>;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  updateStatus(): Promise<DesktopUpdateStatus>;
  onUpdateStatus(listener: (update: DesktopUpdateStatus) => void): () => void;
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
  private readonly collapsedSections: Set<string> = this.storedSet("fitz-collapsed-admin-sections");
  private users: Json[] = [];
  private policies: Json[] = [];
  private diagnosticBundle: Json | undefined;
  private pendingRemoteAction: "enable" | "disable" | undefined;
  private pendingStartupAction: "install" | "remove" | undefined;

  constructor(elements: AdministrationPageElements, options: AdministrationPageOptions) {
    this.elements = elements;
    this.options = options;
    this.bind();
    this.applyCollapsedSections();
    this.options.bridge.onUpdateStatus((update) => this.renderDesktopUpdate(update));
    void this.options.bridge
      .updateStatus()
      .then((update) => this.renderDesktopUpdate(update))
      .catch(() => this.renderDesktopUpdate({ state: "error" }));
  }

  showLoading(): void {
    this.elements.adminUsers.replaceChildren(emptyState("Loading users…"));
  }

  async load(): Promise<void> {
    if (!this.options.isAdministrator()) return;
    try {
      const [users, policies, audit, diagnostics, remote, startup] = await Promise.all([
        this.options.api("/api/v1/management/users"),
        this.options.api("/api/v1/management/tool-policies"),
        this.options.api("/api/v1/management/audit-events?limit=50"),
        this.options.api("/api/v1/management/diagnostics"),
        this.options.api("/api/v1/management/connectivity/status"),
        this.options.api("/api/v1/management/startup"),
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
      this.diagnosticBundle = diagnostics;
      this.renderDiagnostics(diagnostics);
      this.renderRemoteAccess(remote.data);
      this.renderHostStartup(startup.data);
    } catch (error) {
      this.elements.adminUsers.replaceChildren(emptyState(`Administration unavailable: ${this.options.errorMessage(error)}`));
    }
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.load());
    for (const toggle of this.elements.sections.querySelectorAll<HTMLButtonElement>(".admin-section-toggle")) {
      toggle.addEventListener("click", () => this.toggleAdminSection(toggle));
    }
    this.elements.pairingCodeForm.addEventListener("submit", (event) => { event.preventDefault(); void this.issuePairingCode(); });
    this.elements.copyPairingCode.addEventListener("click", () => void this.options.bridge.copyText(this.elements.issuedPairingCode.textContent ?? ""));
    this.elements.createUserForm.addEventListener("submit", (event) => { event.preventDefault(); void this.createAdminUser(); });
    this.elements.toolPolicySubjectType.addEventListener("change", () => this.renderToolPolicySubjects());
    this.elements.toolPolicyForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveToolPolicy(); });
    this.elements.exportDiagnostics.addEventListener("click", () => void this.exportDiagnosticBundle());
    this.elements.refreshRemoteAccess.addEventListener("click", () => void this.loadRemoteAccess());
    this.elements.enableRemoteAccess.addEventListener("click", () => this.showRemoteConfirmation("enable"));
    this.elements.disableRemoteAccess.addEventListener("click", () => this.showRemoteConfirmation("disable"));
    this.elements.cancelRemoteAccess.addEventListener("click", () => this.hideRemoteConfirmation());
    this.elements.confirmRemoteAccess.addEventListener("click", () => void this.applyRemoteAccessChange());
    this.elements.refreshHostStartup.addEventListener("click", () => void this.loadHostStartup());
    this.elements.installHostStartup.addEventListener("click", () => this.showStartupConfirmation("install"));
    this.elements.removeHostStartup.addEventListener("click", () => this.showStartupConfirmation("remove"));
    this.elements.cancelHostStartup.addEventListener("click", () => this.hideStartupConfirmation());
    this.elements.confirmHostStartup.addEventListener("click", () => void this.applyStartupChange());
    this.elements.checkDesktopUpdate.addEventListener("click", () => void this.checkForDesktopUpdate());
    this.elements.installDesktopUpdate.addEventListener("click", () => void this.options.bridge.installUpdate());
    this.elements.updateButton.addEventListener("click", () => void this.options.bridge.installUpdate());
  }

  private toggleAdminSection(toggle: HTMLButtonElement): void {
    const key = toggle.dataset.section;
    if (!key) return;
    if (this.collapsedSections.has(key)) this.collapsedSections.delete(key);
    else this.collapsedSections.add(key);
    this.saveSet("fitz-collapsed-admin-sections", this.collapsedSections);
    this.applyAdminSectionState(toggle, key);
  }

  private applyCollapsedSections(): void {
    for (const toggle of this.elements.sections.querySelectorAll<HTMLButtonElement>(".admin-section-toggle")) {
      this.applyAdminSectionState(toggle, toggle.dataset.section ?? "");
    }
  }

  private applyAdminSectionState(toggle: HTMLButtonElement, key: string): void {
    const collapsed = this.collapsedSections.has(key);
    toggle.closest(".admin-section")?.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  private storedSet(key: string): Set<string> {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "[]");
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    } catch { return new Set(); }
  }

  private saveSet(key: string, values: Set<string>): void {
    localStorage.setItem(key, JSON.stringify([...values]));
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

  private renderDiagnostics(diagnostics: Json): void {
    this.elements.diagnosticGeneratedAt.textContent = diagnostics.generatedAt
      ? `Captured ${new Date(diagnostics.generatedAt).toLocaleString()} · values are redacted before leaving the host`
      : "";
    this.elements.diagnosticSummary.replaceChildren();
    const stats = [
      ["Engine", diagnostics.engine?.state ?? "Unknown"],
      ["Queue", String(diagnostics.queueDepth ?? 0)],
      ["Free RAM", diagnosticMib(diagnostics.resources?.freeRamMiB, diagnostics.resources?.totalRamMiB)],
      ["Free VRAM", diagnosticMib(diagnostics.resources?.freeVramMiB, diagnostics.resources?.totalVramMiB)],
    ];
    for (const [label, value] of stats) {
      const stat = document.createElement("div");
      stat.className = "diagnostic-stat";
      stat.append(
        Object.assign(document.createElement("small"), { textContent: label }),
        Object.assign(document.createElement("strong"), { textContent: value }),
      );
      this.elements.diagnosticSummary.append(stat);
    }

    const metricRows: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(diagnostics.metrics?.counters ?? {})) metricRows.push([name, Number(value).toLocaleString()]);
    for (const [name, value] of Object.entries(diagnostics.metrics?.gauges ?? {})) metricRows.push([name, String(value)]);
    for (const [name, value] of Object.entries<Json>(diagnostics.metrics?.timings ?? {})) metricRows.push([name, `${Number(value.averageMs ?? 0).toFixed(1)} ms avg`]);
    renderDiagnosticRows(this.elements.diagnosticMetrics, metricRows, "No metrics recorded yet");

    const failures: Array<[string, string]> = [];
    for (const request of diagnostics.recentRequests ?? []) {
      if (["failed", "interrupted", "cancelled"].includes(request.status)) failures.push([`${request.routeId} · ${request.status}`, request.errorCode ?? request.id]);
    }
    for (const event of diagnostics.recentLifecycleEvents ?? []) {
      if (event.data?.state === "FAILED") failures.push([event.data.recipeId ?? "engine", event.data.reason ?? "Engine failed"]);
    }
    renderDiagnosticRows(this.elements.diagnosticFailures, failures.slice(0, 20), "No recent failures");
  }

  private async exportDiagnosticBundle(): Promise<void> {
    if (!this.diagnosticBundle) return;
    this.elements.exportDiagnostics.disabled = true;
    try {
      const path = await this.options.bridge.saveDiagnostics(JSON.stringify(this.diagnosticBundle, null, 2));
      if (path) this.options.showToast(`Diagnostics saved to ${path}`);
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { this.elements.exportDiagnostics.disabled = false; }
  }

  private async checkForDesktopUpdate(): Promise<void> {
    this.elements.checkDesktopUpdate.disabled = true;
    try { await this.options.bridge.checkForUpdates(); }
    catch { this.renderDesktopUpdate({ state: "error" }); }
    finally {
      if (this.elements.desktopUpdateLabel.dataset.state !== "checking" && this.elements.desktopUpdateLabel.dataset.state !== "downloading") {
        this.elements.checkDesktopUpdate.disabled = false;
      }
    }
  }

  private renderDesktopUpdate(update: DesktopUpdateStatus): void {
    const percent = update.state === "downloaded" ? 100 : Math.max(0, Math.min(100, update.percent ?? 0));
    const labels: Record<DesktopUpdateStatus["state"], string> = {
      idle: "Ready to check",
      checking: "Checking for updates…",
      available: "Update found. Download starting…",
      downloading: `Downloading update · ${Math.round(percent)}%`,
      current: "Fitz is up to date",
      downloaded: "Update ready to install",
      error: "Update check failed",
      development: "Update checks are available in packaged builds",
    };
    this.elements.desktopUpdateLabel.textContent = labels[update.state];
    this.elements.desktopUpdateLabel.dataset.state = update.state;
    this.elements.desktopUpdateVersion.textContent = update.version ? `Version ${update.version}` : "";
    this.elements.desktopUpdateProgress.style.width = `${percent}%`;
    const busy = update.state === "checking" || update.state === "available" || update.state === "downloading";
    this.elements.checkDesktopUpdate.disabled = busy;
    this.elements.installDesktopUpdate.hidden = update.state !== "downloaded";
    this.elements.updateButton.hidden = update.state !== "downloaded";
  }

  private async loadRemoteAccess(): Promise<void> {
    try {
      const response = await this.options.api("/api/v1/management/connectivity/status");
      this.renderRemoteAccess(response.data);
    } catch (error) { this.elements.remoteAccessStatus.replaceChildren(emptyState(`Remote status unavailable: ${this.options.errorMessage(error)}`)); }
  }

  private renderRemoteAccess(remote: Json): void {
    const tailscale = remote.tailscale ?? {};
    const configuration = remote.serve?.configuration;
    const served = remote.serve?.available === true && configuration && Object.keys(configuration).length > 0;
    const values = [
      ["Tailscale", String(tailscale.state ?? "unknown").replaceAll("-", " ")],
      ["Device", tailscale.dnsName ?? tailscale.addresses?.[0] ?? "Not connected"],
      ["Private HTTPS", remote.serve?.available === false ? "Unavailable" : served ? "Enabled" : "Disabled"],
    ];
    this.elements.remoteAccessStatus.replaceChildren();
    for (const [label, value] of values) {
      const card = document.createElement("div");
      card.className = "remote-access-card";
      card.append(
        Object.assign(document.createElement("small"), { textContent: label }),
        Object.assign(document.createElement("strong"), { textContent: value }),
      );
      this.elements.remoteAccessStatus.append(card);
    }
    this.elements.enableRemoteAccess.disabled = tailscale.state !== "connected" || served;
    this.elements.disableRemoteAccess.disabled = !served;
  }

  private showRemoteConfirmation(action: "enable" | "disable"): void {
    this.pendingRemoteAction = action;
    this.elements.remoteAccessConfirmationText.textContent = action === "enable"
      ? "Enable private HTTPS through Tailscale Serve for this Fitz host?"
      : "Disable the private HTTPS route? Remote clients will disconnect.";
    this.elements.confirmRemoteAccess.textContent = action === "enable" ? "Confirm enable" : "Confirm disable";
    this.elements.remoteAccessConfirmation.hidden = false;
  }

  private hideRemoteConfirmation(): void {
    this.pendingRemoteAction = undefined;
    this.elements.remoteAccessConfirmation.hidden = true;
  }

  private async applyRemoteAccessChange(): Promise<void> {
    if (!this.pendingRemoteAction) return;
    const action = this.pendingRemoteAction;
    this.elements.confirmRemoteAccess.disabled = true;
    try {
      if (action === "enable") await this.options.api("/api/v1/management/connectivity/tailscale-serve", "POST", {});
      else await this.options.api("/api/v1/management/connectivity/tailscale-serve", "DELETE");
      this.hideRemoteConfirmation();
      await this.load();
      this.options.showToast(action === "enable" ? "Private HTTPS enabled" : "Private HTTPS disabled");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { this.elements.confirmRemoteAccess.disabled = false; }
  }

  private async loadHostStartup(): Promise<void> {
    try {
      const response = await this.options.api("/api/v1/management/startup");
      this.renderHostStartup(response.data);
    } catch (error) { this.elements.hostStartupStatus.replaceChildren(emptyState(`Startup status unavailable: ${this.options.errorMessage(error)}`)); }
  }

  private renderHostStartup(startup: Json): void {
    this.elements.hostStartupStatus.replaceChildren(
      Object.assign(document.createElement("strong"), { textContent: startup.configured ? "Starts at sign-in" : "Does not start at sign-in" }),
      Object.assign(document.createElement("span"), { textContent: startup.message ?? (startup.available ? "Per-user Windows startup" : "Packaged host launcher unavailable") }),
    );
    this.elements.installHostStartup.disabled = !startup.available || startup.configured;
    this.elements.removeHostStartup.disabled = !startup.configured;
  }

  private showStartupConfirmation(action: "install" | "remove"): void {
    this.pendingStartupAction = action;
    this.elements.hostStartupConfirmationText.textContent = action === "install"
      ? "Start the lightweight Fitz host automatically at Windows sign-in?"
      : "Remove Fitz host from Windows sign-in startup?";
    this.elements.confirmHostStartup.textContent = action === "install" ? "Confirm startup" : "Confirm removal";
    this.elements.hostStartupConfirmation.hidden = false;
  }

  private hideStartupConfirmation(): void {
    this.pendingStartupAction = undefined;
    this.elements.hostStartupConfirmation.hidden = true;
  }

  private async applyStartupChange(): Promise<void> {
    if (!this.pendingStartupAction) return;
    const action = this.pendingStartupAction;
    this.elements.confirmHostStartup.disabled = true;
    try {
      await this.options.api("/api/v1/management/startup", action === "install" ? "POST" : "DELETE", action === "install" ? {} : undefined);
      this.hideStartupConfirmation();
      await this.load();
      this.options.showToast(action === "install" ? "Host will start at sign-in" : "Host startup removed");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { this.elements.confirmHostStartup.disabled = false; }
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

function renderDiagnosticRows(container: HTMLElement, rows: Array<[string, string]>, empty: string): void {
  container.replaceChildren();
  for (const [name, value] of rows) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    row.append(
      Object.assign(document.createElement("span"), { textContent: name }),
      Object.assign(document.createElement("strong"), { textContent: value }),
    );
    container.append(row);
  }
  if (!rows.length) container.append(emptyState(empty));
}

function diagnosticMib(free: unknown, total: unknown): string {
  if (!Number.isFinite(Number(free)) || !Number.isFinite(Number(total))) return "Unavailable";
  return `${Math.round(Number(free)).toLocaleString()} / ${Math.round(Number(total)).toLocaleString()} MiB`;
}

function emptyState(message: string): HTMLElement {
  return textBlock("panel-empty", message);
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}
