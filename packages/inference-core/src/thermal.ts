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
  #throttled = false;

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
    if (!this.#throttled) await this.#acquirePowerCap(snapshot);
    if (temperature !== undefined && temperature >= this.guard.policy.throttleAtC) {
      throw new ThermalSafetyError(
        `Media generation stopped at ${temperature}°C despite the enforced GPU power cap`,
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
      throw new ThermalSafetyError(
        "Media generation refused because the GPU power-limit range is unavailable",
        snapshot,
      );
    }
    const target = Math.max(minimum, Math.floor(maximum * this.guard.policy.powerLimitFraction));
    if (current <= target) {
      this.#throttled = true;
      return;
    }
    this.#originalPowerLimitW = current;
    try {
      await this.guard.power.setPowerLimit(target);
      this.#throttled = true;
    } catch (error) {
      this.#originalPowerLimitW = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ThermalSafetyError(
        `Media generation refused because Fitz could not enforce the GPU power cap (${detail})`,
        snapshot,
      );
    }
  }

  async close(): Promise<void> {
    const original = this.#originalPowerLimitW;
    this.#originalPowerLimitW = undefined;
    this.#throttled = false;
    if (original === undefined) return;
    try { await this.guard.power.setPowerLimit(original); }
    catch { /* Restoration is best-effort; never hide the generation result. */ }
  }
}
