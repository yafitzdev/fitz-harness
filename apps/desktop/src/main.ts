import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedExternalUrl, validateHostUrl, validateRequestPath } from "./security.js";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const directory = dirname(fileURLToPath(import.meta.url));
const localHostPort = commandLineValue("host-port");
const hostUrl = validateHostUrl(commandLineValue("host-url") ?? (localHostPort ? `http://127.0.0.1:${localHostPort}` : undefined) ?? process.env.FITZ_HOST_URL ?? "http://127.0.0.1:8787");
const deviceToken = process.env.FITZ_DEVICE_TOKEN;

ipcMain.handle("fitz:request", async (_event, input: unknown) => { if (!isRecord(input)) throw new TypeError("Request must be an object"); const path = validateRequestPath(String(input.path ?? "")); const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET"; if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("HTTP method is not allowed"); const responseType = input.responseType === "base64" ? "base64" : "text"; const response = await fetch(new URL(path, hostUrl), { method, headers: { accept: responseType === "base64" ? "*/*" : "application/json", ...(input.body !== undefined ? { "content-type": "application/json" } : {}), ...(deviceToken ? { authorization: `Bearer ${deviceToken}` } : {}) }, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}) }); return { status: response.status, body: responseType === "base64" ? Buffer.from(await response.arrayBuffer()).toString("base64") : await response.text() }; });
ipcMain.handle("fitz:open-external", async (_event, url: unknown) => { if (typeof url !== "string" || !isAllowedExternalUrl(url)) throw new Error("External URL is not allowed"); await shell.openExternal(url); });
ipcMain.handle("fitz:choose-folder", async () => { const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; });
ipcMain.handle("fitz:open-path", async (_event, path: unknown) => { if (typeof path !== "string" || !isAbsolute(path)) throw new Error("A valid absolute path is required"); const error = await shell.openPath(path); if (error) throw new Error(error); });
ipcMain.handle("fitz:copy-text", (_event, value: unknown) => { if (typeof value !== "string") throw new Error("Clipboard text must be a string"); clipboard.writeText(value); });
ipcMain.handle("fitz:window-action", (event, action: unknown) => { const window = BrowserWindow.fromWebContents(event.sender); if (!window) return; if (action === "minimize") window.minimize(); else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize(); else if (action === "close") window.close(); });
ipcMain.handle("fitz:show-menu", (event, name: unknown, clientX: unknown, clientY: unknown) => { const window = BrowserWindow.fromWebContents(event.sender); if (!window || typeof name !== "string" || typeof clientX !== "number" || typeof clientY !== "number") return; const command = (value: string) => event.sender.send("fitz:menu-command", value); const templates: Record<string, MenuItemConstructorOptions[]> = {
  File: [{ label: "New chat", accelerator: "Ctrl+N", click: () => command("new-chat") }, { label: "New project", click: () => command("new-project") }, { type: "separator" }, { role: "close" }],
  Edit: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
  View: [{ label: "Toggle sidebar", accelerator: "Ctrl+B", click: () => command("toggle-sidebar") }, { label: "Toggle environment", click: () => command("toggle-environment") }, { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }],
  Help: [{ label: "Fitz Codex on GitHub", click: () => void shell.openExternal("https://github.com/yafitzdev/fitz-codex") }],
}; const template = templates[name]; if (!template) return; Menu.buildFromTemplate(template).popup({ window, x: clientX, y: clientY }); });
ipcMain.handle("fitz:update-check", async () => { if (app.isPackaged) await autoUpdater.checkForUpdates(); }); ipcMain.handle("fitz:update-install", () => { if (app.isPackaged) autoUpdater.quitAndInstall(false, true); });

function createWindow(): void { const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 860, minHeight: 560, frame: false, autoHideMenuBar: true, show: false, backgroundColor: "#111317", webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } }); window.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternalUrl(url)) void shell.openExternal(url); return { action: "deny" }; }); window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); }); window.once("ready-to-show", () => window.show()); void window.loadFile(join(directory, "renderer", "index.html")); }
function publishUpdateStatus(status: string): void { for (const window of BrowserWindow.getAllWindows()) window.webContents.send("fitz:update-status", status); }
autoUpdater.autoDownload = true; autoUpdater.on("checking-for-update", () => publishUpdateStatus("checking")); autoUpdater.on("update-available", () => publishUpdateStatus("available")); autoUpdater.on("update-not-available", () => publishUpdateStatus("current")); autoUpdater.on("update-downloaded", () => publishUpdateStatus("downloaded")); autoUpdater.on("error", () => publishUpdateStatus("error"));
await app.whenReady();
if (process.env.FITZ_DESKTOP_SMOKE === "1") {
  if (process.env.FITZ_DESKTOP_SMOKE_OUTPUT) {
    writeFileSync(process.env.FITZ_DESKTOP_SMOKE_OUTPUT, "FITZ_DESKTOP_SMOKE_OK\n", { encoding: "utf8", flag: "wx" });
  }
  app.quit();
} else {
  createWindow();
  if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => undefined);
}
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function commandLineValue(name: string): string | undefined { const prefix = `--${name}=`; return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length); }
