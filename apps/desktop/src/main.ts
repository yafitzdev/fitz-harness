import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isAllowedExternalUrl, validateHostUrl } from "./security.js";
import { readProjectResource } from "./resource-preview.js";
import electronUpdater from "electron-updater";
import { HostSupervisor } from "./host-supervisor.js";
import { HostClient, HostRequestError, hostRequestDeadline } from "./host-client.js";
import { createModelUnloadOnQuitHandler } from "./model-unload-on-quit.js";
import { readThemeColor } from "./theme-token.js";
import { InAppBrowserController } from "./in-app-browser-main.js";
import { parseAgentEventStream } from "./agent-event-stream.js";

const { autoUpdater } = electronUpdater;
const execFileAsync = promisify(execFile);

const directory = dirname(fileURLToPath(import.meta.url));
const windowBackground = readThemeColor(join(directory, "ui", "theme", "tokens.css"), "--window-background");
const browserBackground = readThemeColor(join(directory, "ui", "theme", "tokens.css"), "--browser-surface");
const localHostPort = commandLineValue("host-port");
const legacyRemoteHostUrl = readStoredHostUrl();
const hostUrl = validateHostUrl(localHostPort ? `http://127.0.0.1:${localHostPort}` : "http://127.0.0.1:8787");
let deviceToken = process.env.FITZ_DEVICE_TOKEN;
const hostClient = new HostClient({ origin: hostUrl, getToken: () => deviceToken });
let localHostStartup: Promise<boolean> | undefined;
let localHostReady = false;
let localDeviceStartup: Promise<boolean> | undefined;
let localDeviceReady = false;
interface DesktopUpdateStatus { state: "idle" | "checking" | "available" | "downloading" | "current" | "downloaded" | "error" | "development"; percent?: number; version?: string }
let latestUpdateStatus: DesktopUpdateStatus = { state: app.isPackaged ? "idle" : "development" };
type InferenceExecutionClass = "self_hosted" | "metered_cloud";
type HostAccessClass = "same_device" | "trusted_remote" | "public_remote";
interface StoredConsumerConnection { id: string; displayName: string; baseUrl: string; authType: "none" | "bearer"; apiKey?: string; template: string; executionClass?: InferenceExecutionClass; accessClass?: HostAccessClass; models: Array<{ id: string; recipeId: string }>; mediaModels: Array<{ id: string; routeId: string; recipeId: string; modality: string; template: string }>; updatedAt: string }
const inAppBrowsers = new WeakMap<BrowserWindow, InAppBrowserController>();
const agentEventStreams = new Map<string, AbortController>();

ipcMain.handle("fitz:request", async (event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Request must be an object");
  if (!await ensureLocalHost()) throw new Error("The local Fitz service is still starting");
  if (!await ensureLocalDevice()) throw new Error("The desktop could not initialize its local Fitz service");
  const path = String(input.path ?? "");
  const responseType = input.responseType === "base64" ? "base64" : "text";
  const controller = new AbortController();
  const cancel = () => controller.abort();
  event.sender.once("destroyed", cancel);
  try {
    const result = await hostClient.request(path, {
      ...(typeof input.method === "string" ? { method: input.method } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      responseType,
      timeoutMs: hostRequestDeadline(path, responseType),
      signal: controller.signal,
    });
    if (result.status === 401) localDeviceReady = false;
    return result;
  } catch (error) {
    if (error instanceof HostRequestError && error.code === "network") {
      localHostReady = false;
      localDeviceReady = false;
    }
    throw error;
  } finally {
    event.sender.removeListener("destroyed", cancel);
  }
});
ipcMain.on("fitz:agent-events-subscribe", (event, input: unknown) => {
  const candidateId = isRecord(input) && typeof input.subscriptionId === "string" ? input.subscriptionId : "invalid";
  try {
    const subscription = requireAgentEventSubscription(input);
    const key = `${event.sender.id}:${subscription.subscriptionId}`;
    agentEventStreams.get(key)?.abort();
    const controller = new AbortController();
    agentEventStreams.set(key, controller);
    const cancel = () => controller.abort();
    event.sender.once("destroyed", cancel);
    void relayAgentEvents(subscription.runId, subscription.after, controller.signal, (message) => {
      if (!event.sender.isDestroyed()) event.sender.send("fitz:agent-events", { subscriptionId: subscription.subscriptionId, ...message });
    }).finally(() => {
      event.sender.removeListener("destroyed", cancel);
      if (agentEventStreams.get(key) === controller) agentEventStreams.delete(key);
    });
  } catch (error) {
    if (!event.sender.isDestroyed()) event.sender.send("fitz:agent-events", { subscriptionId: candidateId.slice(0, 128), type: "error", error: desktopErrorMessage(error) });
  }
});
ipcMain.on("fitz:agent-events-unsubscribe", (event, subscriptionId: unknown) => {
  if (typeof subscriptionId !== "string") return;
  const key = `${event.sender.id}:${subscriptionId}`;
  agentEventStreams.get(key)?.abort();
  agentEventStreams.delete(key);
});
ipcMain.handle("fitz:retry-local-host", () => {
  localHostReady = false;
  localDeviceReady = false;
  return ensureLocalHost();
});
ipcMain.handle("fitz:consumer-connections-list", () => loadConsumerConnections().map(publicConsumerConnection));
ipcMain.handle("fitz:consumer-connection-save", async (_event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Connection must be an object");
  const existing = typeof input.id === "string" ? loadConsumerConnections().find((item) => item.id === input.id) : undefined;
  const id = existing?.id ?? randomUUID();
  const displayName = requireBoundedText(input.displayName, "Connection name", 100);
  const template = requireConsumerTemplate(input.template);
  const executionClass = requireExecutionClass(input.executionClass ?? existing?.executionClass);
  // fal and Replicate hide their base URL (the host applies its own default, §5.7);
  // openai-compatible and openai-media always require one.
  const baseUrl = template === "fal" || template === "replicate" ? (input.baseUrl === undefined ? "" : requireConsumerBaseUrl(input.baseUrl)) : requireConsumerBaseUrl(input.baseUrl);
  const authType = input.authType === "none" ? "none" : input.authType === "bearer" ? "bearer" : undefined;
  if (!authType) throw new Error("Authorization must be Bearer token or None");
  const enteredKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined;
  const apiKey = authType === "bearer" ? enteredKey ?? existing?.apiKey : undefined;
  if (authType === "bearer" && !apiKey) throw new Error("API key is required");
  const modelIds = requireModelIds(input.modelIds);
  const response = await trustedHostRequest(`/api/v1/connections/${encodeURIComponent(id)}`, "PUT", {
    displayName,
    template,
    ...(baseUrl ? { baseUrl } : {}),
    authType,
    executionClass,
    ...(apiKey ? { apiKey } : {}),
    ...(modelIds.length ? { modelIds } : {}),
  });
  const parsed = await parseHostResponse(response);
  const data = isRecord(parsed.data) ? parsed.data : {};
  const connection: StoredConsumerConnection = { id, displayName, baseUrl, authType, template, executionClass, accessClass: parseAccessClass(data.accessClass, executionClass, baseUrl), ...(apiKey ? { apiKey } : {}), models: parseConsumerModels(data.models), mediaModels: parseConsumerMediaModels(data.mediaModels), updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString() };
  persistConsumerConnections([...loadConsumerConnections().filter((item) => item.id !== id), connection]);
  return publicConsumerConnection(connection);
});
ipcMain.handle("fitz:consumer-connection-remove", async (_event, value: unknown) => {
  const id = requireBoundedText(value, "Connection ID", 100);
  const response = await trustedHostRequest(`/api/v1/connections/${encodeURIComponent(id)}`, "DELETE");
  if (!response.ok && response.status !== 404) throw new Error(hostError(await response.text()));
  persistConsumerConnections(loadConsumerConnections().filter((item) => item.id !== id));
});
ipcMain.handle("fitz:consumer-connections-sync", async () => {
  const results: Array<{ id: string; connected: boolean; error?: string }> = [];
  const updated: StoredConsumerConnection[] = [];
  for (const connection of loadConsumerConnections()) {
    try {
      const baseUrl = connection.template === "fal" || connection.template === "replicate" ? undefined : connection.baseUrl;
      const response = await trustedHostRequest(`/api/v1/connections/${encodeURIComponent(connection.id)}`, "PUT", {
        displayName: connection.displayName,
        template: connection.template,
        ...(baseUrl ? { baseUrl } : {}),
        authType: connection.authType,
        executionClass: connection.executionClass ?? "metered_cloud",
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        ...(connection.mediaModels?.length ? { modelIds: [...new Set(connection.mediaModels.map((model) => model.id))] } : {}),
      });
      const parsed = await parseHostResponse(response); const data = isRecord(parsed.data) ? parsed.data : {};
      updated.push({ ...connection, models: parseConsumerModels(data.models), mediaModels: parseConsumerMediaModels(data.mediaModels), updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : connection.updatedAt });
      results.push({ id: connection.id, connected: true });
    } catch (error) { updated.push(connection); results.push({ id: connection.id, connected: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  persistConsumerConnections(updated);
  return results;
});
ipcMain.handle("fitz:open-external", async (_event, url: unknown) => { if (typeof url !== "string" || !isAllowedExternalUrl(url)) throw new Error("External URL is not allowed"); await shell.openExternal(url); });
ipcMain.handle("fitz:browser-open", async (event, url: unknown) => inAppBrowserFor(event.sender)?.open(url));
ipcMain.handle("fitz:browser-bounds", (event, bounds: unknown) => inAppBrowserFor(event.sender)?.setBounds(bounds));
ipcMain.handle("fitz:browser-action", (event, action: unknown) => inAppBrowserFor(event.sender)?.action(action));
ipcMain.handle("fitz:choose-folder", async () => { const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; });
ipcMain.handle("fitz:open-path", async (_event, path: unknown) => { if (typeof path !== "string" || !isAbsolute(path)) throw new Error("A valid absolute path is required"); const error = await shell.openPath(path); if (error) throw new Error(error); });
ipcMain.handle("fitz:preview-resource", async (_event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Preview request must be an object");
  const searchRoots = Array.isArray(input.searchRoots) ? input.searchRoots.slice(0, 32).map(requireLocalPath) : [];
  return readProjectResource(requireLocalPath(input.projectRoot), requireBoundedText(input.reference, "File reference", 4_096), searchRoots);
});
ipcMain.handle("fitz:copy-text", (_event, value: unknown) => { if (typeof value !== "string") throw new Error("Clipboard text must be a string"); clipboard.writeText(value); });
ipcMain.handle("fitz:save-diagnostics", async (event, content: unknown) => { if (typeof content !== "string" || content.length > 10_000_000) throw new Error("Diagnostic export must be a bounded JSON string"); const window = BrowserWindow.fromWebContents(event.sender); const stamp = new Date().toISOString().replaceAll(":", "-").replace(".000Z", "Z"); const options = { title: "Export Fitz diagnostics", defaultPath: `fitz-diagnostics-${stamp}.json`, filters: [{ name: "JSON", extensions: ["json"] }] }; const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options); if (result.canceled || !result.filePath) return undefined; writeFileSync(result.filePath, content, { encoding: "utf8", flag: "w" }); return result.filePath; });
ipcMain.handle("fitz:git-branches", async (_event, path: unknown) => gitBranchState(requireLocalPath(path)));
ipcMain.handle("fitz:git-checkout-branch", async (_event, path: unknown, branch: unknown) => { const root = requireLocalPath(path); const name = requireBranchName(branch); const state = await gitBranchState(root); if (!state.branches.includes(name)) throw new Error("Branch does not exist"); await runGit(root, ["switch", name]); return gitBranchState(root); });
ipcMain.handle("fitz:git-create-branch", async (_event, path: unknown, branch: unknown) => { const root = requireLocalPath(path); const name = requireBranchName(branch); await runGit(root, ["check-ref-format", "--branch", name]); await runGit(root, ["switch", "-c", name]); return gitBranchState(root); });
ipcMain.handle("fitz:git-create-worktree", async (_event, path: unknown, branch: unknown) => { const root = requireLocalPath(path); const name = requireBranchName(branch); await runGit(root, ["check-ref-format", "--branch", name]); const repositoryRoot = await runGit(root, ["rev-parse", "--show-toplevel"]); const parent = join(dirname(repositoryRoot), `${basename(repositoryRoot)}-worktrees`); const target = join(parent, name.replaceAll("/", "-")); if (existsSync(target)) throw new Error("A worktree already exists for that branch name"); mkdirSync(parent, { recursive: true }); await runGit(repositoryRoot, ["worktree", "add", "-b", name, target]); return { path: target, branch: name }; });
ipcMain.handle("fitz:window-action", (event, action: unknown) => { const window = BrowserWindow.fromWebContents(event.sender); if (!window) return; if (action === "minimize") window.minimize(); else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize(); else if (action === "close") window.close(); });
ipcMain.handle("fitz:edit-command", (event, command: unknown) => { const contents = event.sender; if (command === "undo") contents.undo(); else if (command === "redo") contents.redo(); else if (command === "cut") contents.cut(); else if (command === "copy") contents.copy(); else if (command === "paste") contents.paste(); else if (command === "select-all") contents.selectAll(); else if (command === "reload") contents.reload(); else if (command === "devtools") contents.toggleDevTools(); });
ipcMain.handle("fitz:update-status", () => latestUpdateStatus);
ipcMain.handle("fitz:update-check", async () => { if (app.isPackaged) await autoUpdater.checkForUpdates(); else publishUpdateStatus({ state: "development" }); });
ipcMain.handle("fitz:update-install", () => { if (app.isPackaged) autoUpdater.quitAndInstall(false, true); });

function createWindow(): void {
  const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 860, minHeight: 560, frame: false, autoHideMenuBar: true, show: false, backgroundColor: windowBackground, webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, plugins: true /* enable Chromium's PDF viewer for PDFs embedded in the Inspector */ } });
  const browser = new InAppBrowserController(window, browserBackground);
  inAppBrowsers.set(window, browser);
  window.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch(() => undefined); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  window.on("app-command", (_event, command) => {
    const direction = command === "browser-backward" ? "back" : command === "browser-forward" ? "forward" : undefined;
    if (direction && !browser.handleMouseNavigation(direction)) window.webContents.send("fitz:navigation-command", direction);
  });
  window.on("closed", () => browser.close());
  window.once("ready-to-show", () => window.show());
  void window.loadFile(join(directory, "renderer", "index.html"));
}
function inAppBrowserFor(contents: Electron.WebContents): InAppBrowserController | undefined { const window = BrowserWindow.fromWebContents(contents); return window ? inAppBrowsers.get(window) : undefined; }
function focusPrimaryWindow(): void { const window = BrowserWindow.getAllWindows()[0]; if (!window) return; if (window.isMinimized()) window.restore(); if (!window.isVisible()) window.show(); window.focus(); }
function publishUpdateStatus(status: DesktopUpdateStatus): void { latestUpdateStatus = status; for (const window of BrowserWindow.getAllWindows()) window.webContents.send("fitz:update-status", status); }
autoUpdater.autoDownload = true;
autoUpdater.on("checking-for-update", () => publishUpdateStatus({ state: "checking" }));
autoUpdater.on("update-available", (info) => publishUpdateStatus({ state: "available", version: info.version }));
autoUpdater.on("download-progress", (progress) => publishUpdateStatus({ state: "downloading", percent: Math.max(0, Math.min(100, progress.percent)) }));
autoUpdater.on("update-not-available", (info) => publishUpdateStatus({ state: "current", version: info.version }));
autoUpdater.on("update-downloaded", (info) => publishUpdateStatus({ state: "downloaded", version: info.version, percent: 100 }));
autoUpdater.on("error", () => publishUpdateStatus({ state: "error" }));
const desktopSmoke = process.env.FITZ_DESKTOP_SMOKE === "1";
app.on("before-quit", createModelUnloadOnQuitHandler({
  app,
  shouldUnload: () => !desktopSmoke,
  unload: async () => {
    const response = await hostClient.fetch("/api/v1/management/instances/stop", {
      method: "POST",
      body: { mode: "force", reason: "desktop-quit" },
      timeoutMs: 45_000,
    });
    if (!response.ok) throw new Error(hostError(await response.text()));
  },
  onError: (error) => console.warn("Could not unload the local model before quit", error),
}));
const primaryInstance = desktopSmoke || app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  if (!desktopSmoke) app.on("second-instance", focusPrimaryWindow);
  await app.whenReady();
  deviceToken ??= loadDeviceToken();
  migrateLegacyRemoteHostConnection();
  if (desktopSmoke) {
    if (process.env.FITZ_DESKTOP_SMOKE_OUTPUT) writeFileSync(process.env.FITZ_DESKTOP_SMOKE_OUTPUT, "FITZ_DESKTOP_SMOKE_OK\n", { encoding: "utf8", flag: "wx" });
    app.quit();
  } else {
    createWindow();
    void ensureLocalHost().then(async (ready) => {
      if (!ready) return;
      await ensureLocalDevice().catch(() => false);
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("fitz:host-ready");
      void warmLocalDefault();
    });
    if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => undefined);
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  }
}
async function warmLocalDefault(): Promise<void> {
  try {
    const response = await hostClient.fetch("/api/v1/inference/warm", {
      method: "POST",
      body: { model: "default" },
      timeoutMs: 15_000,
    });
    if (!response.ok && response.status !== 401) console.warn("Could not preload the local Default model", hostError(await response.text()));
  } catch (error) {
    console.warn("Could not preload the local Default model", error);
  }
}
function ensureLocalHost(): Promise<boolean> {
  if (localHostReady) return Promise.resolve(true);
  if (localHostStartup) return localHostStartup;
  const attempt = (async () => {
    try {
      const supervisor = new HostSupervisor({
        origin: hostUrl,
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        logPath: join(app.getPath("userData"), "host-startup.log"),
      });
      await supervisor.ensureReady();
      localHostReady = true;
      return true;
    } catch (error) {
      localHostReady = false;
      console.warn("The local Fitz host is unavailable; the desktop will remain open", error);
      return false;
    }
  })();
  localHostStartup = attempt;
  void attempt.finally(() => { if (localHostStartup === attempt) localHostStartup = undefined; });
  return attempt;
}
async function ensureLocalDevice(): Promise<boolean> {
  if (localDeviceReady) return true;
  if (localDeviceStartup) return localDeviceStartup;
  const attempt = initializeLocalDevice();
  localDeviceStartup = attempt;
  const clearAttempt = () => { if (localDeviceStartup === attempt) localDeviceStartup = undefined; };
  void attempt.then(clearAttempt, clearAttempt);
  return attempt;
}

async function initializeLocalDevice(): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const identity = await hostClient.fetch("/api/v1/me", { timeoutMs: 15_000 });
  if (identity.ok) {
    localDeviceReady = true;
    return true;
  }
  if (identity.status !== 401 || deviceToken) return false;
  const response = await hostClient.fetch("/api/v1/pairing/bootstrap", { method: "POST", authenticated: false, timeoutMs: 15_000 });
  if (!response.ok) return false;
  const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
  const data = isRecord(parsed.data) ? parsed.data : {};
  const token = typeof data.token === "string" ? data.token : undefined;
  if (!token) return false;
  persistDeviceToken(token);
  deviceToken = token;
  localDeviceReady = true;
  return true;
}
type AgentEventRelayMessage =
  | { type: "event"; event: Record<string, unknown> }
  | { type: "end" }
  | { type: "error"; error: string };

async function relayAgentEvents(
  runId: string,
  after: number,
  signal: AbortSignal,
  publish: (message: AgentEventRelayMessage) => void,
): Promise<void> {
  try {
    const response = await hostClient.fetch(`/api/v1/agent/runs/${encodeURIComponent(runId)}/events?after=${after}&stream=true`, {
      timeoutMs: 24 * 60 * 60_000,
      signal,
    });
    if (!response.ok) throw new Error(await agentEventResponseError(response));
    if (!response.body) throw new Error("The Fitz host returned an empty agent event stream");
    for await (const event of parseAgentEventStream(response.body, signal)) publish({ type: "event", event });
    if (!signal.aborted) publish({ type: "end" });
  } catch (error) {
    if (!signal.aborted) publish({ type: "error", error: desktopErrorMessage(error) });
  }
}

function requireAgentEventSubscription(value: unknown): { subscriptionId: string; runId: string; after: number } {
  if (!isRecord(value)) throw new TypeError("Agent event subscription must be an object");
  const subscriptionId = requireBoundedText(value.subscriptionId, "Subscription ID", 128);
  const runId = requireBoundedText(value.runId, "Run ID", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(subscriptionId) || !/^[A-Za-z0-9._:-]+$/.test(runId)) throw new TypeError("Agent event subscription is invalid");
  if (typeof value.after !== "number" || !Number.isSafeInteger(value.after) || value.after < 0) throw new TypeError("Agent event sequence is invalid");
  return { subscriptionId, runId, after: value.after };
}

async function agentEventResponseError(response: Response): Promise<string> {
  const content = await response.text();
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message;
  } catch { /* fall through to an HTTP-level error */ }
  return `The Fitz host rejected the agent event stream (HTTP ${response.status})`;
}

function desktopErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function commandLineValue(name: string): string | undefined { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function isLoopbackHost(value: URL): boolean { const name = value.hostname.replace(/^\[|\]$/g, "").toLowerCase(); return name === "127.0.0.1" || name === "::1" || name === "localhost"; }
function requireLocalPath(value: unknown): string { if (typeof value !== "string" || !isAbsolute(value)) throw new Error("A valid absolute project path is required"); return value; }
function requireBranchName(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\s~^:?*\\\[\]]/.test(value) || value.includes("..") || value.includes("@{")) throw new Error("Invalid branch name"); return value.trim(); }
function requireBoundedText(value: unknown, label: string, maximum: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${label} is required and must be at most ${maximum} characters`); return value.trim(); }
function deviceTokenPath(): string { return deviceTokenPathForOrigin(new URL(hostUrl).origin); }
function deviceTokenPathForOrigin(origin: string): string { const hostId = createHash("sha256").update(new URL(origin).origin).digest("hex").slice(0, 16); return join(app.getPath("userData"), `device-token-${hostId}.bin`); }
function persistDeviceToken(token: string): void { mkdirSync(dirname(deviceTokenPath()), { recursive: true }); writeFileSync(deviceTokenPath(), safeStorage.encryptString(token), { flag: "w" }); }
function loadDeviceToken(): string | undefined { try { if (!safeStorage.isEncryptionAvailable() || !existsSync(deviceTokenPath())) return undefined; return safeStorage.decryptString(readFileSync(deviceTokenPath())); } catch { return undefined; } }
function loadDeviceTokenForOrigin(origin: string): string | undefined { try { const path = deviceTokenPathForOrigin(origin); if (!safeStorage.isEncryptionAvailable() || !existsSync(path)) return undefined; return safeStorage.decryptString(readFileSync(path)); } catch { return undefined; } }
function hostConfigurationPath(): string { return join(app.getPath("userData"), "host-connection.json"); }
function readStoredHostUrl(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(hostConfigurationPath(), "utf8")) as unknown;
    return isRecord(value) && typeof value.origin === "string" ? value.origin : undefined;
  } catch { return undefined; }
}
/** Converts the removed desktop-wide remote-host mode into a normal inference
 * connection. This is local file migration only: it never contacts the remote
 * network and therefore cannot delay or block application startup. */
function migrateLegacyRemoteHostConnection(): void {
  if (!legacyRemoteHostUrl || !safeStorage.isEncryptionAvailable()) return;
  try {
    const remote = validateHostUrl(legacyRemoteHostUrl);
    if (!isLoopbackHost(remote)) {
      const apiKey = loadDeviceTokenForOrigin(remote.origin);
      if (!apiKey) return;
      const id = `fitz-${createHash("sha256").update(remote.origin).digest("hex").slice(0, 16)}`;
      const connections = loadConsumerConnections();
      if (!connections.some((connection) => connection.id === id || connection.baseUrl === remote.origin)) {
        persistConsumerConnections([...connections, {
          id,
          displayName: `Fitz · ${remote.hostname}`,
          baseUrl: remote.origin,
          authType: "bearer",
          apiKey,
          template: "openai-compatible",
          executionClass: "self_hosted",
          accessClass: "trusted_remote",
          models: [],
          mediaModels: [],
          updatedAt: new Date().toISOString(),
        }]);
      }
    }
    const path = hostConfigurationPath();
    if (existsSync(path)) renameSync(path, `${path}.migrated-${Date.now()}`);
  } catch (error) {
    console.warn("Could not migrate the removed remote-host desktop mode", error);
  }
}
function consumerConnectionsPath(): string {
  const hostId = createHash("sha256").update(hostUrl.origin).digest("hex").slice(0, 16);
  const ownerId = createHash("sha256").update("local-owner").digest("hex").slice(0, 16);
  return join(app.getPath("userData"), `consumer-connections-${hostId}-${ownerId}.bin`);
}
function legacyConsumerConnectionsPath(): string {
  const hostId = createHash("sha256").update(new URL(hostUrl).origin).digest("hex").slice(0, 16);
  return join(app.getPath("userData"), `consumer-connections-${hostId}.bin`);
}
function legacyConsumerConnectionPaths(): string[] {
  const root = app.getPath("userData");
  const current = consumerConnectionsPath().toLowerCase();
  const names = new Set([
    basename(legacyConsumerConnectionsPath()),
    ...readdirSync(root).filter((name) => /^consumer-connections-[a-f0-9]{16}(?:-[a-f0-9]{16})?\.bin$/i.test(name)),
  ]);
  return [...names].map((name) => join(root, name)).filter((path) => path.toLowerCase() !== current && existsSync(path));
}
function readConsumerConnections(path: string): StoredConsumerConnection[] {
  if (!safeStorage.isEncryptionAvailable() || !existsSync(path)) return [];
  const value = JSON.parse(safeStorage.decryptString(readFileSync(path))) as unknown;
  return Array.isArray(value) ? value.filter(isStoredConsumerConnection) : [];
}
/** One-time migration from every removed host/device-scoped credential file.
 * The unified destination is written first, then all readable sources are
 * retired so an intentional later deletion can never resurrect credentials. */
function loadConsumerConnections(): StoredConsumerConnection[] {
  try {
    const currentPath = consumerConnectionsPath();
    const current = readConsumerConnections(currentPath);
    const readableSources: string[] = [];
    const migratedById = new Map<string, StoredConsumerConnection>();
    for (const path of legacyConsumerConnectionPaths()) {
      try {
        for (const connection of readConsumerConnections(path)) migratedById.set(connection.id, connection);
        readableSources.push(path);
      } catch (error) {
        console.warn("Could not read a retired connection credential file", error);
      }
    }
    for (const connection of current) migratedById.set(connection.id, connection);
    const resolved = [...migratedById.values()];
    if (readableSources.length > 0 && resolved.length > 0) persistConsumerConnections(resolved);
    for (const [index, path] of readableSources.entries()) {
      try { renameSync(path, `${path}.migrated-${Date.now()}-${index}`); }
      catch (error) { console.warn("Connection migration succeeded, but a retired credential file could not be renamed", error); }
    }
    return resolved;
  } catch { return []; }
}
function persistConsumerConnections(connections: StoredConsumerConnection[]): void { if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable"); mkdirSync(dirname(consumerConnectionsPath()), { recursive: true }); writeFileSync(consumerConnectionsPath(), safeStorage.encryptString(JSON.stringify(connections)), { flag: "w" }); }
function publicConsumerConnection(connection: StoredConsumerConnection) { const executionClass = connection.executionClass ?? "metered_cloud"; return { id: connection.id, displayName: connection.displayName, baseUrl: connection.baseUrl, authType: connection.authType, hasCredential: Boolean(connection.apiKey), template: connection.template ?? "openai-compatible", executionClass, accessClass: connection.accessClass ?? accessClassForConnection(connection.baseUrl, executionClass), models: connection.models, mediaModels: connection.mediaModels ?? [], updatedAt: connection.updatedAt }; }
function isStoredConsumerConnection(value: unknown): value is StoredConsumerConnection { return isRecord(value) && typeof value.id === "string" && typeof value.displayName === "string" && typeof value.baseUrl === "string" && (value.authType === "none" || value.authType === "bearer") && (value.template === undefined || typeof value.template === "string") && Array.isArray(value.models) && (value.mediaModels === undefined || Array.isArray(value.mediaModels)) && typeof value.updatedAt === "string"; }
function parseConsumerModels(value: unknown): Array<{ id: string; recipeId: string }> { if (!Array.isArray(value)) return []; return value.flatMap((item) => isRecord(item) && typeof item.id === "string" && typeof item.recipeId === "string" ? [{ id: item.id, recipeId: item.recipeId }] : []); }
function parseConsumerMediaModels(value: unknown): Array<{ id: string; routeId: string; recipeId: string; modality: string; template: string }> { if (!Array.isArray(value)) return []; return value.flatMap((item) => isRecord(item) && typeof item.id === "string" && typeof item.routeId === "string" && typeof item.recipeId === "string" && (item.modality === "image" || item.modality === "video" || item.modality === "audio") ? [{ id: item.id, routeId: item.routeId, recipeId: item.recipeId, modality: item.modality, template: typeof item.template === "string" ? item.template : "openai-compatible" }] : []); }
function requireConsumerTemplate(value: unknown): string { if (value === undefined) return "openai-compatible"; if (typeof value === "string" && (value === "openai-compatible" || value === "openai-media" || value === "fal" || value === "replicate")) return value; throw new Error("Template must be openai-compatible, openai-media, fal, or replicate"); }
function requireExecutionClass(value: unknown): InferenceExecutionClass { if (value === undefined || value === "metered_cloud") return "metered_cloud"; if (value === "self_hosted") return value; throw new Error("Execution must be self-hosted or metered cloud"); }
function parseAccessClass(value: unknown, executionClass: InferenceExecutionClass, baseUrl: string): HostAccessClass { return value === "same_device" || value === "trusted_remote" || value === "public_remote" ? value : accessClassForConnection(baseUrl, executionClass); }
function accessClassForConnection(baseUrl: string, executionClass: InferenceExecutionClass): HostAccessClass { try { const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase(); if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "same_device"; } catch {} return executionClass === "self_hosted" ? "trusted_remote" : "public_remote"; }
function requireModelIds(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 200)) throw new Error("Model IDs must be an array of strings"); return [...new Set(value.map((item) => (item as string).trim()).filter(Boolean))]; }
function requireConsumerBaseUrl(value: unknown): string { const text = requireBoundedText(value, "Base URL", 2048); const url = new URL(text); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must use HTTP or HTTPS"); if (url.username || url.password || url.search || url.hash) throw new Error("Base URL must not contain credentials, a query, or a fragment"); return url.toString().replace(/\/$/, ""); }
async function trustedHostRequest(path: string, method: string, body?: unknown): Promise<Response> {
  if (!await ensureLocalHost() || !await ensureLocalDevice()) throw new Error("The local Fitz host is unavailable");
  return hostClient.fetch(path, { method, ...(body !== undefined ? { body } : {}) });
}
async function parseHostResponse(response: Response): Promise<Record<string, unknown>> { const content = await response.text(); if (!response.ok) throw new Error(hostError(content)); const parsed = content ? JSON.parse(content) as unknown : {}; if (!isRecord(parsed)) throw new Error("The Fitz host returned an invalid response"); return parsed; }
function hostError(content: string): string { try { const parsed = JSON.parse(content) as unknown; if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error; if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message; } catch {} return "The Fitz host returned an invalid error response"; }
async function runGit(root: string, args: string[]): Promise<string> { const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1_000_000 }); return result.stdout.trim(); }
async function gitBranchState(root: string): Promise<{ current: string; branches: string[] }> { const [current, listing] = await Promise.all([runGit(root, ["branch", "--show-current"]), runGit(root, ["branch", "--format=%(refname:short)"])]); return { current, branches: listing.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }; }
