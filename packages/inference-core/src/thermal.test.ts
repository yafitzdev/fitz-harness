import { describe, expect, it, vi } from "vitest";
import type { ResourceSnapshot } from "./resources.js";
import { GpuThermalGuard, ThermalSafetyError } from "./thermal.js";

describe("GpuThermalGuard", () => {
  it("does nothing below 75C", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(74) }, power);
    const session = guard.start(true);
    await session.regulate();
    await session.close();
    expect(power.setPowerLimit).not.toHaveBeenCalled();
  });

  it("caps power at 75C and restores the original limit", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(75) }, power);
    const session = guard.start(true);
    await session.regulate();
    await session.regulate();
    await session.close();
    expect(power.setPowerLimit).toHaveBeenNthCalledWith(1, 400);
    expect(power.setPowerLimit).toHaveBeenNthCalledWith(2, 450);
  });

  it("fails safe when the host cannot apply the thermal power cap", async () => {
    const power = { setPowerLimit: vi.fn(async () => { throw new Error("insufficient permissions"); }) };
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(76) }, power);
    await expect(guard.start(true).regulate()).rejects.toMatchObject({
      name: "ThermalSafetyError",
      message: expect.stringContaining("could not lower the GPU power limit"),
    });
  });

  it("hard-stops an overheated GPU even after throttling would be possible", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(82) }, power);
    await expect(guard.start(true).regulate()).rejects.toBeInstanceOf(ThermalSafetyError);
    expect(power.setPowerLimit).not.toHaveBeenCalled();
  });

  it("does not inspect local telemetry for remote media providers", async () => {
    const monitor = { snapshot: vi.fn(async () => snapshot(90)) };
    const guard = new GpuThermalGuard(monitor, { setPowerLimit: vi.fn(async () => undefined) });
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
    gpuPowerLimitW: 450,
    gpuMinPowerLimitW: 400,
    gpuMaxPowerLimitW: 450,
  };
}
