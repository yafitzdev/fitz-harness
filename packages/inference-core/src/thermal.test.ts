import { describe, expect, it, vi } from "vitest";
import type { ResourceSnapshot } from "./resources.js";
import { GpuThermalGuard, ThermalSafetyError } from "./thermal.js";

describe("GpuThermalGuard", () => {
  it("enforces the reduced power envelope before media work and restores it", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(74) }, power);
    const session = guard.start(true);
    await session.regulate();
    await session.close();
    expect(power.setPowerLimit).toHaveBeenNthCalledWith(1, 400);
    expect(power.setPowerLimit).toHaveBeenNthCalledWith(2, 450);
  });

  it("stops at 75C even after enforcing the reduced power envelope", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(75) }, power);
    const session = guard.start(true);
    await expect(session.regulate()).rejects.toThrow("despite the enforced GPU power cap");
    await session.close();
    expect(power.setPowerLimit).toHaveBeenNthCalledWith(1, 400);
    expect(power.setPowerLimit).toHaveBeenNthCalledWith(2, 450);
  });

  it("retains temperature protection when the optional board power cap needs administrator privileges", async () => {
    const power = { setPowerLimit: vi.fn(async () => { throw new Error("insufficient permissions"); }) };
    let temperature = 74;
    const guard = new GpuThermalGuard({ snapshot: async () => snapshot(temperature) }, power);
    const session = guard.start(true);
    await expect(session.regulate()).resolves.toMatchObject({ gpuTemperatureC: 74 });
    temperature = 75;
    await expect(session.regulate()).rejects.toMatchObject({
      name: "ThermalSafetyError",
      message: expect.stringContaining("optional GPU power cap could not be applied"),
    });
    expect(power.setPowerLimit).toHaveBeenCalledOnce();
  });

  it("retains temperature protection when power-limit telemetry is unavailable", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    let temperature = 74;
    const guard = new GpuThermalGuard({ snapshot: async () => ({ ...snapshot(temperature), gpuPowerLimitW: undefined }) }, power);
    const session = guard.start(true);
    await expect(session.regulate()).resolves.toMatchObject({ gpuTemperatureC: 74 });
    temperature = 75;
    await expect(session.regulate()).rejects.toThrow("optional GPU power cap could not be applied");
    expect(power.setPowerLimit).not.toHaveBeenCalled();
  });

  it("does not rewrite a power limit that is already within the envelope", async () => {
    const power = { setPowerLimit: vi.fn(async () => undefined) };
    const guard = new GpuThermalGuard({ snapshot: async () => ({ ...snapshot(74), gpuPowerLimitW: 400 }) }, power);
    const session = guard.start(true);
    await session.regulate();
    await session.close();
    expect(power.setPowerLimit).not.toHaveBeenCalled();
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
