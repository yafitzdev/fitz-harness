import { contextBridge, ipcRenderer } from "electron";
export interface DesktopBridge { request(input: { path: string; method?: string; body?: unknown }): Promise<{ status: number; body: string }>; openExternal(url: string): Promise<void> }
const bridge: DesktopBridge = { request: (input) => ipcRenderer.invoke("fitz:request", input), openExternal: (url) => ipcRenderer.invoke("fitz:open-external", url) };
contextBridge.exposeInMainWorld("fitz", Object.freeze(bridge));
