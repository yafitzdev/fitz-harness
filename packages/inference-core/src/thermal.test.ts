import { describe, expect, it, vi } from "vitest";
import type { ResourceSnapshot } from "./resources.js";
import { GpuThermalGuard, ThermalSafetyError } from "./thermal.js";

describe("GpuThermalGuard", () => {
  it("allows normal media work below the emergency boundary", async () => {
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(84) });
    await expect(guard.start(true).regulate()).resolves.toMatchObject({ gpuTemperatureC: 84 });
  });

  it("hard-stops an overheated local GPU", async () => {
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(85) });
    await expect(guard.start(true).regulate()).rejects.toMatchObject({
      name: "ThermalSafetyError",
      message: "Media generation stopped: GPU reached 85°C (emergency limit 85°C)",
    });
    await expect(guard.start(true).regulate()).rejects.toBeInstanceOf(ThermalSafetyError);
  });

  it("does not inspect local telemetry for remote media providers", async () => {
    const monitor = { snapshot: vi.fn(async () => snapshot(90)) };
    const guard = new GpuThermalGuard(monitor);
    await guard.start(false).regulate();
    expect(monitor.snapshot).not.toHaveBeenCalled();
  });
});

function snapshot(temperature: number): ResourceSnapshot {
  return {
    capturedAt: new Date(0).toISOString(),
    totalRamMiB: 64_000,
    freeRamMiB: 32_000,
    totalVramMiB: 32_000,
    usedVramMiB: 1_000,
    freeVramMiB: 31_000,
    gpuTelemetryAvailable: true,
    gpuTemperatureC: temperature,
  };
}
