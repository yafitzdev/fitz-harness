import { textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

export type HostLifecycleApi = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface HostLifecycleElements {
  refreshRemote: HTMLButtonElement;
  cancelRemote: HTMLButtonElement;
  remoteStatus: HTMLElement;
  remoteConfirmation: HTMLElement;
  remoteConfirmationText: HTMLElement;
  enableRemote: HTMLButtonElement;
  disableRemote: HTMLButtonElement;
  confirmRemote: HTMLButtonElement;
  refreshStartup: HTMLButtonElement;
  cancelStartup: HTMLButtonElement;
  startupStatus: HTMLElement;
  startupConfirmation: HTMLElement;
  startupConfirmationText: HTMLElement;
  installStartup: HTMLButtonElement;
  removeStartup: HTMLButtonElement;
  confirmStartup: HTMLButtonElement;
}

export interface HostLifecycleOptions {
  api: HostLifecycleApi;
  reload: () => Promise<void>;
  errorMessage: (error: unknown) => string;
}

/** Owns remote-access and Windows-startup status, confirmations, and mutations. */
export class HostLifecycleController {
  readonly #elements: HostLifecycleElements;
  readonly #options: HostLifecycleOptions;
  #pendingRemoteAction: "enable" | "disable" | undefined;
  #pendingStartupAction: "install" | "remove" | undefined;

  constructor(elements: HostLifecycleElements, options: HostLifecycleOptions) {
    this.#elements = elements;
    this.#options = options;
    elements.refreshRemote.addEventListener("click", () => void this.loadRemote());
    elements.enableRemote.addEventListener("click", () => this.#showRemoteConfirmation("enable"));
    elements.disableRemote.addEventListener("click", () => this.#showRemoteConfirmation("disable"));
    elements.cancelRemote.addEventListener("click", () => this.#hideRemoteConfirmation());
    elements.confirmRemote.addEventListener("click", () => void this.#applyRemoteChange());
    elements.refreshStartup.addEventListener("click", () => void this.loadStartup());
    elements.installStartup.addEventListener("click", () => this.#showStartupConfirmation("install"));
    elements.removeStartup.addEventListener("click", () => this.#showStartupConfirmation("remove"));
    elements.cancelStartup.addEventListener("click", () => this.#hideStartupConfirmation());
    elements.confirmStartup.addEventListener("click", () => void this.#applyStartupChange());
  }

  async loadRemote(): Promise<void> {
    try {
      const response = await this.#options.api("/api/v1/management/connectivity/status");
      this.renderRemote(response.data);
    } catch (error) {
      this.#elements.remoteStatus.replaceChildren(emptyState(`Remote status unavailable: ${this.#options.errorMessage(error)}`));
    }
  }

  renderRemote(remote: Json): void {
    const tailscale = remote.tailscale ?? {};
    const configuration = remote.serve?.configuration;
    const served = remote.serve?.available === true && configuration && Object.keys(configuration).length > 0;
    const values = [
      ["Tailscale", String(tailscale.state ?? "unknown").replaceAll("-", " ")],
      ["Device", tailscale.dnsName ?? tailscale.addresses?.[0] ?? "Not connected"],
      ["Private HTTPS", remote.serve?.available === false ? "Unavailable" : served ? "Enabled" : "Disabled"],
    ];
    this.#elements.remoteStatus.replaceChildren();
    for (const [label, value] of values) {
      const card = document.createElement("div");
      card.className = "remote-access-card";
      card.append(
        Object.assign(document.createElement("small"), { textContent: label }),
        Object.assign(document.createElement("strong"), { textContent: value }),
      );
      this.#elements.remoteStatus.append(card);
    }
    this.#elements.enableRemote.disabled = tailscale.state !== "connected" || Boolean(served);
    this.#elements.disableRemote.disabled = !served;
  }

  async loadStartup(): Promise<void> {
    try {
      const response = await this.#options.api("/api/v1/management/startup");
      this.renderStartup(response.data);
    } catch (error) {
      this.#elements.startupStatus.replaceChildren(emptyState(`Startup status unavailable: ${this.#options.errorMessage(error)}`));
    }
  }

  renderStartup(startup: Json): void {
    this.#elements.startupStatus.replaceChildren(
      Object.assign(document.createElement("strong"), { textContent: startup.configured ? "Starts at sign-in" : "Does not start at sign-in" }),
      Object.assign(document.createElement("span"), { textContent: startup.message ?? (startup.available ? "Per-user Windows startup" : "Packaged host launcher unavailable") }),
    );
    this.#elements.installStartup.disabled = !startup.available || startup.configured;
    this.#elements.removeStartup.disabled = !startup.configured;
  }

  #showRemoteConfirmation(action: "enable" | "disable"): void {
    this.#pendingRemoteAction = action;
    this.#clearConfirmationError(this.#elements.remoteConfirmation);
    this.#elements.remoteConfirmationText.textContent = action === "enable"
      ? "Enable private HTTPS through Tailscale Serve for this Fitz host?"
      : "Disable the private HTTPS route? Remote clients will disconnect.";
    this.#elements.confirmRemote.textContent = action === "enable" ? "Confirm enable" : "Confirm disable";
    this.#elements.remoteConfirmation.hidden = false;
  }

  #hideRemoteConfirmation(): void {
    this.#pendingRemoteAction = undefined;
    this.#elements.remoteConfirmation.hidden = true;
    this.#clearConfirmationError(this.#elements.remoteConfirmation);
  }

  async #applyRemoteChange(): Promise<void> {
    if (!this.#pendingRemoteAction) return;
    const action = this.#pendingRemoteAction;
    this.#elements.confirmRemote.disabled = true;
    try {
      if (action === "enable") await this.#options.api("/api/v1/management/connectivity/tailscale-serve", "POST", {});
      else await this.#options.api("/api/v1/management/connectivity/tailscale-serve", "DELETE");
      this.#hideRemoteConfirmation();
      await this.#options.reload();
    } catch (error) {
      this.#showConfirmationError(this.#elements.remoteConfirmation, this.#elements.remoteConfirmationText, error);
    }
    finally { this.#elements.confirmRemote.disabled = false; }
  }

  #showStartupConfirmation(action: "install" | "remove"): void {
    this.#pendingStartupAction = action;
    this.#clearConfirmationError(this.#elements.startupConfirmation);
    this.#elements.startupConfirmationText.textContent = action === "install"
      ? "Start the lightweight Fitz host automatically at Windows sign-in?"
      : "Remove Fitz host from Windows sign-in startup?";
    this.#elements.confirmStartup.textContent = action === "install" ? "Confirm startup" : "Confirm removal";
    this.#elements.startupConfirmation.hidden = false;
  }

  #hideStartupConfirmation(): void {
    this.#pendingStartupAction = undefined;
    this.#elements.startupConfirmation.hidden = true;
    this.#clearConfirmationError(this.#elements.startupConfirmation);
  }

  async #applyStartupChange(): Promise<void> {
    if (!this.#pendingStartupAction) return;
    const action = this.#pendingStartupAction;
    this.#elements.confirmStartup.disabled = true;
    try {
      await this.#options.api("/api/v1/management/startup", action === "install" ? "POST" : "DELETE", action === "install" ? {} : undefined);
      this.#hideStartupConfirmation();
      await this.#options.reload();
    } catch (error) {
      this.#showConfirmationError(this.#elements.startupConfirmation, this.#elements.startupConfirmationText, error);
    }
    finally { this.#elements.confirmStartup.disabled = false; }
  }

  #showConfirmationError(container: HTMLElement, label: HTMLElement, error: unknown): void {
    label.textContent = this.#options.errorMessage(error);
    container.dataset.state = "error";
    container.setAttribute("role", "alert");
    container.hidden = false;
  }

  #clearConfirmationError(container: HTMLElement): void {
    delete container.dataset.state;
    container.removeAttribute("role");
  }
}

function emptyState(message: string): HTMLElement { return textBlock("panel-empty", message); }
