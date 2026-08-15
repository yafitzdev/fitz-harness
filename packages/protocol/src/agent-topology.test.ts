import { describe, expect, it } from "vitest";
import type { Recipe } from "./domain.js";
import { resolveLocalAgentTopology } from "./agent-topology.js";

describe("recipe agent topology", () => {
  it("derives every local pool from the 131k main and 32k worker policy", () => {
    expect(resolveLocalAgentTopology(fixture(), 196_608)).toEqual({
      sharedContextTokens: 196_608,
      orchestratorContextTokens: 131_072,
      workerCount: 2,
      workerContextTokens: 32_768,
      totalAllocatedContextTokens: 196_608,
    });
    expect(resolveLocalAgentTopology(fixture(), 150_000)).toMatchObject({
      orchestratorContextTokens: 131_072,
      workerCount: 0,
    });
  });

  it("fits an additional worker by reducing every worker window by at most ten percent", () => {
    expect(resolveLocalAgentTopology(fixture(), 192_000)).toEqual({
      sharedContextTokens: 192_000,
      orchestratorContextTokens: 131_072,
      workerCount: 2,
      workerContextTokens: 30_464,
      totalAllocatedContextTokens: 192_000,
    });
    expect(resolveLocalAgentTopology(fixture(), 190_056)).toMatchObject({
      workerCount: 2,
      workerContextTokens: 29_492,
    });
    expect(resolveLocalAgentTopology(fixture(), 190_055)).toMatchObject({
      workerCount: 1,
      workerContextTokens: 32_768,
    });
  });

  it("uses technical model context only as a safety ceiling and capacity fallback", () => {
    const limited = fixture(100_000);
    expect(resolveLocalAgentTopology(limited, 272_320)).toMatchObject({ orchestratorContextTokens: 100_000, workerCount: 2 });
    expect(resolveLocalAgentTopology(limited)).toMatchObject({ sharedContextTokens: 100_000, orchestratorContextTokens: 100_000, workerCount: 0 });
  });
});

function fixture(contextTokens = 262_144): Recipe {
  return {
    id: "qwen", playbookId: "ninfer", displayName: "Qwen", adapter: "ninfer", modelId: "qwen", contextTokens,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: {},
  };
}
