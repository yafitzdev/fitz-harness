import type { DesktopBridge, InAppBrowserState } from "../../preload.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import { svgIcon } from "../primitives/dom.js";

type BrowserBridge = Pick<DesktopBridge, "openBrowser" | "setBrowserBounds" | "browserAction" | "onBrowserState" | "openExternal">;
export interface InAppBrowserOptions {
  mount: HTMLElement;
  bridge: BrowserBridge;
  showStatus: ActionFeedback;
}

/** Renderer-owned toolbar paired with the isolated WebContentsView owned by main. */
export class InAppBrowser {
  readonly #bridge: BrowserBridge;
  readonly #showStatus: InAppBrowserOptions["showStatus"];
  readonly #element: HTMLElement;
  readonly #viewport: HTMLElement;
  readonly #address: HTMLInputElement;
  readonly #back: HTMLButtonElement;
  readonly #forward: HTMLButtonElement;
  readonly #reload: HTMLButtonElement;
  readonly #resizeObserver: ResizeObserver | undefined;
  #url = "";
  #open = false;
  #boundsFrame = 0;
  #lastError = "";

  constructor(options: InAppBrowserOptions) {
    this.#bridge = options.bridge;
    this.#showStatus = options.showStatus;
    const element = document.createElement("section");
    element.className = "in-app-browser";
    element.setAttribute("aria-label", "Web preview");
    element.hidden = true;

    const toolbar = document.createElement("div");
    toolbar.className = "in-app-browser-toolbar";
    const back = browserButton("Go back", "<path d='m12.5 4.5-5 5 5 5'/>");
    const forward = browserButton("Go forward", "<path d='m7.5 4.5 5 5-5 5'/>");
    const reload = browserButton("Reload", "<path d='M14 6.5V3.8l-1.8 1.3A6 6 0 1 0 15 10'/>");
    const addressForm = document.createElement("form");
    addressForm.className = "in-app-browser-address-form";
    const address = document.createElement("input");
    address.className = "in-app-browser-address";
    address.type = "text";
    address.inputMode = "url";
    address.autocomplete = "off";
    address.spellcheck = false;
    address.setAttribute("aria-label", "Web address");
    addressForm.append(address);
    const external = browserButton("Open in default browser", "<path d='M11 4h5v5'/><path d='m9 11 7-7'/><path d='M14 11v5H4V6h5'/>");
    const close = browserButton("Close web preview", "<path d='m5 5 10 10M15 5 5 15'/>");
    toolbar.append(back, forward, reload, addressForm, external, close);
    const viewport = document.createElement("div");
    viewport.className = "in-app-browser-viewport";
    element.append(toolbar, viewport);
    options.mount.append(element);

    this.#element = element;
    this.#viewport = viewport;
    this.#address = address;
    this.#back = back;
    this.#forward = forward;
    this.#reload = reload;

    back.addEventListener("click", () => void this.#bridge.browserAction("back"));
    forward.addEventListener("click", () => void this.#bridge.browserAction("forward"));
    reload.addEventListener("click", () => void this.#bridge.browserAction(reload.dataset.loading === "true" ? "stop" : "reload"));
    addressForm.addEventListener("submit", (event) => { event.preventDefault(); void this.open(address.value); });
    external.addEventListener("click", () => { if (this.#url) void this.#bridge.openExternal(this.#url).catch((error) => this.#showStatus(message(error), "error")); });
    close.addEventListener("click", () => this.close());
    this.#bridge.onBrowserState((state) => this.#applyState(state));
    this.#resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => this.#scheduleBounds());
    this.#resizeObserver?.observe(viewport);
    window.addEventListener("resize", () => this.#scheduleBounds());
  }

  get visible(): boolean { return this.#open; }

  syncBounds(): void { this.#scheduleBounds(); }

  async open(value: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(value.trim());
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("Only HTTP and HTTPS links can open inside Fitz");
    } catch (error) {
      this.#showStatus(message(error, "Enter a valid HTTP or HTTPS address"), "error");
      return;
    }
    this.#url = url.toString();
    this.#address.value = this.#url;
    this.#open = true;
    this.#element.hidden = false;
    this.#element.classList.add("loading");
    this.#scheduleBounds();
    try {
      await this.#bridge.openBrowser(this.#url);
      this.#scheduleBounds();
    } catch (error) {
      this.#showStatus(message(error, "Could not open that page"), "error");
      this.close();
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#element.hidden = true;
    if (this.#boundsFrame) cancelAnimationFrame(this.#boundsFrame);
    this.#boundsFrame = 0;
    void this.#bridge.browserAction("close");
  }

  #applyState(state: InAppBrowserState): void {
    if (!this.#open) return;
    if (state.url) { this.#url = state.url; this.#address.value = state.url; }
    this.#back.disabled = !state.canGoBack;
    this.#forward.disabled = !state.canGoForward;
    this.#reload.dataset.loading = String(state.loading);
    this.#reload.setAttribute("aria-label", state.loading ? "Stop loading" : "Reload");
    this.#reload.replaceChildren(svgIcon(state.loading ? "<path d='M6 6h8v8H6z'/>" : "<path d='M14 6.5V3.8l-1.8 1.3A6 6 0 1 0 15 10'/>"));
    this.#element.classList.toggle("loading", state.loading);
    if (state.title) this.#element.setAttribute("aria-label", `${state.title} — Web preview`);
    if (state.error && state.error !== this.#lastError) { this.#lastError = state.error; this.#showStatus(`Could not load page: ${state.error}`, "error"); }
  }

  #scheduleBounds(): void {
    if (!this.#open || this.#boundsFrame) return;
    this.#boundsFrame = requestAnimationFrame(() => {
      this.#boundsFrame = 0;
      if (!this.#open) return;
      const bounds = this.#viewport.getBoundingClientRect();
      void this.#bridge.setBrowserBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    });
  }
}

function browserButton(label: string, icon: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "in-app-browser-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(svgIcon(icon));
  return button;
}
function message(error: unknown, fallback?: string): string { return error instanceof Error && error.message ? error.message : fallback ?? String(error); }
