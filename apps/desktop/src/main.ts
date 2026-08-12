import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isAllowedExternalUrl, validateHostUrl } from "./security.js";
import { readProjectResource } from "./resource-preview.js";
import electronUpdater from "electron-updater";
import { HostStartupError, HostSupervisor } from "./host-supervisor.js";
import { HostClient, hostRequestDeadline } from "./host-client.js";
import { createModelUnloadOnQuitHandler } from "./model-unload-on-quit.js";

const { autoUpdater } = electronUpdater;
const execFileAsync = promisify(execFile);

const directory = dirname(fileURLToPath(import.meta.url));
const localHostPort = commandLineValue("host-port");
const hostUrl = validateHostUrl(commandLineValue("host-url") ?? (localHostPort ? `http://127.0.0.1:${localHostPort}` : undefined) ?? process.env.FITZ_HOST_URL ?? "http://127.0.0.1:8787");
let deviceToken = process.env.FITZ_DEVICE_TOKEN;
const hostClient = new HostClient({ origin: hostUrl, getToken: () => deviceToken });
interface DesktopUpdateStatus { state: "idle" | "checking" | "available" | "downloading" | "current" | "downloaded" | "error" | "development"; percent?: number; version?: string }
let latestUpdateStatus: DesktopUpdateStatus = { state: app.isPackaged ? "idle" : "development" };
interface StoredConsumerConnection { id: string; displayName: string; baseUrl: string; authType: "none" | "bearer"; apiKey?: string; template: string; models: Array<{ id: string; recipeId: string }>; mediaModels: Array<{ id: string; routeId: string; recipeId: string; modality: string; template: string }>; updatedAt: string }

ipcMain.handle("fitz:request", async (event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Request must be an object");
  const path = String(input.path ?? "");
  const responseType = input.responseType === "base64" ? "base64" : "text";
  const controller = new AbortController();
  const cancel = () => controller.abort();
  event.sender.once("destroyed", cancel);
  try {
    return await hostClient.request(path, {
      ...(typeof input.method === "string" ? { method: input.method } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      responseType,
      timeoutMs: hostRequestDeadline(path, responseType),
      signal: controller.signal,
    });
  } finally {
    event.sender.removeListener("destroyed", cancel);
  }
});
ipcMain.handle("fitz:connection-info", () => ({ origin: new URL(hostUrl).origin }));
ipcMain.handle("fitz:consumer-connections-list", () => loadConsumerConnections().map(publicConsumerConnection));
ipcMain.handle("fitz:consumer-connection-save", async (_event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Connection must be an object");
  const existing = typeof input.id === "string" ? loadConsumerConnections().find((item) => item.id === input.id) : undefined;
  const id = existing?.id ?? randomUUID();
  const displayName = requireBoundedText(input.displayName, "Connection name", 100);
  const template = requireConsumerTemplate(input.template);
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
    ...(apiKey ? { apiKey } : {}),
    ...(modelIds.length ? { modelIds } : {}),
  });
  const parsed = await parseHostResponse(response);
  const data = isRecord(parsed.data) ? parsed.data : {};
  const connection: StoredConsumerConnection = { id, displayName, baseUrl, authType, template, ...(apiKey ? { apiKey } : {}), models: parseConsumerModels(data.models), mediaModels: parseConsumerMediaModels(data.mediaModels), updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString() };
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
ipcMain.handle("fitz:bootstrap-local-device", async () => {
  if (deviceToken || !isLoopbackHost(hostUrl) || !safeStorage.isEncryptionAvailable()) return false;
  const response = await hostClient.fetch("/api/v1/pairing/bootstrap", { method: "POST", authenticated: false, timeoutMs: 15_000 });
  if (!response.ok) return false;
  const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
  const data = isRecord(parsed.data) ? parsed.data : {};
  const token = typeof data.token === "string" ? data.token : undefined;
  if (!token) return false;
  persistDeviceToken(token);
  deviceToken = token;
  return true;
});
ipcMain.handle("fitz:pair-device", async (_event, input: unknown) => { if (!isRecord(input)) throw new TypeError("Pairing details must be an object"); const code = requireBoundedText(input.code, "Pairing code", 128); const displayName = requireBoundedText(input.displayName, "Display name", 100); const deviceName = requireBoundedText(input.deviceName, "Device name", 100); if (!safeStorage.isEncryptionAvailable()) return { status: 503, body: JSON.stringify({ error: "Secure credential storage is unavailable" }) }; const response = await hostClient.fetch("/api/v1/pairing/redeem", { method: "POST", authenticated: false, timeoutMs: 15_000, body: { code, displayName, deviceName } }); const body = await response.text(); if (!response.ok) return { status: response.status, body }; const parsed = JSON.parse(body) as Record<string, unknown>; const data = isRecord(parsed.data) ? parsed.data : {}; const token = typeof data.token === "string" ? data.token : undefined; if (!token) return { status: 502, body: JSON.stringify({ error: "The host did not return a device credential" }) }; persistDeviceToken(token); deviceToken = token; const { token: _token, ...safeData } = data; return { status: response.status, body: JSON.stringify({ ...parsed, data: safeData }) }; });
ipcMain.handle("fitz:open-external", async (_event, url: unknown) => { if (typeof url !== "string" || !isAllowedExternalUrl(url)) throw new Error("External URL is not allowed"); await shell.openExternal(url); });
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

function createWindow(): void { const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 860, minHeight: 560, frame: false, autoHideMenuBar: true, show: false, backgroundColor: "#111317", webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, plugins: true /* enable Chromium's PDF viewer for PDFs embedded in the Inspector */ } }); window.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch(() => undefined); return { action: "deny" }; }); window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); }); window.on("app-command", (_event, command) => { if (command === "browser-backward") window.webContents.send("fitz:navigation-command", "back"); else if (command === "browser-forward") window.webContents.send("fitz:navigation-command", "forward"); }); window.once("ready-to-show", () => window.show()); void window.loadFile(join(directory, "renderer", "index.html")); }
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
  shouldUnload: () => !desktopSmoke && isLoopbackHost(hostUrl),
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
  if (desktopSmoke) {
    if (process.env.FITZ_DESKTOP_SMOKE_OUTPUT) writeFileSync(process.env.FITZ_DESKTOP_SMOKE_OUTPUT, "FITZ_DESKTOP_SMOKE_OK\n", { encoding: "utf8", flag: "wx" });
    app.quit();
  } else {
    if (isLoopbackHost(hostUrl) && !(await ensureLocalHost())) app.quit();
    else {
      void warmLocalDefault();
      createWindow();
      if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => undefined);
    }
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
async function ensureLocalHost(): Promise<boolean> {
  const supervisor = new HostSupervisor({ origin: hostUrl, packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  for (;;) {
    try {
      await supervisor.ensureReady();
      return true;
    } catch (error) {
      const startup = error instanceof HostStartupError ? error : new HostStartupError("Fitz could not start", error instanceof Error ? error.message : String(error));
      const result = await dialog.showMessageBox({ type: "error", title: startup.message, message: startup.message, detail: startup.detail, buttons: ["Retry", "Quit"], defaultId: 0, cancelId: 1 });
      if (result.response !== 0) return false;
    }
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function commandLineValue(name: string): string | undefined { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
function isLoopbackHost(value: URL): boolean { const name = value.hostname.replace(/^\[|\]$/g, "").toLowerCase(); return name === "127.0.0.1" || name === "::1" || name === "localhost"; }
function requireLocalPath(value: unknown): string { if (typeof value !== "string" || !isAbsolute(value)) throw new Error("A valid absolute project path is required"); return value; }
function requireBranchName(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\s~^:?*\\\[\]]/.test(value) || value.includes("..") || value.includes("@{")) throw new Error("Invalid branch name"); return value.trim(); }
function requireBoundedText(value: unknown, label: string, maximum: number): string { if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(`${label} is required and must be at most ${maximum} characters`); return value.trim(); }
function deviceTokenPath(): string { const hostId = createHash("sha256").update(new URL(hostUrl).origin).digest("hex").slice(0, 16); return join(app.getPath("userData"), `device-token-${hostId}.bin`); }
function persistDeviceToken(token: string): void { mkdirSync(dirname(deviceTokenPath()), { recursive: true }); writeFileSync(deviceTokenPath(), safeStorage.encryptString(token), { flag: "w" }); }
function loadDeviceToken(): string | undefined { try { if (!safeStorage.isEncryptionAvailable() || !existsSync(deviceTokenPath())) return undefined; return safeStorage.decryptString(readFileSync(deviceTokenPath())); } catch { return undefined; } }
function consumerConnectionsPath(): string {
  const hostId = createHash("sha256").update(new URL(hostUrl).origin).digest("hex").slice(0, 16);
  const ownerId = createHash("sha256").update(deviceToken ?? "unpaired").digest("hex").slice(0, 16);
  return join(app.getPath("userData"), `consumer-connections-${hostId}-${ownerId}.bin`);
}
function legacyConsumerConnectionsPath(): string {
  const hostId = createHash("sha256").update(new URL(hostUrl).origin).digest("hex").slice(0, 16);
  return join(app.getPath("userData"), `consumer-connections-${hostId}.bin`);
}
function readConsumerConnections(path: string): StoredConsumerConnection[] {
  if (!safeStorage.isEncryptionAvailable() || !existsSync(path)) return [];
  const value = JSON.parse(safeStorage.decryptString(readFileSync(path))) as unknown;
  return Array.isArray(value) ? value.filter(isStoredConsumerConnection) : [];
}
/** One-time migration from the removed machine-global credential file. The
 * owner-scoped destination is written first, then the legacy source is retired
 * so an intentional later deletion can never resurrect old credentials. */
function loadConsumerConnections(): StoredConsumerConnection[] {
  try {
    const currentPath = consumerConnectionsPath();
    const current = readConsumerConnections(currentPath);
    const legacyPath = legacyConsumerConnectionsPath();
    if (current.length > 0 || !existsSync(legacyPath)) return current;
    const migrated = readConsumerConnections(legacyPath);
    if (migrated.length === 0) return current;
    persistConsumerConnections(migrated);
    try { renameSync(legacyPath, `${legacyPath}.migrated`); }
    catch (error) { console.warn("Connection migration succeeded, but the retired credential file could not be renamed", error); }
    return migrated;
  } catch { return []; }
}
function persistConsumerConnections(connections: StoredConsumerConnection[]): void { if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable"); mkdirSync(dirname(consumerConnectionsPath()), { recursive: true }); writeFileSync(consumerConnectionsPath(), safeStorage.encryptString(JSON.stringify(connections)), { flag: "w" }); }
function publicConsumerConnection(connection: StoredConsumerConnection) { return { id: connection.id, displayName: connection.displayName, baseUrl: connection.baseUrl, authType: connection.authType, hasCredential: Boolean(connection.apiKey), template: connection.template ?? "openai-compatible", models: connection.models, mediaModels: connection.mediaModels ?? [], updatedAt: connection.updatedAt }; }
function isStoredConsumerConnection(value: unknown): value is StoredConsumerConnection { return isRecord(value) && typeof value.id === "string" && typeof value.displayName === "string" && typeof value.baseUrl === "string" && (value.authType === "none" || value.authType === "bearer") && (value.template === undefined || typeof value.template === "string") && Array.isArray(value.models) && (value.mediaModels === undefined || Array.isArray(value.mediaModels)) && typeof value.updatedAt === "string"; }
function parseConsumerModels(value: unknown): Array<{ id: string; recipeId: string }> { if (!Array.isArray(value)) return []; return value.flatMap((item) => isRecord(item) && typeof item.id === "string" && typeof item.recipeId === "string" ? [{ id: item.id, recipeId: item.recipeId }] : []); }
function parseConsumerMediaModels(value: unknown): Array<{ id: string; routeId: string; recipeId: string; modality: string; template: string }> { if (!Array.isArray(value)) return []; return value.flatMap((item) => isRecord(item) && typeof item.id === "string" && typeof item.routeId === "string" && typeof item.recipeId === "string" && (item.modality === "image" || item.modality === "video" || item.modality === "audio") ? [{ id: item.id, routeId: item.routeId, recipeId: item.recipeId, modality: item.modality, template: typeof item.template === "string" ? item.template : "openai-compatible" }] : []); }
function requireConsumerTemplate(value: unknown): string { if (value === undefined) return "openai-compatible"; if (typeof value === "string" && (value === "openai-compatible" || value === "openai-media" || value === "fal" || value === "replicate")) return value; throw new Error("Template must be openai-compatible, openai-media, fal, or replicate"); }
function requireModelIds(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 200)) throw new Error("Model IDs must be an array of strings"); return [...new Set(value.map((item) => (item as string).trim()).filter(Boolean))]; }
function requireConsumerBaseUrl(value: unknown): string { const text = requireBoundedText(value, "Base URL", 2048); const url = new URL(text); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must use HTTP or HTTPS"); if (url.username || url.password || url.search || url.hash) throw new Error("Base URL must not contain credentials, a query, or a fragment"); return url.toString().replace(/\/$/, ""); }
async function trustedHostRequest(path: string, method: string, body?: unknown): Promise<Response> { return hostClient.fetch(path, { method, ...(body !== undefined ? { body } : {}) }); }
async function parseHostResponse(response: Response): Promise<Record<string, unknown>> { const content = await response.text(); if (!response.ok) throw new Error(hostError(content)); const parsed = content ? JSON.parse(content) as unknown : {}; if (!isRecord(parsed)) throw new Error("The Fitz host returned an invalid response"); return parsed; }
function hostError(content: string): string { try { const parsed = JSON.parse(content) as unknown; if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message; } catch {} return "The Fitz host returned an invalid error response"; }
async function runGit(root: string, args: string[]): Promise<string> { const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1_000_000 }); return result.stdout.trim(); }
async function gitBranchState(root: string): Promise<{ current: string; branches: string[] }> { const [current, listing] = await Promise.all([runGit(root, ["branch", "--show-current"]), runGit(root, ["branch", "--format=%(refname:short)"])]); return { current, branches: listing.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }; }
