import { BrowserWindow, WebContentsView } from "electron";
import { requireInAppBrowserUrl } from "./security.js";

export type InAppBrowserAction = "back" | "forward" | "reload" | "stop" | "show" | "hide" | "close";
export interface InAppBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
}

/** Owns the isolated Chromium surface shown beneath the renderer-owned browser toolbar. */
export class InAppBrowserController {
  readonly #window: BrowserWindow;
  readonly #backgroundColor: string;
  #view: WebContentsView | undefined;
  #visible = false;
  #error: string | undefined;

  constructor(window: BrowserWindow, backgroundColor: string) {
    this.#window = window;
    this.#backgroundColor = backgroundColor;
  }

  get visible(): boolean { return this.#visible; }

  async open(value: unknown): Promise<void> {
    const url = requireInAppBrowserUrl(value);
    const view = this.#ensureView();
    this.#error = undefined;
    this.#visible = true;
    view.setVisible(true);
    this.#publish();
    await view.webContents.loadURL(url);
  }

  setBounds(value: unknown): void {
    if (!this.#view || !this.#visible || !isBounds(value)) return;
    const [contentWidth = 0, contentHeight = 0] = this.#window.getContentSize();
    const x = clamp(Math.round(value.x), 0, contentWidth);
    const y = clamp(Math.round(value.y), 0, contentHeight);
    const width = clamp(Math.round(value.width), 0, contentWidth - x);
    const height = clamp(Math.round(value.height), 0, contentHeight - y);
    this.#view.setBounds({ x, y, width, height });
  }

  action(action: unknown): void {
    if (!isBrowserAction(action)) throw new Error("Unknown in-app browser action");
    const view = this.#view;
    if (action === "close") { this.close(); return; }
    if (!view) return;
    if (action === "hide") { this.#visible = false; view.setVisible(false); return; }
    if (action === "show") { this.#visible = true; view.setVisible(true); this.#publish(); return; }
    if (action === "back" && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
    else if (action === "forward" && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
    else if (action === "reload") view.webContents.reload();
    else if (action === "stop") view.webContents.stop();
    this.#publish();
  }

  handleMouseNavigation(direction: "back" | "forward"): boolean {
    if (!this.#visible || !this.#view) return false;
    const history = this.#view.webContents.navigationHistory;
    if (direction === "back" && history.canGoBack()) history.goBack();
    else if (direction === "forward" && history.canGoForward()) history.goForward();
    else return false;
    this.#publish();
    return true;
  }

  close(): void {
    const view = this.#view;
    this.#visible = false;
    this.#view = undefined;
    if (!view) return;
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  #ensureView(): WebContentsView {
    if (this.#view) return this.#view;
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: "persist:fitz-in-app-browser",
      },
    });
    view.setBackgroundColor(this.#backgroundColor);
    view.setVisible(false);
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url }) => {
      try { void view.webContents.loadURL(requireInAppBrowserUrl(url)); } catch { /* Block unsupported schemes. */ }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      try { requireInAppBrowserUrl(url); } catch { event.preventDefault(); }
    });
    view.webContents.on("will-redirect", (event, url) => {
      try { requireInAppBrowserUrl(url); } catch { event.preventDefault(); }
    });
    view.webContents.on("did-start-loading", () => { this.#error = undefined; this.#publish(); });
    view.webContents.on("did-stop-loading", () => this.#publish());
    view.webContents.on("did-navigate", () => this.#publish());
    view.webContents.on("did-navigate-in-page", () => this.#publish());
    view.webContents.on("page-title-updated", () => this.#publish());
    view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) { this.#error = errorDescription; this.#publish(); }
    });
    this.#window.contentView.addChildView(view);
    this.#view = view;
    return view;
  }

  #publish(): void {
    const contents = this.#view?.webContents;
    if (!contents || contents.isDestroyed() || this.#window.isDestroyed()) return;
    const state: InAppBrowserState = {
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      ...(this.#error ? { error: this.#error } : {}),
    };
    this.#window.webContents.send("fitz:browser-state", state);
  }
}

function isBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return typeof value === "object" && value !== null && ["x", "y", "width", "height"].every((key) => Number.isFinite((value as Record<string, unknown>)[key]));
}
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function isBrowserAction(value: unknown): value is InAppBrowserAction { return value === "back" || value === "forward" || value === "reload" || value === "stop" || value === "show" || value === "hide" || value === "close"; }
