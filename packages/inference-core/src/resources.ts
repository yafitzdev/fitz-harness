import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import type { Recipe, ResourceEstimate } from "@fitz/protocol";

const execFileAsync = promisify(execFile);

export interface ResourceSnapshot {
  capturedAt: string;
  totalRamMiB: number;
  freeRamMiB: number;
  totalVramMiB?: number;
  usedVramMiB?: number;
  freeVramMiB?: number;
  gpuTemperatureC?: number;
  gpuPowerDrawW?: number;
  gpuPowerLimitW?: number;
  gpuMinPowerLimitW?: number;
  gpuMaxPowerLimitW?: number;
  gpuTelemetryAvailable: boolean;
}

export interface ResourceMonitor {
  snapshot(): Promise<ResourceSnapshot>;
}

export interface ResourcePolicy {
  reserveVramMiB: number;
  minimumFreeRamMiB: number;
  requireGpuTelemetry: boolean;
}

export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = {
  reserveVramMiB: 2_048,
  minimumFreeRamMiB: 4_096,
  requireGpuTelemetry: false,
};

export class ResourceBudgetError extends Error {
  constructor(
    message: string,
    readonly snapshot: ResourceSnapshot,
    readonly estimate: ResourceEstimate,
  ) {
    super(message);
    this.name = "ResourceBudgetError";
  }
}

export class ResourceGovernor {
  readonly policy: ResourcePolicy;

  constructor(
    readonly monitor: ResourceMonitor,
    policy: Partial<ResourcePolicy> = {},
  ) {
    this.policy = { ...DEFAULT_RESOURCE_POLICY, ...policy };
  }

  snapshot(): Promise<ResourceSnapshot> {
    return this.monitor.snapshot();
  }

  async assertCanLoad(recipe: Recipe, estimate: ResourceEstimate): Promise<ResourceSnapshot> {
    const snapshot = await this.monitor.snapshot();
    if (snapshot.freeRamMiB < this.policy.minimumFreeRamMiB) {
      throw new ResourceBudgetError(
        `Refusing to load ${recipe.id}: ${snapshot.freeRamMiB} MiB free RAM is below the ${this.policy.minimumFreeRamMiB} MiB minimum`,
        snapshot,
        estimate,
      );
    }
    if (this.policy.requireGpuTelemetry && snapshot.freeVramMiB === undefined) {
      throw new ResourceBudgetError(
        `Refusing to load ${recipe.id}: GPU memory telemetry is required but unavailable`,
        snapshot,
        estimate,
      );
    }
    if (snapshot.freeVramMiB !== undefined) {
      const usableVramMiB = snapshot.freeVramMiB - this.policy.reserveVramMiB;
      if (usableVramMiB < 0) {
        throw new ResourceBudgetError(
          `Refusing to load ${recipe.id}: the ${this.policy.reserveVramMiB} MiB VRAM reserve cannot be maintained`,
          snapshot,
          estimate,
        );
      }
      if (estimate.vramMiB !== undefined && estimate.vramMiB > usableVramMiB) {
        throw new ResourceBudgetError(
          `Refusing to load ${recipe.id}: estimated ${estimate.vramMiB} MiB VRAM exceeds ${usableVramMiB} MiB available after reserve`,
          snapshot,
          estimate,
        );
      }
    }
    return snapshot;
  }
}

export class SystemResourceMonitor implements ResourceMonitor {
  constructor(readonly nvidiaSmiExecutable = "nvidia-smi") {}

  async snapshot(): Promise<ResourceSnapshot> {
    const memory = {
      capturedAt: new Date().toISOString(),
      totalRamMiB: bytesToMiB(totalmem()),
      freeRamMiB: bytesToMiB(freemem()),
    };
    try {
      const stdout = await this.#query("memory.total,memory.used,memory.free,temperature.gpu,power.draw,power.limit,power.min_limit,power.max_limit")
        .catch(() => this.#query("memory.total,memory.used,memory.free"));
      const firstGpu = stdout.trim().split(/\r?\n/, 1)[0];
      if (!firstGpu) throw new Error("nvidia-smi returned no GPU rows");
      const [total, used, free, temperature, powerDraw, powerLimit, minPowerLimit, maxPowerLimit] = firstGpu.split(",").map((value) => Number.parseFloat(value.trim()));
      if (![total, used, free].every(Number.isFinite)) {
        throw new Error(`Could not parse nvidia-smi output: ${firstGpu}`);
      }
      return {
        ...memory,
        totalVramMiB: total!,
        usedVramMiB: used!,
        freeVramMiB: free!,
        ...(Number.isFinite(temperature) ? { gpuTemperatureC: temperature } : {}),
        ...(Number.isFinite(powerDraw) ? { gpuPowerDrawW: powerDraw } : {}),
        ...(Number.isFinite(powerLimit) ? { gpuPowerLimitW: powerLimit } : {}),
        ...(Number.isFinite(minPowerLimit) ? { gpuMinPowerLimitW: minPowerLimit } : {}),
        ...(Number.isFinite(maxPowerLimit) ? { gpuMaxPowerLimitW: maxPowerLimit } : {}),
        gpuTelemetryAvailable: true,
      };
    } catch {
      return { ...memory, gpuTelemetryAvailable: false };
    }
  }

  async #query(fields: string): Promise<string> {
    const { stdout } = await execFileAsync(
      this.nvidiaSmiExecutable,
      [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"],
      { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    return stdout;
  }
}

function bytesToMiB(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}
