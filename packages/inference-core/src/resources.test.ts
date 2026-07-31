import type { Recipe } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import {
  ResourceBudgetError,
  ResourceGovernor,
  type ResourceMonitor,
  type ResourceSnapshot,
} from "./resources.js";

describe("ResourceGovernor", () => {
  it("preserves the configured VRAM reserve", async () => {
    const governor = new ResourceGovernor(monitor({ freeVramMiB: 2_000 }), {
      reserveVramMiB: 2_048,
      minimumFreeRamMiB: 1_024,
    });
    await expect(governor.assertCanLoad(recipe(), { vramMiB: 0 })).rejects.toBeInstanceOf(
      ResourceBudgetError,
    );
  });

  it("rejects estimates that exceed VRAM remaining after reserve", async () => {
    const governor = new ResourceGovernor(monitor({ freeVramMiB: 20_000 }), {
      reserveVramMiB: 2_048,
      minimumFreeRamMiB: 1_024,
    });
    await expect(governor.assertCanLoad(recipe(), { vramMiB: 18_000 })).rejects.toThrow(
      "exceeds 17952 MiB available after reserve",
    );
  });

  it("allows a load when RAM, VRAM, and telemetry policy pass", async () => {
    const snapshot = baseSnapshot({ freeVramMiB: 25_000 });
    const governor = new ResourceGovernor({ snapshot: async () => snapshot }, {
      reserveVramMiB: 2_048,
      minimumFreeRamMiB: 1_024,
      requireGpuTelemetry: true,
    });
    await expect(governor.assertCanLoad(recipe(), { vramMiB: 20_000 })).resolves.toBe(snapshot);
  });
});

function monitor(overrides: Partial<ResourceSnapshot>): ResourceMonitor {
  return { snapshot: async () => baseSnapshot(overrides) };
}

function baseSnapshot(overrides: Partial<ResourceSnapshot>): ResourceSnapshot {
  return {
    capturedAt: new Date(0).toISOString(),
    totalRamMiB: 64_000,
    freeRamMiB: 32_000,
    totalVramMiB: 32_000,
    usedVramMiB: 7_000,
    gpuTelemetryAvailable: true,
    ...overrides,
  };
}

function recipe(): Recipe {
  return {
    id: "resource-test",
    playbookId: "fake",
    displayName: "Resource Test",
    adapter: "fake",
    modelId: "resource-test",
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 60,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}
