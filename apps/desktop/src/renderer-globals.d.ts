import type { DesktopBridge } from "./preload.js";
declare global { interface Window { fitz: DesktopBridge } }
export {};
