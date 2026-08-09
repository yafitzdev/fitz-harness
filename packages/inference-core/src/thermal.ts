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
  powerLimitFraction: 0.8,
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
    if (temperature === undefined) return snapshot;
    if (temperature >= this.guard.policy.hardStopAtC) {
      throw new ThermalSafetyError(
        `Media generation stopped: GPU reached ${temperature}°C (hard limit ${this.guard.policy.hardStopAtC}°C)`,
        snapshot,
      );
    }
    if (temperature < this.guard.policy.throttleAtC || this.#throttled) return snapshot;

    const current = snapshot.gpuPowerLimitW;
    const minimum = snapshot.gpuMinPowerLimitW;
    if (current === undefined || minimum === undefined) {
      throw new ThermalSafetyError(
        `Media generation stopped at ${temperature}°C because the GPU power-limit range is unavailable`,
        snapshot,
      );
    }
    const target = Math.max(minimum, Math.floor(current * this.guard.policy.powerLimitFraction));
    this.#originalPowerLimitW = current;
    try {
      await this.guard.power.setPowerLimit(target);
      this.#throttled = true;
    } catch (error) {
      this.#originalPowerLimitW = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ThermalSafetyError(
        `Media generation stopped at ${temperature}°C: Fitz could not lower the GPU power limit (${detail})`,
        snapshot,
      );
    }
    return snapshot;
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
