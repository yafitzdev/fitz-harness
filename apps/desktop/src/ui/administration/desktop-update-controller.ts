import type { DesktopUpdateStatus } from "../../preload.js";

export interface DesktopUpdateBridge {
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  updateStatus(): Promise<DesktopUpdateStatus>;
  onUpdateStatus(listener: (update: DesktopUpdateStatus) => void): () => void;
}

export interface DesktopUpdateElements {
  check: HTMLButtonElement;
  install: HTMLButtonElement;
  label: HTMLElement;
  version: HTMLElement;
  progress: HTMLElement;
  globalInstall: HTMLButtonElement;
}

/** Owns desktop update status, progress, and trusted bridge actions. */
export class DesktopUpdateController {
  readonly #elements: DesktopUpdateElements;
  readonly #bridge: DesktopUpdateBridge;
  #installing = false;

  constructor(elements: DesktopUpdateElements, bridge: DesktopUpdateBridge) {
    this.#elements = elements;
    this.#bridge = bridge;
    elements.check.addEventListener("click", () => void this.#check());
    elements.install.addEventListener("click", () => void this.#install());
    elements.globalInstall.addEventListener("click", () => void this.#install());
    bridge.onUpdateStatus((update) => this.render(update));
    void bridge.updateStatus().then((update) => this.render(update)).catch(() => this.render({ state: "error" }));
  }

  render(update: DesktopUpdateStatus): void {
    const percent = update.state === "downloaded" ? 100 : Math.max(0, Math.min(100, update.percent ?? 0));
    const labels: Record<DesktopUpdateStatus["state"], string> = {
      idle: "Ready to check",
      checking: "Checking for updates…",
      available: "Update found. Download starting…",
      downloading: `Downloading update · ${Math.round(percent)}%`,
      current: "Fitz is up to date",
      downloaded: "Update ready to install",
      error: "Update check failed",
      development: "Update checks are available in packaged builds",
    };
    this.#elements.label.textContent = labels[update.state];
    this.#elements.label.dataset.state = update.state;
    this.#elements.version.textContent = update.version ? `Version ${update.version}` : "";
    this.#elements.progress.style.width = `${percent}%`;
    const busy = update.state === "checking" || update.state === "available" || update.state === "downloading";
    this.#elements.check.disabled = busy;
    this.#elements.install.hidden = update.state !== "downloaded";
    this.#elements.globalInstall.hidden = update.state !== "downloaded";
  }

  async #check(): Promise<void> {
    this.#elements.check.disabled = true;
    try { await this.#bridge.checkForUpdates(); }
    catch { this.render({ state: "error" }); }
    finally {
      if (this.#elements.label.dataset.state !== "checking" && this.#elements.label.dataset.state !== "downloading") {
        this.#elements.check.disabled = false;
      }
    }
  }

  async #install(): Promise<void> {
    if (this.#installing) return;
    this.#installing = true;
    this.#elements.install.disabled = true;
    this.#elements.globalInstall.disabled = true;
    try {
      await this.#bridge.installUpdate();
    } catch {
      this.render({ state: "error" });
      this.#elements.label.textContent = "Update install failed";
    } finally {
      this.#installing = false;
      this.#elements.install.disabled = false;
      this.#elements.globalInstall.disabled = false;
    }
  }
}
