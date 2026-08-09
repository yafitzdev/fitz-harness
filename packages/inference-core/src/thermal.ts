import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResourceMonitor, ResourceSnapshot } from "./resources.js";

const execFileAsync = promisify(execFile);

export interface GpuThermalPolicy {
  throttleAtC: number;
  hardStopAtC: number;
  powerLimitFraction: number;
}

export const DEFAULT_GPU_THERMAL_POLICY: GpuThermalPolicy = {
  throttleAtC: 75,
  hardStopAtC: 82,
  powerLimitFraction: 0.75,
};

export interface GpuPowerController {
  setPowerLimit(watts: number): Promise<void>;
}

export class NvidiaSmiPowerController implements GpuPowerController {
  constructor(readonly executable = "nvidia-smi") {}

  async setPowerLimit(watts: number): Promise<void> {
    await execFileAsync(this.executable, [`--power-limit=${Math.round(watts)}`], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  }
}

export class ThermalSafetyError extends Error {
  constructor(message: string, readonly snapshot: ResourceSnapshot) {
    super(message);
    this.name = "ThermalSafetyError";
  }
}

export class GpuThermalGuard {
  readonly policy: GpuThermalPolicy;

  constructor(
    readonly monitor: ResourceMonitor,
    readonly power: GpuPowerController = new NvidiaSmiPowerController(),
    policy: Partial<GpuThermalPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_GPU_THERMAL_POLICY, ...policy };
  }

  start(enabled: boolean): GpuThermalSession {
    return new GpuThermalSession(this, enabled);
  }
}

export class GpuThermalSession {
  #originalPowerLimitW: number | undefined;
  #powerCapAttempted = false;
  #powerCapActive = false;

  constructor(readonly guard: GpuThermalGuard, readonly enabled: boolean) {}

  async regulate(): Promise<ResourceSnapshot | undefined> {
    if (!this.enabled) return undefined;
    const snapshot = await this.guard.monitor.snapshot();
    const temperature = snapshot.gpuTemperatureC;
    if (temperature !== undefined && temperature >= this.guard.policy.hardStopAtC) {
      throw new ThermalSafetyError(
        `Media generation stopped: GPU reached ${temperature}°C (hard limit ${this.guard.policy.hardStopAtC}°C)`,
        snapshot,
      );
    }
    if (!this.#powerCapAttempted) await this.#acquirePowerCap(snapshot);
    if (temperature !== undefined && temperature >= this.guard.policy.throttleAtC) {
      throw new ThermalSafetyError(
        this.#powerCapActive
          ? `Media generation stopped at ${temperature}°C despite the enforced GPU power cap`
          : `Media generation stopped at ${temperature}°C because the optional GPU power cap could not be applied`,
        snapshot,
      );
    }
    return snapshot;
  }

  async #acquirePowerCap(snapshot: ResourceSnapshot): Promise<void> {
    const current = snapshot.gpuPowerLimitW;
    const minimum = snapshot.gpuMinPowerLimitW;
    const maximum = snapshot.gpuMaxPowerLimitW;
    if (current === undefined || minimum === undefined || maximum === undefined) {
      // Temperature monitoring is still a hard safety boundary on systems that
      // do not expose board power controls (common on laptops and containers).
      this.#powerCapAttempted = true;
      return;
    }
    const target = Math.max(minimum, Math.floor(maximum * this.guard.policy.powerLimitFraction));
    if (current <= target) {
      this.#powerCapAttempted = true;
      this.#powerCapActive = true;
      return;
    }
    this.#originalPowerLimitW = current;
    try {
      await this.guard.power.setPowerLimit(target);
      this.#powerCapAttempted = true;
      this.#powerCapActive = true;
    } catch (error) {
      // Changing the board power limit requires administrator privileges on
      // many Windows drivers. Refusing all local media in that common setup is
      // worse than retaining the independent 75/82°C stop boundaries.
      this.#originalPowerLimitW = undefined;
      this.#powerCapAttempted = true;
      this.#powerCapActive = false;
    }
  }

  async close(): Promise<void> {
    const original = this.#originalPowerLimitW;
    this.#originalPowerLimitW = undefined;
    this.#powerCapAttempted = false;
    this.#powerCapActive = false;
    if (original === undefined) return;
    try { await this.guard.power.setPowerLimit(original); }
    catch { /* Restoration is best-effort; never hide the generation result. */ }
  }
}
