import type { ResourceMonitor, ResourceSnapshot } from "./resources.js";

export interface GpuThermalPolicy {
  /** Last-resort protection only. Normal load shaping belongs to the engine
   * adapter and must not depend on privileged board controls. The stop sits
   * at 92 C, inside the firmware throttle band (88-90 C), so it only fires
   * if the engine-side pacing extension is missing or broken. */
  hardStopAtC: number;
}

export const DEFAULT_GPU_THERMAL_POLICY: GpuThermalPolicy = {
  hardStopAtC: 92,
};

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
    policy: Partial<GpuThermalPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_GPU_THERMAL_POLICY, ...policy };
  }

  start(enabled: boolean): GpuThermalSession {
    return new GpuThermalSession(this, enabled);
  }
}

export class GpuThermalSession {
  constructor(readonly guard: GpuThermalGuard, readonly enabled: boolean) {}

  async regulate(): Promise<ResourceSnapshot | undefined> {
    if (!this.enabled) return undefined;
    const snapshot = await this.guard.monitor.snapshot();
    const temperature = snapshot.gpuTemperatureC;
    if (temperature !== undefined && temperature >= this.guard.policy.hardStopAtC) {
      throw new ThermalSafetyError(
        `Media generation stopped: GPU reached ${temperature}°C (emergency limit ${this.guard.policy.hardStopAtC}°C)`,
        snapshot,
      );
    }
    return snapshot;
  }

  async close(): Promise<void> {
    // Engine adapters own cooperative load shaping. There is no global board
    // state to restore, and Fitz never invokes privileged nvidia-smi controls.
  }
}
