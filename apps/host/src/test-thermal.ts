import { GpuThermalGuard } from "@fitz/inference-core";

/** GPU-safe deterministic emergency guard for fixture/in-process media tests.
 * Production never imports this module. */
export function testThermalGuard(): GpuThermalGuard {
  return new GpuThermalGuard({
    snapshot: async () => ({
      capturedAt: new Date(0).toISOString(),
      totalRamMiB: 64_000,
      freeRamMiB: 48_000,
      totalVramMiB: 32_000,
      usedVramMiB: 0,
      freeVramMiB: 32_000,
      gpuTelemetryAvailable: true,
      gpuTemperatureC: 50,
      gpuPowerLimitW: 400,
      gpuMinPowerLimitW: 400,
      gpuMaxPowerLimitW: 450,
    }),
  });
}
