import type { FitzConfigDocument, FitzConfigPatch, FitzConfigService } from "@fitz/config";
import type { SharedHostGateway, TailscaleFunnelManager, TailscaleFunnelStatus, WindowsStartupManager, WindowsStartupStatus } from "@fitz/connectivity";

export interface HostingStatus {
  enabled: boolean;
  online: boolean;
  publicUrl?: string;
  provider: FitzConfigDocument["hosting"]["provider"];
  gateway: { running: boolean; origin: string };
  tailscale: TailscaleFunnelStatus;
  startup: WindowsStartupStatus;
  configPath: string;
  restartRequired: boolean;
  message?: string;
}

export interface HostingServiceOptions {
  config: FitzConfigService;
  gateway: SharedHostGateway;
  funnel: TailscaleFunnelManager;
  startup: WindowsStartupManager;
  onError?: (error: unknown) => void;
}

/** Reconciles one desired hosting state across the canonical configuration,
 * protected gateway, Tailscale Funnel, and Windows startup. */
export class HostingService {
  readonly #config: FitzConfigService;
  readonly #gateway: SharedHostGateway;
  readonly #funnel: TailscaleFunnelManager;
  readonly #startup: WindowsStartupManager;
  readonly #onError: (error: unknown) => void;
  #stopWatching: (() => void) | undefined;
  #initialGatewayPort: number;
  #initialPublicPort: number;
  #reconcile = Promise.resolve();

  constructor(options: HostingServiceOptions) {
    this.#config = options.config;
    this.#gateway = options.gateway;
    this.#funnel = options.funnel;
    this.#startup = options.startup;
    this.#onError = options.onError ?? (() => undefined);
    this.#initialGatewayPort = options.config.read().hosting.gatewayPort;
    this.#initialPublicPort = options.config.read().hosting.publicPort;
  }

  async initialize(): Promise<HostingStatus> {
    await this.#gateway.start();
    // Keep external JSON edits observable even if the first Tailscale/startup
    // reconciliation needs attention and initialization reports an error.
    this.#stopWatching = this.#config.watch(() => this.#queueReconcile(), this.#onError);
    const current = await this.#funnel.status();
    const desired = this.#config.read();
    if (current.enabled && !desired.hosting.enabled) {
      // On the first upgrade, adopt a pre-existing Fitz Funnel. Once the
      // canonical file already exists, it is authoritative and an off switch
      // must remain off across restarts.
      if (this.#config.existed) await this.#funnel.disable();
      else this.#config.update({ hosting: { enabled: true } });
    }
    else if (desired.hosting.enabled && !current.enabled) await this.#funnel.enable();
    await this.#reconcileStartup(this.#config.read().hosting.startAtLogin);
    return this.status();
  }

  async status(): Promise<HostingStatus> {
    const document = this.#config.read();
    const [tailscale, startup] = await Promise.all([this.#funnel.status(), this.#startup.status()]);
    const online = document.hosting.enabled && this.#gateway.running && tailscale.enabled;
    return {
      enabled: document.hosting.enabled,
      online,
      provider: document.hosting.provider,
      gateway: { running: this.#gateway.running, origin: this.#gateway.origin },
      tailscale,
      startup,
      configPath: this.#config.path,
      restartRequired: document.hosting.gatewayPort !== this.#initialGatewayPort || document.hosting.publicPort !== this.#initialPublicPort,
      ...(tailscale.publicUrl ? { publicUrl: tailscale.publicUrl } : {}),
      ...(!online && document.hosting.enabled ? { message: tailscale.message ?? "Hosting is enabled but the public endpoint is not online" } : {}),
    };
  }

  configuration(): FitzConfigDocument { return this.#config.read(); }
  get configPath(): string { return this.#config.path; }
  preview(patch: FitzConfigPatch): FitzConfigDocument { return this.#config.preview(patch); }

  async update(patch: FitzConfigPatch): Promise<HostingStatus> {
    const current = this.#config.read();
    const next = this.#config.preview(patch);
    if (next.hosting.provider !== "tailscale-funnel") throw new Error("Only Tailscale Funnel is supported by the unified Hosting page");
    const portsChanged = next.hosting.gatewayPort !== current.hosting.gatewayPort || next.hosting.publicPort !== current.hosting.publicPort;
    const hostingChanged = next.hosting.enabled !== current.hosting.enabled;
    const startupChanged = next.hosting.startAtLogin !== current.hosting.startAtLogin;
    let hostingApplied = false;
    let startupApplied = false;
    try {
      // Disabling is always safe to apply to the current listener. Enabling
      // after a port change must wait for restart, otherwise the old manager
      // would publish a target that no longer matches the declared config.
      if (hostingChanged && (!portsChanged || !next.hosting.enabled)) {
        if (next.hosting.enabled) await this.#funnel.enable();
        else await this.#funnel.disable();
        hostingApplied = true;
      }
      if (startupChanged) {
        await this.#reconcileStartup(next.hosting.startAtLogin);
        startupApplied = true;
      }
      this.#config.update(patch);
    } catch (error) {
      // The file is the source of truth. If persisting it (or a later side
      // effect) fails, restore any external state already changed so the
      // machine cannot silently drift away from that source of truth.
      if (startupApplied) {
        try { await this.#reconcileStartup(current.hosting.startAtLogin); }
        catch (rollbackError) { this.#onError(rollbackError); }
      }
      if (hostingApplied) {
        try {
          if (current.hosting.enabled) await this.#funnel.enable();
          else await this.#funnel.disable();
        } catch (rollbackError) { this.#onError(rollbackError); }
      }
      throw error;
    }
    return this.status();
  }

  async repair(): Promise<HostingStatus> {
    await this.#gateway.start();
    const desired = this.#config.read();
    const portsChanged = desired.hosting.gatewayPort !== this.#initialGatewayPort || desired.hosting.publicPort !== this.#initialPublicPort;
    if (desired.hosting.enabled && portsChanged) throw new Error("Restart Fitz before repairing Hosting because its ports changed");
    if (desired.hosting.enabled) await this.#funnel.enable();
    await this.#reconcileStartup(desired.hosting.startAtLogin);
    return this.status();
  }

  async close(): Promise<void> {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
    await this.#gateway.stop();
  }

  #queueReconcile(): void {
    this.#reconcile = this.#reconcile.then(async () => {
      const desired = this.#config.read();
      const status = await this.#funnel.status();
      const portsChanged = desired.hosting.gatewayPort !== this.#initialGatewayPort || desired.hosting.publicPort !== this.#initialPublicPort;
      if (desired.hosting.enabled && !status.enabled && !portsChanged) await this.#funnel.enable();
      if (!desired.hosting.enabled && status.enabled) await this.#funnel.disable();
      await this.#reconcileStartup(desired.hosting.startAtLogin);
    }).catch(this.#onError);
  }

  async #reconcileStartup(enabled: boolean): Promise<void> {
    const status = await this.#startup.status();
    if (enabled && status.available && !status.configured) await this.#startup.install();
    if (!enabled && status.configured) await this.#startup.remove();
  }
}
