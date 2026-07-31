import { app, BrowserWindow, ipcMain, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAllowedExternalUrl, validateHostUrl, validateRequestPath } from "./security.js";

const directory = dirname(fileURLToPath(import.meta.url)); const hostUrl = validateHostUrl(process.env.FITZ_HOST_URL ?? "http://127.0.0.1:8787"); const deviceToken = process.env.FITZ_DEVICE_TOKEN;

ipcMain.handle("fitz:request", async (_event, input: unknown) => { if (!isRecord(input)) throw new TypeError("Request must be an object"); const path = validateRequestPath(String(input.path ?? "")); const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET"; if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("HTTP method is not allowed"); const response = await fetch(new URL(path, hostUrl), { method, headers: { accept: "application/json", ...(input.body !== undefined ? { "content-type": "application/json" } : {}), ...(deviceToken ? { authorization: `Bearer ${deviceToken}` } : {}) }, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}) }); return { status: response.status, body: await response.text() }; });
ipcMain.handle("fitz:open-external", async (_event, url: unknown) => { if (typeof url !== "string" || !isAllowedExternalUrl(url)) throw new Error("External URL is not allowed"); await shell.openExternal(url); });

function createWindow(): void { const window = new BrowserWindow({ width: 1280, height: 800, minWidth: 860, minHeight: 560, show: false, backgroundColor: "#111317", webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } }); window.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternalUrl(url)) void shell.openExternal(url); return { action: "deny" }; }); window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); }); window.once("ready-to-show", () => window.show()); void window.loadFile(join(directory, "renderer", "index.html")); }
await app.whenReady(); createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
