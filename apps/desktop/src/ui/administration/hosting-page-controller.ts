type Json = Record<string, any>;

/** Raw host request boundary used by the hosting page adapter. */
export type HostingPageApi = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export interface HostingStatus {
  enabled: boolean;
  online: boolean;
  provider: string;
  gateway: { running: boolean; origin: string };
  tailscale: { connected: boolean; enabled: boolean; state?: string; dnsName?: string; publicUrl?: string; message?: string };
  startup: { available: boolean; configured: boolean; message?: string };
  configPath: string;
  restartRequired: boolean;
  publicUrl?: string;
  message?: string;
}

export interface HostingConfigurationPatchResponse {
  configuration: Json;
  hosting: HostingStatus;
}

export interface HostingPageClient {
  status(): Promise<HostingStatus>;
  configuration(): Promise<Json>;
  setEnabled(enabled: boolean): Promise<HostingStatus>;
  repair(): Promise<HostingStatus>;
  validate(configuration: Json): Promise<Json>;
  updateConfiguration(configuration: Json): Promise<HostingConfigurationPatchResponse>;
}

/** Converts raw hosting responses into a typed client used by the controller. */
export function createHostingPageClient(request: HostingPageApi): HostingPageClient {
  return {
    status: async () => parseEnvelope(await request("/api/v1/management/hosting"), parseHostingStatus),
    configuration: async () => parseEnvelope(await request("/api/v1/management/config"), parseConfiguration),
    setEnabled: async (enabled) => parseEnvelope(await request("/api/v1/management/hosting", "PUT", { enabled }), parseHostingStatus),
    repair: async () => parseEnvelope(await request("/api/v1/management/hosting/repair", "POST", {}), parseHostingStatus),
    validate: async (configuration) => parseEnvelope(await request("/api/v1/management/config/validate", "POST", configuration), parseConfiguration),
    updateConfiguration: async (configuration) => parseEnvelope(await request("/api/v1/management/config", "PATCH", configuration), parseConfigurationPatchResponse),
  };
}

export interface HostingPageElements {
  enabled: HTMLInputElement;
  stateLabel: HTMLElement | undefined;
  stateMessage: HTMLElement | undefined;
  publicUrl?: HTMLElement;
  copyUrl: HTMLButtonElement;
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
  api: HostingPageClient;
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
  #status: HostingStatus | undefined;
  #configuration: Json | undefined;
  #configDirty = false;
  #copiedFlash: ReturnType<typeof setTimeout> | undefined;

  constructor(elements: HostingPageElements, options: HostingPageOptions) {
    this.#elements = elements;
    this.#options = options;
    elements.enabled.addEventListener("change", () => void this.#toggleHosting());
    elements.startAtLogin.addEventListener("change", () => void this.#toggleStartup());
    elements.repair.addEventListener("click", () => void this.#repair());
    elements.copyUrl.addEventListener("click", () => void this.#copy(this.#status?.publicUrl, "Hosting URL copied", elements.copyUrl));
    elements.copyConfigPath.addEventListener("click", () => void this.#copy(this.#status?.configPath, "Configuration path copied"));
    elements.reloadConfig.addEventListener("click", () => void this.load(true));
    elements.validateConfig.addEventListener("click", () => void this.#validate());
    elements.saveConfig.addEventListener("click", () => void this.#save());
    elements.configJson.addEventListener("input", () => { this.#configDirty = true; this.#elements.configStatus.textContent = "Unsaved changes"; });
  }

  async load(forceEditor = false): Promise<void> {
    try {
      const [hosting, configuration] = await Promise.all([this.#options.api.status(), this.#options.api.configuration()]);
      this.#status = hosting;
      this.#configuration = configuration;
      this.#options.onConfiguration?.(configuration);
      this.render(hosting);
      if (forceEditor || !this.#configDirty) {
        this.#elements.configJson.value = JSON.stringify(configuration, null, 2);
        this.#configDirty = false;
        this.#elements.configStatus.textContent = "Validated canonical configuration";
      }
    } catch (error) {
      if (this.#elements.stateLabel) this.#elements.stateLabel.textContent = "Hosting unavailable";
      if (this.#elements.stateMessage) this.#elements.stateMessage.textContent = this.#options.errorMessage(error);
      this.#elements.enabled.disabled = true;
    }
  }

  render(status: HostingStatus): void {
    this.#status = status;
    this.#elements.enabled.disabled = false;
    this.#elements.enabled.checked = status.enabled === true;
    if (this.#elements.stateLabel) this.#elements.stateLabel.textContent = status.online ? "Online" : status.enabled ? "Needs attention" : "Off";
    if (this.#elements.stateMessage) this.#elements.stateMessage.textContent = status.online ? "Friends can connect with the URL and their API key." : status.message ?? (status.enabled ? "The public endpoint is not reachable." : "Remote connections are disabled.");
    if (this.#elements.publicUrl) this.#elements.publicUrl.textContent = status.publicUrl ?? "Not available yet";
    this.#elements.copyUrl.disabled = !status.publicUrl;
    this.#elements.repair.disabled = !status.enabled || status.restartRequired === true;
    this.#elements.startAtLogin.checked = status.startup?.configured === true || this.#configuration?.hosting?.startAtLogin === true;
    this.#elements.startAtLogin.disabled = status.startup?.available !== true;
    this.#elements.configPath.textContent = status.configPath ?? "Unavailable";
    this.#elements.copyConfigPath.disabled = !status.configPath;
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
      const response = await this.#options.api.setEnabled(enabled);
      this.render(response);
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
      const response = await this.#options.api.updateConfiguration({ hosting: { startAtLogin } });
      this.#configuration = response.configuration;
      this.#options.onConfiguration?.(this.#configuration ?? {});
      this.render(response.hosting ?? await this.#statusFromApi());
      this.#options.showStatus(startAtLogin ? "Hosting will start with Windows" : "Hosting startup disabled", "success");
    } catch (error) {
      this.#elements.startAtLogin.checked = !startAtLogin;
      this.#options.showStatus(this.#options.errorMessage(error), "error");
    } finally { this.#elements.startAtLogin.disabled = false; }
  }

  async #repair(): Promise<void> {
    this.#elements.repair.disabled = true;
    try { const response = await this.#options.api.repair(); this.render(response); this.#options.showStatus("Hosting repaired", "success"); }
    catch (error) { this.#options.showStatus(this.#options.errorMessage(error), "error"); }
    finally { this.#elements.repair.disabled = false; }
  }

  async #validate(): Promise<Json | undefined> {
    try {
      const parsed = this.#parseEditor();
      const response = await this.#options.api.validate(parsed);
      this.#elements.configStatus.textContent = "Configuration is valid";
      return response;
    } catch (error) { this.#elements.configStatus.textContent = this.#options.errorMessage(error); return undefined; }
  }

  async #save(): Promise<void> {
    const parsed = await this.#validate();
    if (!parsed) return;
    this.#elements.saveConfig.disabled = true;
    try {
      const response = await this.#options.api.updateConfiguration(parsed);
      this.#configuration = response.configuration;
      this.#options.onConfiguration?.(this.#configuration ?? {});
      this.#configDirty = false;
      this.#elements.configJson.value = JSON.stringify(this.#configuration, null, 2);
      this.#elements.configStatus.textContent = response.hosting.restartRequired ? "Saved. Restart Fitz to apply the changed hosting ports." : "Saved and applied";
      this.render(response.hosting);
    } catch (error) { this.#elements.configStatus.textContent = this.#options.errorMessage(error); }
    finally { this.#elements.saveConfig.disabled = false; }
  }

  #parseEditor(): Json { const value = JSON.parse(this.#elements.configJson.value) as unknown; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object"); return value as Json; }
  async #statusFromApi(): Promise<HostingStatus> { return this.#options.api.status(); }
  async #copy(value: unknown, message: string, button?: HTMLButtonElement): Promise<void> { if (typeof value !== "string" || !value) return; await this.#options.copyText(value); this.#options.showStatus(message, "success"); if (button) this.#flashCopied(button); }
  /** Brief in-button checkmark so the user can confirm the copy succeeded. */
  #flashCopied(button: HTMLButtonElement): void {
    if (this.#copiedFlash !== undefined) clearTimeout(this.#copiedFlash);
    const original = button.textContent ?? "Copy URL";
    button.textContent = "✓ Copied";
    button.classList.add("is-copied");
    button.disabled = true;
    this.#copiedFlash = setTimeout(() => {
      this.#copiedFlash = undefined;
      button.textContent = original;
      button.classList.remove("is-copied");
      button.disabled = !this.#status?.publicUrl;
    }, 1400);
  }
  #renderCards(target: HTMLElement, values: Array<[string, string]>): void { target.replaceChildren(...values.map(([label, value]) => { const card = document.createElement("div"); card.append(Object.assign(document.createElement("small"), { textContent: label }), Object.assign(document.createElement("strong"), { textContent: value })); return card; })); }
}

function parseEnvelope<T>(value: unknown, parse: (value: unknown) => T): T {
  if (!isRecord(value) || !("data" in value)) throw invalidResponse("missing data envelope");
  return parse(value.data);
}

function parseHostingStatus(value: unknown): HostingStatus {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.online !== "boolean"
    || typeof value.provider !== "string" || typeof value.configPath !== "string" || typeof value.restartRequired !== "boolean"
    || !isRecord(value.gateway) || typeof value.gateway.running !== "boolean" || typeof value.gateway.origin !== "string"
    || !isRecord(value.tailscale) || typeof value.tailscale.connected !== "boolean" || typeof value.tailscale.enabled !== "boolean"
    || !isRecord(value.startup) || typeof value.startup.available !== "boolean" || typeof value.startup.configured !== "boolean") {
    throw invalidResponse("hosting status is invalid");
  }
  return {
    enabled: value.enabled,
    online: value.online,
    provider: value.provider,
    gateway: { running: value.gateway.running, origin: value.gateway.origin },
    tailscale: {
      connected: value.tailscale.connected,
      enabled: value.tailscale.enabled,
      ...(typeof value.tailscale.state === "string" ? { state: value.tailscale.state } : {}),
      ...(typeof value.tailscale.dnsName === "string" ? { dnsName: value.tailscale.dnsName } : {}),
      ...(typeof value.tailscale.publicUrl === "string" ? { publicUrl: value.tailscale.publicUrl } : {}),
      ...(typeof value.tailscale.message === "string" ? { message: value.tailscale.message } : {}),
    },
    startup: {
      available: value.startup.available,
      configured: value.startup.configured,
      ...(typeof value.startup.message === "string" ? { message: value.startup.message } : {}),
    },
    configPath: value.configPath,
    restartRequired: value.restartRequired,
    ...(typeof value.publicUrl === "string" ? { publicUrl: value.publicUrl } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function parseConfiguration(value: unknown): Json {
  if (!isRecord(value)) throw invalidResponse("configuration is invalid");
  return value;
}

function parseConfigurationPatchResponse(value: unknown): HostingConfigurationPatchResponse {
  if (!isRecord(value) || !isRecord(value.configuration)) throw invalidResponse("configuration patch is invalid");
  return { configuration: value.configuration, hosting: parseHostingStatus(value.hosting) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(detail: string): TypeError {
  return new TypeError(`The hosting API returned an invalid response: ${detail}`);
}
