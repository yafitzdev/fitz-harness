import { GpuThermalGuard } from "@fitz/inference-core";

/** GPU-safe deterministic thermal guard for fixture/in-process media tests.
 * Production never imports this module. The reported card is already at the
 * enforced envelope, so no real NVIDIA command can be issued by a test. */
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
