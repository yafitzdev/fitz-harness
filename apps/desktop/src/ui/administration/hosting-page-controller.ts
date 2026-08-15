type Json = Record<string, any>;

export interface HostingPageElements {
  enabled: HTMLInputElement;
  stateLabel: HTMLElement;
  stateMessage: HTMLElement;
  publicUrl: HTMLElement;
  copyUrl: HTMLButtonElement;
  statusCards: HTMLElement;
  repair: HTMLButtonElement;
  advancedStatus: HTMLElement;
  startAtLogin: HTMLInputElement;
  configPath: HTMLElement;
  copyConfigPath: HTMLButtonElement;
  configJson: HTMLTextAreaElement;
  reloadConfig: HTMLButtonElement;
  validateConfig: HTMLButtonElement;
  saveConfig: HTMLButtonElement;
  configStatus: HTMLElement;
}
export interface HostingPageOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  copyText: (value: string) => Promise<void>;
  showStatus: (message: string, tone?: "neutral" | "success" | "error") => void;
  errorMessage: (error: unknown) => string;
  onConfiguration?: (configuration: Json) => void;
}

/** Owns the single public Hosting lifecycle and its advanced canonical JSON
 * editor. Low-level Tailscale controls never leak into the normal workflow. */
export class HostingPageController {
  readonly #elements: HostingPageElements;
  readonly #options: HostingPageOptions;
  #status: Json | undefined;
  #configuration: Json | undefined;
  #configDirty = false;

  constructor(elements: HostingPageElements, options: HostingPageOptions) {
    this.#elements = elements;
    this.#options = options;
    elements.enabled.addEventListener("change", () => void this.#toggleHosting());
    elements.startAtLogin.addEventListener("change", () => void this.#toggleStartup());
    elements.repair.addEventListener("click", () => void this.#repair());
    elements.copyUrl.addEventListener("click", () => void this.#copy(this.#status?.publicUrl, "Hosting URL copied"));
    elements.copyConfigPath.addEventListener("click", () => void this.#copy(this.#status?.configPath, "Configuration path copied"));
    elements.reloadConfig.addEventListener("click", () => void this.load(true));
    elements.validateConfig.addEventListener("click", () => void this.#validate());
    elements.saveConfig.addEventListener("click", () => void this.#save());
    elements.configJson.addEventListener("input", () => { this.#configDirty = true; this.#elements.configStatus.textContent = "Unsaved changes"; });
  }

  async load(forceEditor = false): Promise<void> {
    try {
      const [hosting, configuration] = await Promise.all([
        this.#options.api("/api/v1/management/hosting"),
        this.#options.api("/api/v1/management/config"),
      ]);
      this.#status = hosting.data;
      this.#configuration = configuration.data;
      this.#options.onConfiguration?.(configuration.data);
      this.render(hosting.data);
      if (forceEditor || !this.#configDirty) {
        this.#elements.configJson.value = JSON.stringify(configuration.data, null, 2);
        this.#configDirty = false;
        this.#elements.configStatus.textContent = "Validated canonical configuration";
      }
    } catch (error) {
      this.#elements.stateLabel.textContent = "Hosting unavailable";
      this.#elements.stateMessage.textContent = this.#options.errorMessage(error);
      this.#elements.enabled.disabled = true;
    }
  }

  render(status: Json): void {
    this.#status = status;
    this.#elements.enabled.disabled = false;
    this.#elements.enabled.checked = status.enabled === true;
    this.#elements.stateLabel.textContent = status.online ? "Online" : status.enabled ? "Needs attention" : "Off";
    this.#elements.stateMessage.textContent = status.online ? "Friends can connect with the URL and their API key." : status.message ?? (status.enabled ? "The public endpoint is not reachable." : "Remote connections are disabled.");
    this.#elements.publicUrl.textContent = status.publicUrl ?? "Not available yet";
    this.#elements.copyUrl.disabled = !status.publicUrl;
    this.#elements.repair.disabled = !status.enabled || status.restartRequired === true;
    this.#elements.startAtLogin.checked = status.startup?.configured === true || this.#configuration?.hosting?.startAtLogin === true;
    this.#elements.startAtLogin.disabled = status.startup?.available !== true;
    this.#elements.configPath.textContent = status.configPath ?? "Unavailable";
    this.#elements.copyConfigPath.disabled = !status.configPath;
    this.#renderCards(this.#elements.statusCards, [
      ["Endpoint", status.online ? "Public HTTPS online" : status.enabled ? "Unavailable" : "Disabled"],
      ["Users", "API keys required"],
      ["Protection", status.gateway?.running ? "Consumer gateway active" : "Gateway unavailable"],
    ]);
    this.#renderCards(this.#elements.advancedStatus, [
      ["Tailscale", status.tailscale?.connected ? "Connected" : String(status.tailscale?.state ?? "Unknown")],
      ["Device", status.tailscale?.dnsName ?? "Not signed in"],
      ["Funnel", status.tailscale?.enabled ? "Enabled" : "Disabled"],
      ["Gateway", status.gateway?.origin ?? "Unavailable"],
      ["Startup", status.startup?.configured ? "Starts at sign-in" : "Manual"],
      ["Configuration", status.restartRequired ? "Restart required" : "Applied"],
    ]);
  }

  async #toggleHosting(): Promise<void> {
    const enabled = this.#elements.enabled.checked;
    this.#elements.enabled.disabled = true;
    try {
      const response = await this.#options.api("/api/v1/management/hosting", "PUT", { enabled });
      this.render(response.data);
      await this.load();
      this.#options.showStatus(enabled ? "Hosting enabled" : "Hosting disabled", "success");
    } catch (error) {
      this.#elements.enabled.checked = !enabled;
      this.#options.showStatus(this.#options.errorMessage(error), "error");
    } finally { this.#elements.enabled.disabled = false; }
  }

  async #toggleStartup(): Promise<void> {
    const startAtLogin = this.#elements.startAtLogin.checked;
    this.#elements.startAtLogin.disabled = true;
    try {
      const response = await this.#options.api("/api/v1/management/config", "PATCH", { hosting: { startAtLogin } });
      this.#configuration = response.data?.configuration;
      this.#options.onConfiguration?.(this.#configuration ?? {});
      this.render(response.data?.hosting ?? await this.#statusFromApi());
      this.#options.showStatus(startAtLogin ? "Hosting will start with Windows" : "Hosting startup disabled", "success");
    } catch (error) {
      this.#elements.startAtLogin.checked = !startAtLogin;
      this.#options.showStatus(this.#options.errorMessage(error), "error");
    } finally { this.#elements.startAtLogin.disabled = false; }
  }

  async #repair(): Promise<void> {
    this.#elements.repair.disabled = true;
    try { const response = await this.#options.api("/api/v1/management/hosting/repair", "POST", {}); this.render(response.data); this.#options.showStatus("Hosting repaired", "success"); }
    catch (error) { this.#options.showStatus(this.#options.errorMessage(error), "error"); }
    finally { this.#elements.repair.disabled = false; }
  }

  async #validate(): Promise<Json | undefined> {
    try {
      const parsed = this.#parseEditor();
      const response = await this.#options.api("/api/v1/management/config/validate", "POST", parsed);
      this.#elements.configStatus.textContent = "Configuration is valid";
      return response.data;
    } catch (error) { this.#elements.configStatus.textContent = this.#options.errorMessage(error); return undefined; }
  }

  async #save(): Promise<void> {
    const parsed = await this.#validate();
    if (!parsed) return;
    this.#elements.saveConfig.disabled = true;
    try {
      const response = await this.#options.api("/api/v1/management/config", "PATCH", parsed);
      this.#configuration = response.data.configuration;
      this.#options.onConfiguration?.(this.#configuration ?? {});
      this.#configDirty = false;
      this.#elements.configJson.value = JSON.stringify(this.#configuration, null, 2);
      this.#elements.configStatus.textContent = response.data.hosting?.restartRequired ? "Saved. Restart Fitz to apply the changed hosting ports." : "Saved and applied";
      this.render(response.data.hosting);
    } catch (error) { this.#elements.configStatus.textContent = this.#options.errorMessage(error); }
    finally { this.#elements.saveConfig.disabled = false; }
  }

  #parseEditor(): Json { const value = JSON.parse(this.#elements.configJson.value) as unknown; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object"); return value as Json; }
  async #statusFromApi(): Promise<Json> { return (await this.#options.api("/api/v1/management/hosting")).data; }
  async #copy(value: unknown, message: string): Promise<void> { if (typeof value !== "string" || !value) return; await this.#options.copyText(value); this.#options.showStatus(message, "success"); }
  #renderCards(target: HTMLElement, values: Array<[string, string]>): void { target.replaceChildren(...values.map(([label, value]) => { const card = document.createElement("div"); card.append(Object.assign(document.createElement("small"), { textContent: label }), Object.assign(document.createElement("strong"), { textContent: value })); return card; })); }
}
