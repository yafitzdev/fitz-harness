// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdministrationPageController, type AdministrationPageApi, type AdministrationPageBridge, type AdministrationPageElements } from "./administration-page.js";

// happy-dom does not ship the global `Option` constructor used by the page for
// role/subject selects; polyfill it with real option elements so select.add()
// and value binding behave like the browser.
if (typeof globalThis.Option === "undefined") {
  (globalThis as any).Option = function Option(this: HTMLOptionElement, text = "", value?: string, defaultSelected = false, selected = false) {
    const option = document.createElement("option");
    option.text = text;
    if (value !== undefined) option.value = value;
    option.defaultSelected = defaultSelected;
    option.selected = selected;
    return option;
  };
}

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

// Populate a select with <option> elements whose text and value are `value`,
// mirroring the static markup in renderer/index.html so that setting
// `select.value` behaves like it does in the real page.
function selectOptions(select: HTMLSelectElement, values: string[]): void {
  for (const value of values) select.add(new Option(value, value));
}

type Json = Record<string, any>;

const userAda = { id: "user-1", displayName: "Ada", role: "administrator", status: "active" };
const userGrace = { id: "user-2", displayName: "Grace", role: "consumer", status: "active" };

function adminApi() {
  const access = (id: string) => ({
    data: {
      user: id === "user-1" ? userAda : userGrace,
      devices: id === "user-2"
        ? [{ id: "device-8", name: "Old laptop", revokedAt: null }, { id: "device-9", name: "Laptop", revokedAt: null }]
        : [],
      currentDeviceId: "device-9",
      routeIds: ["default"],
      quota: { maxRequestsPerMinute: 60, maxPromptChars: 4000, maxOutputTokens: 2000, maxQueueDepth: 2 },
    },
  });
  const routes: Record<string, Json> = {
    "/api/v1/management/users": { data: [userAda, userGrace] },
    "/api/v1/management/tool-policies": { data: [{ subjectType: "role", subjectId: "agent", toolName: "bash", decision: "ask" }] },
    "/api/v1/management/audit-events?limit=50": { data: [{ action: "user.created", actorUserId: "user-1", targetType: "user", targetId: "user-2", timestamp: "2026-08-04T10:00:00Z" }] },
    // The host returns the diagnostics bundle unwrapped (no `data` key), unlike
    // the other management endpoints.
    "/api/v1/management/diagnostics": {
      generatedAt: "2026-08-04T10:00:00Z",
      engine: { state: "LOADED" },
      queueDepth: 2,
      resources: { freeRamMiB: 8192, totalRamMiB: 16384, freeVramMiB: 0, totalVramMiB: 0 },
      metrics: { counters: { requests: 12 }, gauges: {}, timings: {} },
      recentRequests: [{ routeId: "default", status: "failed", errorCode: "E001", id: "run-1" }],
      recentLifecycleEvents: [],
    },
    "/api/v1/management/connectivity/status": { data: {
      tailscale: { state: "connected", dnsName: "host.tailnet.ts.net" },
      serve: { available: true, configuration: { "https://host": {} } },
    } },
    "/api/v1/management/startup": { data: { configured: true, available: true, message: "Per-user Windows startup" } },
    "/api/v1/management/trash": { data: [
      { id: "trash-1", runId: "run-1", workspaceRoot: "C:\\workspace", originalPath: "C:\\workspace\\notes.md", trashPath: "C:\\workspace\\.fitz-trash\\run-1\\1-notes.md", createdAt: "2026-08-04T09:00:00Z" },
      { id: "trash-2", runId: "run-2", workspaceRoot: "C:\\workspace", originalPath: "C:\\workspace\\old.log", trashPath: "C:\\workspace\\.fitz-trash\\run-2\\1-old.log", createdAt: "2026-07-01T09:00:00Z", restoredAt: "2026-07-02T09:00:00Z" },
    ] },
    "/api/v1/management/snapshots": { data: [
      { runId: "run-1", workspaceRoot: "C:\\workspace", snapshotDir: "C:\\data\\snapshots\\run-1", createdAt: "2026-08-04T09:00:00Z", status: "active", fileCount: 42 },
      { runId: "run-3", workspaceRoot: "C:\\workspace", snapshotDir: "C:\\data\\snapshots\\run-3", createdAt: "2026-08-03T09:00:00Z", status: "restored", fileCount: 7 },
    ] },
    "/api/v1/management/tool-actions?limit=100": { data: [
      { runId: "run-1", sequence: 1, timestamp: "2026-08-04T09:00:01Z", toolName: "bash", effect: "rewrite", path: "C:\\workspace\\notes.md", detail: {} },
      { runId: "run-1", sequence: 2, timestamp: "2026-08-04T09:00:02Z", toolName: "read", effect: "allow", detail: {} },
    ] },
    "/api/v1/management/pairing-codes": { data: { code: "ABCD-EFGH", expiresAt: "2026-08-04T11:00:00Z" } },
    "/api/v1/management/storage": { data: { report: { artifacts: 2, objects: 1, referencedBytes: 1024, orphanObjects: 0, orphanBytes: 0, issues: [] }, backups: [], available: true } },
  };
  const api = vi.fn(async (path: string) => {
    if (path.startsWith("/api/v1/management/users/") && path.endsWith("/access")) return access(path.split("/")[5]!);
    return routes[path] ?? { data: {} };
  });
  return api;
}

function setup(
  api: AdministrationPageApi = adminApi(),
  options: Partial<{ isAdministrator: () => boolean; currentUserId: () => string | undefined }> = {},
  bridgeOverrides: Partial<AdministrationPageBridge> = {},
) {
  const elements: AdministrationPageElements = {
    refresh: node("button"), sections: node("div"), refreshRemoteAccess: node("button"), cancelRemoteAccess: node("button"), refreshHostStartup: node("button"), cancelHostStartup: node("button"),
    pairingCodeForm: node("form"), pairingCodeRole: node("select"), pairingCodeTtl: node("select"), pairingCodeResult: node("div"),
    issuedPairingCode: node("strong"), issuedPairingExpiry: node("span"), copyPairingCode: node("button"),
    createUserForm: node("form"), createUserName: node("input"), createUserRole: node("select"), adminUsers: node("div"),
    toolPolicyForm: node("form"), toolPolicySubjectType: node("select"), toolPolicySubject: node("select"), toolPolicyName: node("input"), toolPolicyDecision: node("select"), toolPolicies: node("div"),
    adminAuditEvents: node("div"), diagnosticGeneratedAt: node("p"), diagnosticSummary: node("div"), diagnosticMetrics: node("div"), diagnosticFailures: node("div"), diagnosticExportStatus: node("p"), exportDiagnostics: node("button"),
    adminTrash: node("div"), adminSnapshots: node("div"), adminToolActions: node("div"),
    emptyTrashButton: node("button"), gcRetentionButton: node("button"),
    emptyTrashConfirmation: node("div"), emptyTrashConfirmationText: node("span"), cancelEmptyTrash: node("button"), confirmEmptyTrash: node("button"),
    remoteAccessStatus: node("div"), remoteAccessConfirmation: node("div"), remoteAccessConfirmationText: node("span"),
    enableRemoteAccess: node("button"), disableRemoteAccess: node("button"), confirmRemoteAccess: node("button"),
    hostStartupStatus: node("div"), hostStartupConfirmation: node("div"), hostStartupConfirmationText: node("span"),
    installHostStartup: node("button"), removeHostStartup: node("button"), confirmHostStartup: node("button"),
    checkDesktopUpdate: node("button"), installDesktopUpdate: node("button"), desktopUpdateLabel: node("span"), desktopUpdateVersion: node("span"), desktopUpdateProgress: node("span"), updateButton: node("button"),
    storageSummary: node("div"), storageIssues: node("div"), storageBackups: node("div"), storageQuota: node("input"),
    verifyStorage: node("button"), collectStorageGarbage: node("button"), createStorageBackup: node("button"), saveStorageQuota: node("button"),
    storageRestoreConfirmation: node("div"), storageRestoreConfirmationText: node("span"), cancelStorageRestore: node("button"), confirmStorageRestore: node("button"),
  };
  elements.pairingCodeResult.hidden = true;
  elements.remoteAccessConfirmation.hidden = true;
  elements.hostStartupConfirmation.hidden = true;
  elements.installDesktopUpdate.hidden = true;
  elements.updateButton.hidden = true;
  elements.storageRestoreConfirmation.hidden = true;
  selectOptions(elements.pairingCodeRole, ["consumer", "agent", "administrator"]);
  selectOptions(elements.pairingCodeTtl, ["600", "3600", "86400"]);
  selectOptions(elements.createUserRole, ["consumer", "agent", "administrator"]);
  selectOptions(elements.toolPolicySubjectType, ["role", "user"]);
  selectOptions(elements.toolPolicyDecision, ["ask", "allow", "deny"]);
  const bridge = {
    copyText: vi.fn(async () => undefined),
    saveDiagnostics: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => ({ state: "idle" as const })),
    onUpdateStatus: vi.fn(() => () => undefined),
    ...bridgeOverrides,
  };
  const showStatus = vi.fn();
  const controller = new AdministrationPageController(elements, {
    api,
    bridge,
    isAdministrator: options.isAdministrator ?? (() => true),
    currentUserId: options.currentUserId ?? (() => "user-1"),
    showStatus,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  });
  return { controller, elements, bridge, showStatus, api };
}

function submit(form: HTMLFormElement): void { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  } as Storage;
}

beforeEach(() => {
  // happy-dom ships an empty localStorage stub without working methods; install a real one.
  globalThis.localStorage = memoryStorage();
  document.body.replaceChildren();
});
afterEach(() => vi.useRealTimers());

describe("AdministrationPageController", () => {
  it("loads users, policies, audit events, diagnostics, remote access, and startup", async () => {
    const { controller, elements, api } = setup();
    await controller.load();

    expect(api).toHaveBeenCalledWith("/api/v1/management/users");
    expect(api).toHaveBeenCalledWith("/api/v1/management/tool-policies");
    expect(api).toHaveBeenCalledWith("/api/v1/management/audit-events?limit=50");
    expect(api).toHaveBeenCalledWith("/api/v1/management/diagnostics");
    expect(api).toHaveBeenCalledWith("/api/v1/management/connectivity/status");
    expect(api).toHaveBeenCalledWith("/api/v1/management/startup");
    expect(api).toHaveBeenCalledWith("/api/v1/management/trash");
    expect(api).toHaveBeenCalledWith("/api/v1/management/snapshots");
    expect(api).toHaveBeenCalledWith("/api/v1/management/tool-actions?limit=100");
    expect(api).toHaveBeenCalledWith("/api/v1/management/storage");

    const users = elements.adminUsers.querySelectorAll(".admin-user");
    expect(users).toHaveLength(2);
    expect(users[1]!.querySelector(".admin-user-title strong")?.textContent).toBe("Grace");
    expect(users[1]!.querySelector(".admin-route input")).not.toBeNull();
    // The current user's role cannot be changed; others can.
    expect((users[0]!.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    expect((users[1]!.querySelector("select") as HTMLSelectElement).disabled).toBe(false);

    expect(elements.toolPolicies.textContent).toContain("bash");
    expect(elements.toolPolicies.textContent).toContain("role: agent");
    expect(elements.adminAuditEvents.textContent).toContain("user.created");
    expect(elements.adminAuditEvents.textContent).toContain("Ada");

    expect(elements.diagnosticSummary.querySelectorAll(".diagnostic-stat")).toHaveLength(4);
    expect(elements.diagnosticSummary.textContent).toContain("LOADED");
    expect(elements.diagnosticFailures.textContent).toContain("E001");
    expect(elements.diagnosticMetrics.textContent).toContain("requests");

    expect(elements.remoteAccessStatus.querySelectorAll(".remote-access-card")).toHaveLength(3);
    expect(elements.remoteAccessStatus.textContent).toContain("host.tailnet.ts.net");
    expect(elements.enableRemoteAccess.disabled).toBe(true);
    expect(elements.disableRemoteAccess.disabled).toBe(false);

    expect(elements.hostStartupStatus.textContent).toContain("Starts at sign-in");
    expect(elements.installHostStartup.disabled).toBe(true);
    expect(elements.removeHostStartup.disabled).toBe(false);

    // Safety & recovery: trash entries (restorable ones get a button), snapshots, audit.
    expect(elements.adminTrash.querySelectorAll(".admin-safety-row")).toHaveLength(2);
    expect(elements.adminTrash.textContent).toContain("notes.md");
    expect(elements.adminTrash.textContent).toContain("restored");
    expect(elements.adminSnapshots.textContent).toContain("run-1");
    expect(elements.adminSnapshots.querySelectorAll("button")).toHaveLength(1); // only the active snapshot restores
    expect(elements.adminToolActions.textContent).toContain("bash · rewrite");
    expect(elements.adminToolActions.textContent).toContain("read · allow");
  });

  it("skips loading when the caller is not an administrator", async () => {
    const api = vi.fn(async () => ({ data: {} }));
    const { controller, elements } = setup(api, { isAdministrator: () => false });
    await controller.load();
    expect(api).not.toHaveBeenCalled();
    expect(elements.adminUsers.childElementCount).toBe(0);
  });

  it("issues a pairing code, copies it, and refreshes from the page header", async () => {
    const { controller, elements, bridge } = setup();
    elements.pairingCodeRole.value = "agent";
    elements.pairingCodeTtl.value = "3600";
    submit(elements.pairingCodeForm);
    await vi.waitFor(() => expect(elements.pairingCodeResult.hidden).toBe(false));
    expect(elements.issuedPairingCode.textContent).toBe("ABCD-EFGH");
    expect(elements.issuedPairingExpiry.textContent).toContain("Expires");

    click(elements.copyPairingCode);
    await vi.waitFor(() => expect(bridge.copyText).toHaveBeenCalledWith("ABCD-EFGH"));

    controller.showLoading();
    expect(elements.adminUsers.textContent).toContain("Loading users");
    click(elements.refresh);
    await vi.waitFor(() => expect(elements.adminUsers.querySelectorAll(".admin-user")).toHaveLength(2));
  });

  it("creates a user and saves tool policies and access updates", async () => {
    const { controller, elements, api, showStatus } = setup();
    await controller.load();

    elements.createUserName.value = "Linus";
    elements.createUserRole.value = "agent";
    submit(elements.createUserForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users", "POST", { displayName: "Linus", role: "agent" }));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("User created", "success"));

    elements.toolPolicySubjectType.value = "user";
    elements.toolPolicySubjectType.dispatchEvent(new Event("change", { bubbles: true }));
    elements.toolPolicySubject.value = "user-2";
    elements.toolPolicyName.value = "edit";
    elements.toolPolicyDecision.value = "deny";
    submit(elements.toolPolicyForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/tool-policies/user/user-2/edit", "PUT", { decision: "deny" }));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("Tool policy saved", "success"));

    // Change a consumer's role and save their route + quota access.
    const card = elements.adminUsers.querySelectorAll(".admin-user")[1] as HTMLElement;
    const role = card.querySelector("select") as HTMLSelectElement;
    role.value = "agent";
    role.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2", "PATCH", { role: "agent" }));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("User updated", "success"));

    (card.querySelector(".admin-route input") as HTMLInputElement).checked = true;
    click(card.querySelector(".admin-user-actions button")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2/routes", "PUT", { routeIds: ["fast", "default"] }));
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2/quota", "PUT", expect.objectContaining({ maxRequestsPerMinute: 60 })));
  });

  it("revokes a non-current device", async () => {
    const { controller, elements, api, showStatus } = setup();
    await controller.load();
    const card = elements.adminUsers.querySelectorAll(".admin-user")[1] as HTMLElement;
    const revoke = [...card.querySelectorAll<HTMLButtonElement>(".admin-device button")].find((button) => button.title.includes("Old laptop"));
    expect(revoke).toBeDefined();
    click(revoke!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/devices/device-8", "DELETE"));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("Device revoked", "success"));
  });

  it("stages and applies remote access and host startup confirmations", async () => {
    // Serve is available but not yet configured and startup is not configured,
    // so both action buttons stay enabled after the initial load.
    const base = adminApi();
    const api = vi.fn(async (path: string, method?: string) => {
      if (path === "/api/v1/management/connectivity/status") {
        return { data: { tailscale: { state: "connected", dnsName: "host.tailnet.ts.net" }, serve: { available: true, configuration: {} } } };
      }
      if (path === "/api/v1/management/startup") {
        return { data: { configured: false, available: true, message: "Per-user Windows startup" } };
      }
      return base(path, method);
    });
    const { controller, elements, api: calls, showStatus } = setup(api);
    await controller.load();

    expect(elements.enableRemoteAccess.disabled).toBe(false);
    expect(elements.installHostStartup.disabled).toBe(false);
    click(elements.enableRemoteAccess);
    expect(elements.remoteAccessConfirmation.hidden).toBe(false);
    expect(elements.remoteAccessConfirmationText.textContent).toContain("Enable private HTTPS");
    click(elements.confirmRemoteAccess);
    await vi.waitFor(() => expect(calls).toHaveBeenCalledWith("/api/v1/management/connectivity/tailscale-serve", "POST", {}));
    await vi.waitFor(() => expect(elements.remoteAccessConfirmation.hidden).toBe(true));

    click(elements.installHostStartup);
    expect(elements.hostStartupConfirmation.hidden).toBe(false);
    click(elements.cancelHostStartup);
    expect(elements.hostStartupConfirmation.hidden).toBe(true);
    expect(calls).not.toHaveBeenCalledWith("/api/v1/management/startup", "POST", expect.anything());

    click(elements.installHostStartup);
    click(elements.confirmHostStartup);
    await vi.waitFor(() => expect(calls).toHaveBeenCalledWith("/api/v1/management/startup", "POST", {}));
    await vi.waitFor(() => expect(elements.hostStartupConfirmation.hidden).toBe(true));
    expect(showStatus).not.toHaveBeenCalled();
  });

  it("empties the trash only after an explicit confirmation", async () => {
    const { controller, elements, api, showStatus } = setup();
    await controller.load();

    click(elements.emptyTrashButton);
    expect(elements.emptyTrashConfirmation.hidden).toBe(false);
    expect(elements.emptyTrashConfirmationText.textContent).toContain("Permanently delete");

    click(elements.cancelEmptyTrash);
    expect(elements.emptyTrashConfirmation.hidden).toBe(true);
    expect(api).not.toHaveBeenCalledWith("/api/v1/management/trash", "DELETE");

    click(elements.emptyTrashButton);
    click(elements.confirmEmptyTrash);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/trash", "DELETE"));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Trash emptied"), "success"));
    expect(elements.emptyTrashConfirmation.hidden).toBe(true);
  });

  it("restores trash entries and snapshots from the safety section", async () => {
    const { controller, elements, api, showStatus } = setup();
    await controller.load();

    const restoreButton = elements.adminTrash.querySelector<HTMLButtonElement>("button")!;
    click(restoreButton);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/trash/trash-1/restore", "POST"));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("File restored", "success"));

    const snapshotButton = elements.adminSnapshots.querySelector<HTMLButtonElement>("button")!;
    click(snapshotButton);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/snapshots/run-1/restore", "POST"));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("Workspace restored from run run-1", "success"));
  });

  it("runs retention and reports what was swept", async () => {
    const base = adminApi();
    const api = vi.fn(async (path: string, method?: string, body?: unknown) => {
      if (path === "/api/v1/management/trash/gc" && method === "POST") return { data: { trash: 3, snapshots: 1 } };
      return base(path, method, body);
    });
    const { controller, elements, showStatus } = setup(api);
    await controller.load();

    click(elements.gcRetentionButton);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/trash/gc", "POST", { maxAgeDays: 30 }));
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalledWith("Retention swept 3 trashed files and 1 snapshot", "success"));
    expect(elements.gcRetentionButton.disabled).toBe(false);
  });

  it("renders desktop update state and triggers installs", async () => {
    const { elements, bridge } = setup(adminApi(), {}, {
      updateStatus: vi.fn(async () => ({ state: "downloaded", version: "1.2.3", percent: 100 })),
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(elements.desktopUpdateLabel.textContent).toBe("Update ready to install");
    expect(elements.desktopUpdateVersion.textContent).toContain("1.2.3");
    expect(elements.desktopUpdateProgress.style.width).toBe("100%");
    expect(elements.installDesktopUpdate.hidden).toBe(false);
    expect(elements.updateButton.hidden).toBe(false);
    expect(bridge.onUpdateStatus).toHaveBeenCalled();

    click(elements.installDesktopUpdate);
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalled());
  });

  it("exports the last diagnostics bundle through the bridge", async () => {
    const { controller, elements, bridge } = setup();
    await controller.load();
    bridge.saveDiagnostics.mockResolvedValue("C:\\Users\\me\\diagnostics.json");
    click(elements.exportDiagnostics);
    await vi.waitFor(() => expect(bridge.saveDiagnostics).toHaveBeenCalledWith(expect.stringContaining('"engine"')));
    expect(elements.diagnosticExportStatus.textContent).toBe("Saved to C:\\Users\\me\\diagnostics.json");
    expect(elements.diagnosticExportStatus.getAttribute("role")).toBe("status");
  });

  it("collapses and expands administration sections from their header toggles", () => {
    const sections = sectionsFixture({
      remote: { actions: ["refresh-remote-access"] },
      users: {},
    });
    const { controller } = setupWithSections(sections);

    const remoteToggle = toggleOf(sections, "remote");
    const usersToggle = toggleOf(sections, "users");
    expect(sectionOf(sections, "remote").classList.contains("collapsed")).toBe(false);
    expect(remoteToggle.getAttribute("aria-expanded")).toBe("true");

    click(remoteToggle);
    expect(sectionOf(sections, "remote").classList.contains("collapsed")).toBe(true);
    expect(remoteToggle.getAttribute("aria-expanded")).toBe("false");
    // Only the toggled section collapses; the others stay expanded.
    expect(sectionOf(sections, "users").classList.contains("collapsed")).toBe(false);
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-admin-sections") ?? "[]")).toContain("remote");

    click(remoteToggle);
    expect(sectionOf(sections, "remote").classList.contains("collapsed")).toBe(false);
    expect(remoteToggle.getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-admin-sections") ?? "[]")).not.toContain("remote");

    // Every section toggle is independently bound, including ones without actions.
    click(usersToggle);
    expect(sectionOf(sections, "users").classList.contains("collapsed")).toBe(true);
  });

  it("restores collapsed administration sections from storage and keeps heading actions usable", async () => {
    localStorage.setItem("fitz-collapsed-admin-sections", '["remote","users"]');
    const sections = sectionsFixture({
      remote: { actions: ["refresh-remote-access"] },
      users: {},
    });
    const api = adminApi();
    const refreshRemote = sections.querySelector<HTMLButtonElement>("#refresh-remote-access")!;
    const { controller } = setupWithSections(sections, { api, refreshRemoteAccess: refreshRemote });

    expect(sectionOf(sections, "remote").classList.contains("collapsed")).toBe(true);
    expect(toggleOf(sections, "remote").getAttribute("aria-expanded")).toBe("false");
    expect(sectionOf(sections, "users").classList.contains("collapsed")).toBe(true);

    // Heading actions still work without toggling the collapse state.
    click(refreshRemote);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/connectivity/status"));
    expect(sectionOf(sections, "remote").classList.contains("collapsed")).toBe(true);
  });
});

// Builds the static collapsible-section markup shape used by renderer/index.html:
// a heading row with a chevron toggle button plus optional action buttons, and
// a sibling body wrapper the toggle controls.
function sectionsFixture(config: Record<string, { actions?: string[] }>): HTMLElement {
  const root = document.createElement("div");
  for (const [key, { actions = [] }] of Object.entries(config)) {
    const section = document.createElement("section");
    section.className = "collapsible-section";

    const heading = document.createElement("div");
    heading.className = "collapsible-heading";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "collapsible-toggle";
    toggle.dataset.collapsibleKey = key;
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", `admin-${key}-body`);
    toggle.append(Object.assign(document.createElement("h2"), { textContent: key }));
    heading.append(toggle);
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "collapsible-actions";
    for (const id of actions) {
      actionsDiv.append(Object.assign(document.createElement("button"), { id, type: "button", textContent: id }));
    }
    heading.append(actionsDiv);

    const body = document.createElement("div");
    body.className = "collapsible-body";
    body.id = `admin-${key}-body`;
    body.textContent = `${key} content`;

    section.append(heading, body);
    root.append(section);
  }
  document.body.append(root);
  return root;
}

function setupWithSections(
  sections: HTMLElement,
  overrides: Partial<{ api: AdministrationPageApi; refreshRemoteAccess: HTMLButtonElement }> = {},
) {
  const elements = {
    refresh: node("button"), sections, refreshRemoteAccess: overrides.refreshRemoteAccess ?? node("button"), cancelRemoteAccess: node("button"), refreshHostStartup: node("button"), cancelHostStartup: node("button"),
    pairingCodeForm: node("form"), pairingCodeRole: node("select"), pairingCodeTtl: node("select"), pairingCodeResult: node("div"),
    issuedPairingCode: node("strong"), issuedPairingExpiry: node("span"), copyPairingCode: node("button"),
    createUserForm: node("form"), createUserName: node("input"), createUserRole: node("select"), adminUsers: node("div"),
    toolPolicyForm: node("form"), toolPolicySubjectType: node("select"), toolPolicySubject: node("select"), toolPolicyName: node("input"), toolPolicyDecision: node("select"), toolPolicies: node("div"),
    adminAuditEvents: node("div"), diagnosticGeneratedAt: node("p"), diagnosticSummary: node("div"), diagnosticMetrics: node("div"), diagnosticFailures: node("div"), diagnosticExportStatus: node("p"), exportDiagnostics: node("button"),
    adminTrash: node("div"), adminSnapshots: node("div"), adminToolActions: node("div"),
    emptyTrashButton: node("button"), gcRetentionButton: node("button"),
    emptyTrashConfirmation: node("div"), emptyTrashConfirmationText: node("span"), cancelEmptyTrash: node("button"), confirmEmptyTrash: node("button"),
    remoteAccessStatus: node("div"), remoteAccessConfirmation: node("div"), remoteAccessConfirmationText: node("span"),
    enableRemoteAccess: node("button"), disableRemoteAccess: node("button"), confirmRemoteAccess: node("button"),
    hostStartupStatus: node("div"), hostStartupConfirmation: node("div"), hostStartupConfirmationText: node("span"),
    installHostStartup: node("button"), removeHostStartup: node("button"), confirmHostStartup: node("button"),
    checkDesktopUpdate: node("button"), installDesktopUpdate: node("button"), desktopUpdateLabel: node("span"), desktopUpdateVersion: node("span"), desktopUpdateProgress: node("span"), updateButton: node("button"),
    storageSummary: node("div"), storageIssues: node("div"), storageBackups: node("div"), storageQuota: node("input"),
    verifyStorage: node("button"), collectStorageGarbage: node("button"), createStorageBackup: node("button"), saveStorageQuota: node("button"),
    storageRestoreConfirmation: node("div"), storageRestoreConfirmationText: node("span"), cancelStorageRestore: node("button"), confirmStorageRestore: node("button"),
  };
  const controller = new AdministrationPageController(elements, {
    api: overrides.api ?? adminApi(),
    bridge: {
      copyText: vi.fn(async () => undefined),
      saveDiagnostics: vi.fn(async () => undefined),
      checkForUpdates: vi.fn(async () => undefined),
      installUpdate: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => ({ state: "idle" as const })),
      onUpdateStatus: vi.fn(() => () => undefined),
    },
    isAdministrator: () => true,
    currentUserId: () => "user-1",
    showStatus: vi.fn(),
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  });
  return { controller, elements };
}

function sectionOf(root: HTMLElement, key: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-collapsible-key="${key}"]`)!.closest<HTMLElement>(".collapsible-section")!;
}

function toggleOf(root: HTMLElement, key: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-collapsible-key="${key}"]`)!;
}
