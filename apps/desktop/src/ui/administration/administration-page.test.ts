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
    "/api/v1/management/pairing-codes": { data: { code: "ABCD-EFGH", expiresAt: "2026-08-04T11:00:00Z" } },
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
    refresh: node("button"), refreshRemoteAccess: node("button"), cancelRemoteAccess: node("button"), refreshHostStartup: node("button"), cancelHostStartup: node("button"),
    pairingCodeForm: node("form"), pairingCodeRole: node("select"), pairingCodeTtl: node("select"), pairingCodeResult: node("div"),
    issuedPairingCode: node("strong"), issuedPairingExpiry: node("span"), copyPairingCode: node("button"),
    createUserForm: node("form"), createUserName: node("input"), createUserRole: node("select"), adminUsers: node("div"),
    toolPolicyForm: node("form"), toolPolicySubjectType: node("select"), toolPolicySubject: node("select"), toolPolicyName: node("input"), toolPolicyDecision: node("select"), toolPolicies: node("div"),
    adminAuditEvents: node("div"), diagnosticGeneratedAt: node("p"), diagnosticSummary: node("div"), diagnosticMetrics: node("div"), diagnosticFailures: node("div"), exportDiagnostics: node("button"),
    remoteAccessStatus: node("div"), remoteAccessConfirmation: node("div"), remoteAccessConfirmationText: node("span"),
    enableRemoteAccess: node("button"), disableRemoteAccess: node("button"), confirmRemoteAccess: node("button"),
    hostStartupStatus: node("div"), hostStartupConfirmation: node("div"), hostStartupConfirmationText: node("span"),
    installHostStartup: node("button"), removeHostStartup: node("button"), confirmHostStartup: node("button"),
    checkDesktopUpdate: node("button"), installDesktopUpdate: node("button"), desktopUpdateLabel: node("span"), desktopUpdateVersion: node("span"), desktopUpdateProgress: node("span"), updateButton: node("button"),
  };
  elements.pairingCodeResult.hidden = true;
  elements.remoteAccessConfirmation.hidden = true;
  elements.hostStartupConfirmation.hidden = true;
  elements.installDesktopUpdate.hidden = true;
  elements.updateButton.hidden = true;
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
  const showToast = vi.fn();
  const controller = new AdministrationPageController(elements, {
    api,
    bridge,
    isAdministrator: options.isAdministrator ?? (() => true),
    currentUserId: options.currentUserId ?? (() => "user-1"),
    showToast,
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  });
  return { controller, elements, bridge, showToast, api };
}

function submit(form: HTMLFormElement): void { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

beforeEach(() => document.body.replaceChildren());
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
    const { controller, elements, api } = setup();
    await controller.load();

    elements.createUserName.value = "Linus";
    elements.createUserRole.value = "agent";
    submit(elements.createUserForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users", "POST", { displayName: "Linus", role: "agent" }));

    elements.toolPolicySubjectType.value = "user";
    elements.toolPolicySubjectType.dispatchEvent(new Event("change", { bubbles: true }));
    elements.toolPolicySubject.value = "user-2";
    elements.toolPolicyName.value = "edit";
    elements.toolPolicyDecision.value = "deny";
    submit(elements.toolPolicyForm);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/tool-policies/user/user-2/edit", "PUT", { decision: "deny" }));

    // Change a consumer's role and save their route + quota access.
    const card = elements.adminUsers.querySelectorAll(".admin-user")[1] as HTMLElement;
    const role = card.querySelector("select") as HTMLSelectElement;
    role.value = "agent";
    role.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2", "PATCH", { role: "agent" }));

    (card.querySelector(".admin-route input") as HTMLInputElement).checked = true;
    click(card.querySelector(".admin-user-actions button")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2/routes", "PUT", { routeIds: ["fast", "default"] }));
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2/quota", "PUT", expect.objectContaining({ maxRequestsPerMinute: 60 })));
  });

  it("revokes a non-current device", async () => {
    const { controller, elements, api } = setup();
    await controller.load();
    const card = elements.adminUsers.querySelectorAll(".admin-user")[1] as HTMLElement;
    const revoke = [...card.querySelectorAll<HTMLButtonElement>(".admin-device button")].find((button) => button.title.includes("Old laptop"));
    expect(revoke).toBeDefined();
    click(revoke!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/devices/device-8", "DELETE"));
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
    const { controller, elements, api: calls, showToast } = setup(api);
    await controller.load();

    expect(elements.enableRemoteAccess.disabled).toBe(false);
    expect(elements.installHostStartup.disabled).toBe(false);
    click(elements.enableRemoteAccess);
    expect(elements.remoteAccessConfirmation.hidden).toBe(false);
    expect(elements.remoteAccessConfirmationText.textContent).toContain("Enable private HTTPS");
    click(elements.confirmRemoteAccess);
    await vi.waitFor(() => expect(calls).toHaveBeenCalledWith("/api/v1/management/connectivity/tailscale-serve", "POST", {}));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Private HTTPS enabled"));
    expect(elements.remoteAccessConfirmation.hidden).toBe(true);

    click(elements.installHostStartup);
    expect(elements.hostStartupConfirmation.hidden).toBe(false);
    click(elements.cancelHostStartup);
    expect(elements.hostStartupConfirmation.hidden).toBe(true);
    expect(calls).not.toHaveBeenCalledWith("/api/v1/management/startup", "POST", expect.anything());

    click(elements.installHostStartup);
    click(elements.confirmHostStartup);
    await vi.waitFor(() => expect(calls).toHaveBeenCalledWith("/api/v1/management/startup", "POST", {}));
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("Host will start at sign-in"));
    expect(elements.hostStartupConfirmation.hidden).toBe(true);
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
    const { controller, elements, bridge, showToast } = setup();
    await controller.load();
    bridge.saveDiagnostics.mockResolvedValue("C:\\Users\\me\\diagnostics.json");
    click(elements.exportDiagnostics);
    await vi.waitFor(() => expect(bridge.saveDiagnostics).toHaveBeenCalledWith(expect.stringContaining('"engine"')));
    expect(showToast).toHaveBeenCalledWith("Diagnostics saved to C:\\Users\\me\\diagnostics.json");
  });
});
