// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdministrationPageController, type AdministrationPageBridge, type AdministrationPageElements } from "./administration-page.js";

if (typeof globalThis.Option === "undefined") {
  (globalThis as any).Option = function Option(text = "", value?: string) {
    const option = document.createElement("option"); option.text = text; if (value !== undefined) option.value = value; return option;
  };
}

function node<T extends HTMLElement>(tag: string): T { const value = document.createElement(tag) as T; document.body.append(value); return value; }
function select(values: string[]): HTMLSelectElement { const value = node<HTMLSelectElement>("select"); values.forEach((item) => value.add(new Option(item, item))); return value; }
function memoryStorage(): Storage { const values = new Map<string, string>(); return { get length() { return values.size; }, clear: () => values.clear(), getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null, removeItem: (key) => values.delete(key), setItem: (key, value) => values.set(key, String(value)) } as Storage; }

function elements(): AdministrationPageElements {
  return {
    refresh: node("button"), sections: node("div"),
    createUserForm: node("form"), createUserName: node("input"), createUserKeyName: node("input"), hostedUserResult: node("div"), adminUsers: node("div"),
    toolPolicyForm: node("form"), toolPolicySubjectType: select(["role", "user"]), toolPolicySubject: select([]), toolPolicyName: node("input"), toolPolicyDecision: select(["ask", "allow", "deny"]), toolPolicies: node("div"),
    adminAuditEvents: node("div"), adminTrash: node("div"), adminSnapshots: node("div"), adminToolActions: node("div"), emptyTrashButton: node("button"), gcRetentionButton: node("button"), emptyTrashConfirmation: node("div"), emptyTrashConfirmationText: node("span"), cancelEmptyTrash: node("button"), confirmEmptyTrash: node("button"),
    diagnosticGeneratedAt: node("p"), diagnosticSummary: node("div"), diagnosticMetrics: node("div"), diagnosticFailures: node("div"), diagnosticExportStatus: node("p"), exportDiagnostics: node("button"),
    checkDesktopUpdate: node("button"), installDesktopUpdate: node("button"), desktopUpdateLabel: node("span"), desktopUpdateVersion: node("span"), desktopUpdateProgress: node("span"), updateButton: node("button"),
    storageSummary: node("div"), storageIssues: node("div"), storageBackups: node("div"), storageQuota: node("input"), verifyStorage: node("button"), collectStorageGarbage: node("button"), createStorageBackup: node("button"), saveStorageQuota: node("button"), storageRestoreConfirmation: node("div"), storageRestoreConfirmationText: node("span"), cancelStorageRestore: node("button"), confirmStorageRestore: node("button"),
  };
}

const ada = { id: "user-1", displayName: "Ada", role: "administrator", status: "active" };
const grace = { id: "user-2", displayName: "Grace", role: "consumer", status: "active" };
const quota = { maxRequestsPerMinute: 360, maxPromptChars: 200_000, maxOutputTokens: 131_072, maxQueueDepth: 16 };

function apiMock() {
  return vi.fn(async (path: string, method?: string) => {
    if (path === "/api/v1/management/users") return { data: [ada, grace] };
    if (path === "/api/v1/management/user-usage") return { data: [{ ownerUserId: "user-2", requests: 42, totalTokens: 9000, lastActiveAt: new Date().toISOString() }] };
    if (path.endsWith("/access")) { const user = path.includes("user-2") ? grace : ada; return { data: { user, devices: user === grace ? [{ id: "key-1", name: "Laptop", revokedAt: null }, { id: "key-old", name: "Old laptop", revokedAt: "2026-08-01T00:00:00.000Z" }] : [], routeIds: ["audio"], quota, currentDeviceId: "admin-key" } }; }
    if (path.startsWith("/api/v1/management/usage?")) return { data: { timeline: [{ timestamp: "2026-08-14T20:00:00.000Z", requests: 4 }] } };
    if (path === "/api/v1/management/hosting/users" && method === "POST") return { data: { user: { id: "user-3", displayName: "Linus" }, apiKey: "fitz_once_123", url: "https://yan.example.ts.net" } };
    if (path === "/api/v1/management/devices/key-1/rotate" && method === "POST") return { data: { token: "fitz_rotated_456" } };
    if (path === "/api/v1/management/tool-policies") return { data: [] };
    if (path === "/api/v1/management/audit-events?limit=50") return { data: [] };
    if (path === "/api/v1/management/diagnostics") return { generatedAt: new Date().toISOString(), engine: { state: "UNLOADED" }, queueDepth: 0, resources: {}, metrics: { counters: {}, gauges: {}, timings: {} }, recentRequests: [], recentLifecycleEvents: [] };
    if (["/api/v1/management/trash", "/api/v1/management/snapshots", "/api/v1/management/tool-actions?limit=100"].includes(path)) return { data: [] };
    if (path === "/api/v1/management/storage") return { data: { available: true, report: { artifacts: 0, objects: 0, referencedBytes: 0, orphanObjects: 0, orphanBytes: 0, issues: [] }, backups: [] } };
    return { data: {} };
  });
}

function setup(administrator = true) {
  const page = elements(); page.hostedUserResult.hidden = true; page.emptyTrashConfirmation.hidden = true; page.storageRestoreConfirmation.hidden = true;
  const api = apiMock();
  const bridge: AdministrationPageBridge = { copyText: vi.fn(async () => undefined), saveDiagnostics: vi.fn(async () => undefined), checkForUpdates: vi.fn(async () => undefined), installUpdate: vi.fn(async () => undefined), updateStatus: vi.fn(async () => ({ state: "idle" })), onUpdateStatus: vi.fn(() => () => undefined) };
  const showStatus = vi.fn();
  const controller = new AdministrationPageController(page, { api, bridge, isAdministrator: () => administrator, currentUserId: () => "user-1", showStatus, errorMessage: (error) => error instanceof Error ? error.message : String(error) });
  return { page, api, bridge, showStatus, controller };
}

beforeEach(() => { document.body.replaceChildren(); Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() }); });

describe("AdministrationPageController", () => {
  it("loads people, access, usage summaries, and advanced administration data", async () => {
    const { controller, page, api } = setup(); await controller.load();
    expect(api).toHaveBeenCalledWith("/api/v1/management/user-usage");
    expect(page.adminUsers.querySelectorAll(".admin-user")).toHaveLength(2);
    expect(page.adminUsers.textContent).toContain("42 requests");
    expect(page.adminUsers.textContent).toContain("9K tokens");
    expect(page.adminUsers.textContent).not.toContain("Local Default is available");
    expect(page.adminUsers.textContent).not.toContain("Old laptop");
    expect(page.adminUsers.textContent).toContain("API keys");
  });

  it("adds a consumer and exposes the URL plus API key exactly once", async () => {
    const { controller, page, api, bridge } = setup(); await controller.load();
    page.createUserName.value = "Linus"; page.createUserKeyName.value = "Desktop";
    page.createUserForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/hosting/users", "POST", { displayName: "Linus", keyName: "Desktop" }));
    expect(page.hostedUserResult.hidden).toBe(false);
    expect(page.hostedUserResult.textContent).toContain("https://yan.example.ts.net");
    expect(page.hostedUserResult.textContent).toContain("fitz_once_123");
    page.hostedUserResult.querySelector("button")!.click();
    expect(bridge.copyText).toHaveBeenCalledWith("https://yan.example.ts.net\nfitz_once_123");
  });

  it("loads a per-user time-of-day chart when the person is expanded", async () => {
    const { controller, page, api } = setup(); await controller.load();
    const details = page.adminUsers.querySelectorAll<HTMLDetailsElement>(".admin-user")[1]!;
    details.open = true; details.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(api.mock.calls.some(([path]) => String(path).includes("ownerUserId=user-2"))).toBe(true));
    expect(details.querySelectorAll(".admin-hour-chart span")).toHaveLength(24);
  });

  it("rotates keys and removes a person while preserving their history", async () => {
    const { controller, page, api } = setup(); await controller.load();
    const details = page.adminUsers.querySelectorAll<HTMLDetailsElement>(".admin-user")[1]!;
    (details.querySelector('[aria-label="Rotate Laptop API key"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/devices/key-1/rotate", "POST", {}));
    expect(details.textContent).toContain("fitz_rotated_456");
    ([...details.querySelectorAll("button")].find((button) => button.textContent === "Remove user") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/users/user-2", "DELETE"));
  });

  it("does not load host administration for a consumer", async () => {
    const { controller, api } = setup(false); await controller.load(); expect(api).not.toHaveBeenCalled();
  });
});
