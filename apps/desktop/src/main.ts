import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isAllowedExternalUrl, validateHostUrl, validateRequestPath } from "./security.js";
import { readProjectResource } from "./resource-preview.js";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
const execFileAsync = promisify(execFile);

const directory = dirname(fileURLToPath(import.meta.url));
const localHostPort = commandLineValue("host-port");
const hostUrl = validateHostUrl(commandLineValue("host-url") ?? (localHostPort ? `http://127.0.0.1:${localHostPort}` : undefined) ?? process.env.FITZ_HOST_URL ?? "http://127.0.0.1:8787");
let deviceToken = process.env.FITZ_DEVICE_TOKEN;
interface DesktopUpdateStatus { state: "idle" | "checking" | "available" | "downloading" | "current" | "downloaded" | "error" | "development"; percent?: number; version?: string }
let latestUpdateStatus: DesktopUpdateStatus = { state: app.isPackaged ? "idle" : "development" };
interface StoredConsumerConnection { id: string; displayName: string; baseUrl: string; authType: "none" | "bearer"; apiKey?: string; models: Array<{ id: string; routeId: string; recipeId: string }>; updatedAt: string }

ipcMain.handle("fitz:request", async (_event, input: unknown) => { if (!isRecord(input)) throw new TypeError("Request must be an object"); const path = validateRequestPath(String(input.path ?? "")); const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET"; if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("HTTP method is not allowed"); const responseType = input.responseType === "base64" ? "base64" : "text"; const response = await fetch(new URL(path, hostUrl), { method, headers: { accept: responseType === "base64" ? "*/*" : "application/json", ...(input.body !== undefined ? { "content-type": "application/json" } : {}), ...(deviceToken ? { authorization: `Bearer ${deviceToken}` } : {}) }, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}) }); return { status: response.status, body: responseType === "base64" ? Buffer.from(await response.arrayBuffer()).toString("base64") : await response.text() }; });
ipcMain.handle("fitz:connection-info", () => ({ origin: new URL(hostUrl).origin }));
ipcMain.handle("fitz:consumer-connections-list", () => loadConsumerConnections().map(publicConsumerConnection));
ipcMain.handle("fitz:consumer-connection-save", async (_event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Connection must be an object");
  const existing = typeof input.id === "string" ? loadConsumerConnections().find((item) => item.id === input.id) : undefined;
  const id = existing?.id ?? randomUUID();
  const displayName = requireBoundedText(input.displayName, "Connection name", 100);
  const baseUrl = requireConsumerBaseUrl(input.baseUrl);
  const authType = input.authType === "none" ? "none" : input.authType === "bearer" ? "bearer" : undefined;
  if (!authType) throw new Error("Authorization must be Bearer token or None");
  const enteredKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined;
  const apiKey = authType === "bearer" ? enteredKey ?? existing?.apiKey : undefined;
  if (authType === "bearer" && !apiKey) throw new Error("API key is required");
  const response = await trustedHostRequest(`/api/v1/management/connections/${encodeURIComponent(id)}`, "PUT", { displayName, baseUrl, authType, ...(apiKey ? { apiKey } : {}) });
  const parsed = await parseHostResponse(response);
  const data = isRecord(parsed.data) ? parsed.data : {};
  const connection: StoredConsumerConnection = { id, displayName, baseUrl, authType, ...(apiKey ? { apiKey } : {}), models: parseConsumerModels(data.models), updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString() };
  persistConsumerConnections([...loadConsumerConnections().filter((item) => item.id !== id), connection]);
  return publicConsumerConnection(connection);
});
ipcMain.handle("fitz:consumer-connection-remove", async (_event, value: unknown) => {
  const id = requireBoundedText(value, "Connection ID", 100);
  const response = await trustedHostRequest(`/api/v1/management/connections/${encodeURIComponent(id)}`, "DELETE");
  if (!response.ok && response.status !== 404) throw new Error(hostError(await response.text()));
  persistConsumerConnections(loadConsumerConnections().filter((item) => item.id !== id));
});
ipcMain.handle("fitz:consumer-connections-sync", async () => {
  const results: Array<{ id: string; connected: boolean; error?: string }> = [];
  const updated: StoredConsumerConnection[] = [];
  for (const connection of loadConsumerConnections()) {
    try {
      const response = await trustedHostRequest(`/api/v1/management/connections/${encodeURIComponent(connection.id)}`, "PUT", { displayName: connection.displayName, baseUrl: connection.baseUrl, authType: connection.authType, ...(connection.apiKey ? { apiKey: connection.apiKey } : {}) });
      const parsed = await parseHostResponse(response); const data = isRecord(parsed.data) ? parsed.data : {};
      updated.push({ ...connection, models: parseConsumerModels(data.models), updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : connection.updatedAt });
      results.push({ id: connection.id, connected: true });
    } catch (error) { updated.push(connection); results.push({ id: connection.id, connected: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  persistConsumerConnections(updated);
  return results;
});
ipcMain.handle("fitz:bootstrap-local-device", async () => {
  if (deviceToken || !isLoopbackHost(hostUrl) || !safeStorage.isEncryptionAvailable()) return false;
  const response = await fetch(new URL("/api/v1/pairing/bootstrap", hostUrl), { method: "POST", headers: { accept: "application/json" } });
  if (!response.ok) return false;
  const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
  const data = isRecord(parsed.data) ? parsed.data : {};
  const token = typeof data.token === "string" ? data.token : undefined;
  if (!token) return false;
  persistDeviceToken(token);
  deviceToken = token;
  return true;
});
ipcMain.handle("fitz:pair-device", async (_event, input: unknown) => { if (!isRecord(input)) throw new TypeError("Pairing details must be an object"); const code = requireBoundedText(input.code, "Pairing code", 128); const displayName = requireBoundedText(input.displayName, "Display name", 100); const deviceName = requireBoundedText(input.deviceName, "Device name", 100); if (!safeStorage.isEncryptionAvailable()) return { status: 503, body: JSON.stringify({ error: "Secure credential storage is unavailable" }) }; const response = await fetch(new URL("/api/v1/pairing/redeem", hostUrl), { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ code, displayName, deviceName }) }); const body = await response.text(); if (!response.ok) return { status: response.status, body }; const parsed = JSON.parse(body) as Record<string, unknown>; const data = isRecord(parsed.data) ? parsed.data : {}; const token = typeof data.token === "string" ? data.token : undefined; if (!token) return { status: 502, body: JSON.stringify({ error: "The host did not return a device credential" }) }; persistDeviceToken(token); deviceToken = token; const { token: _token, ...safeData } = data; return { status: response.status, body: JSON.stringify({ ...parsed, data: safeData }) }; });
ipcMain.handle("fitz:open-external", async (_event, url: unknown) => { if (typeof url !== "string" || !isAllowedExternalUrl(url)) throw new Error("External URL is not allowed"); await shell.openExternal(url); });
ipcMain.handle("fitz:choose-folder", async () => { const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; });
ipcMain.handle("fitz:open-path", async (_event, path: unknown) => { if (typeof path !== "string" || !isAbsolute(path)) throw new Error("A valid absolute path is required"); const error = await shell.openPath(path); if (error) throw new Error(error); });
ipcMain.handle("fitz:preview-resource", async (_event, input: unknown) => {
  if (!isRecord(input)) throw new TypeError("Preview request must be an object");
  return readProjectResource(requireLocalPath(input.projectRoot), requireBoundedText(input.reference, "File reference", 4_096));
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

function createWindow(): void { const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 860, minHeight: 560, frame: false, autoHideMenuBar: true, show: false, backgroundColor: "#111317", webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } }); window.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternalUrl(url)) void shell.openExternal(url); return { action: "deny" }; }); window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); }); window.once("ready-to-show", () => window.show()); void window.loadFile(join(directory, "renderer", "index.html")); }
function publishUpdateStatus(status: DesktopUpdateStatus): void { latestUpdateStatus = status; for (const window of BrowserWindow.getAllWindows()) window.webContents.send("fitz:update-status", status); }
autoUpdater.autoDownload = true;
autoUpdater.on("checking-for-update", () => publishUpdateStatus({ state: "checking" }));
autoUpdater.on("update-available", (info) => publishUpdateStatus({ state: "available", version: info.version }));
autoUpdater.on("download-progress", (progress) => publishUpdateStatus({ state: "downloading", percent: Math.max(0, Math.min(100, progress.percent)) }));
autoUpdater.on("update-not-available", (info) => publishUpdateStatus({ state: "current", version: info.version }));
autoUpdater.on("update-downloaded", (info) => publishUpdateStatus({ state: "downloaded", version: info.version, percent: 100 }));
autoUpdater.on("error", () => publishUpdateStatus({ state: "error" }));
await app.whenReady();
deviceToken ??= loadDeviceToken();
if (process.env.FITZ_DESKTOP_SMOKE === "1") {
  if (process.env.FITZ_DESKTOP_SMOKE_OUTPUT) {
    writeFileSync(process.env.FITZ_DESKTOP_SMOKE_OUTPUT, "FITZ_DESKTOP_SMOKE_OK\n", { encoding: "utf8", flag: "wx" });
  }
  app.quit();
} else {
  await ensureBundledLocalHost();
  createWindow();
  if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => undefined);
}
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
async function ensureBundledLocalHost(): Promise<void> {
  if (!app.isPackaged || !isLoopbackHost(hostUrl)) return;
  try { const response = await fetch(new URL("/health", hostUrl), { signal: AbortSignal.timeout(800) }); if (response.ok) return; } catch {}
  const hostRoot = join(process.resourcesPath, "host");
  const executable = join(hostRoot, "runtime", "node.exe");
  const server = join(hostRoot, "dist", "server.js");
  if (!existsSync(executable) || !existsSync(server)) return;
  const child = spawn(executable, [server], { cwd: hostRoot, detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, FITZ_HOST: "127.0.0.1", FITZ_PORT: String(new URL(hostUrl).port || 8787) } });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const response = await fetch(new URL("/health", hostUrl), { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
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
function consumerConnectionsPath(): string { const hostId = createHash("sha256").update(new URL(hostUrl).origin).digest("hex").slice(0, 16); return join(app.getPath("userData"), `consumer-connections-${hostId}.bin`); }
function loadConsumerConnections(): StoredConsumerConnection[] { try { if (!safeStorage.isEncryptionAvailable() || !existsSync(consumerConnectionsPath())) return []; const value = JSON.parse(safeStorage.decryptString(readFileSync(consumerConnectionsPath()))) as unknown; return Array.isArray(value) ? value.filter(isStoredConsumerConnection) : []; } catch { return []; } }
function persistConsumerConnections(connections: StoredConsumerConnection[]): void { if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable"); mkdirSync(dirname(consumerConnectionsPath()), { recursive: true }); writeFileSync(consumerConnectionsPath(), safeStorage.encryptString(JSON.stringify(connections)), { flag: "w" }); }
function publicConsumerConnection(connection: StoredConsumerConnection) { return { id: connection.id, displayName: connection.displayName, baseUrl: connection.baseUrl, authType: connection.authType, hasCredential: Boolean(connection.apiKey), models: connection.models, updatedAt: connection.updatedAt }; }
function isStoredConsumerConnection(value: unknown): value is StoredConsumerConnection { return isRecord(value) && typeof value.id === "string" && typeof value.displayName === "string" && typeof value.baseUrl === "string" && (value.authType === "none" || value.authType === "bearer") && Array.isArray(value.models) && typeof value.updatedAt === "string"; }
function parseConsumerModels(value: unknown): Array<{ id: string; routeId: string; recipeId: string }> { if (!Array.isArray(value)) return []; return value.flatMap((item) => isRecord(item) && typeof item.id === "string" && typeof item.routeId === "string" && typeof item.recipeId === "string" ? [{ id: item.id, routeId: item.routeId, recipeId: item.recipeId }] : []); }
function requireConsumerBaseUrl(value: unknown): string { const text = requireBoundedText(value, "Base URL", 2048); const url = new URL(text); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must use HTTP or HTTPS"); if (url.username || url.password || url.search || url.hash) throw new Error("Base URL must not contain credentials, a query, or a fragment"); return url.toString().replace(/\/$/, ""); }
async function trustedHostRequest(path: string, method: string, body?: unknown): Promise<Response> { return fetch(new URL(validateRequestPath(path), hostUrl), { method, headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(deviceToken ? { authorization: `Bearer ${deviceToken}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
async function parseHostResponse(response: Response): Promise<Record<string, unknown>> { const content = await response.text(); if (!response.ok) throw new Error(hostError(content)); const parsed = content ? JSON.parse(content) as unknown : {}; if (!isRecord(parsed)) throw new Error("The Fitz host returned an invalid response"); return parsed; }
function hostError(content: string): string { try { const parsed = JSON.parse(content) as unknown; if (isRecord(parsed) && typeof parsed.error === "string") return parsed.error; } catch {} return content || "The Fitz host rejected the request"; }
async function runGit(root: string, args: string[]): Promise<string> { const result = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 1_000_000 }); return result.stdout.trim(); }
async function gitBranchState(root: string): Promise<{ current: string; branches: string[] }> { const [current, listing] = await Promise.all([runGit(root, ["branch", "--show-current"]), runGit(root, ["branch", "--format=%(refname:short)"])]); return { current, branches: listing.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }; }
