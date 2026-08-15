import { describe, expect, it } from "vitest";
import type { Recipe } from "./domain.js";
import { resolveRecipeAgentTopology, validateRecipeAgentTopology } from "./agent-topology.js";

describe("recipe agent topology", () => {
  it("derives the implicit main context from the shared pool and anonymous workers", () => {
    const recipe = fixture({ sharedContextTokens: 272_320, workers: { count: 2, contextTokens: 32_000 } });
    expect(resolveRecipeAgentTopology(recipe)).toEqual({
      capacityMode: "shared",
      sharedContextTokens: 272_320,
      orchestratorContextTokens: 208_320,
      workerCount: 2,
      workerContextTokens: 32_000,
      totalAllocatedContextTokens: 272_320,
    });
    expect(validateRecipeAgentTopology(recipe)).toEqual([]);
  });

  it("keeps cloud request contexts independent", () => {
    const recipe = fixture({ capacityMode: "independent", sharedContextTokens: 262_144, workers: { count: 2, contextTokens: 64_000 } });
    expect(resolveRecipeAgentTopology(recipe)).toMatchObject({
      capacityMode: "independent",
      orchestratorContextTokens: 262_144,
      workerCount: 2,
      totalAllocatedContextTokens: 390_144,
    });
    expect(validateRecipeAgentTopology(recipe)).toEqual([]);
  });

  it("caps the main at the model limit and rejects pools that exhaust it", () => {
    expect(resolveRecipeAgentTopology(fixture({ sharedContextTokens: 400_000, workers: { count: 1, contextTokens: 32_000 } })).orchestratorContextTokens).toBe(262_144);
    expect(validateRecipeAgentTopology(fixture({ sharedContextTokens: 64_000, workers: { count: 2, contextTokens: 32_000 } }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "orchestrator_context_exhausted" }),
    ]));
  });

  it("keeps recipes without workers on the single-agent contract", () => {
    const recipe = fixture(undefined);
    expect(resolveRecipeAgentTopology(recipe)).toMatchObject({ orchestratorContextTokens: 262_144, workerCount: 0 });
    expect(validateRecipeAgentTopology(recipe)).toEqual([]);
  });
});

function fixture(agentTopology: Recipe["agentTopology"]): Recipe {
  return {
    id: "qwen", playbookId: "ninfer", displayName: "Qwen", adapter: "ninfer", modelId: "qwen", contextTokens: 262_144,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: {},
    ...(agentTopology ? { agentTopology } : {}),
  };
}
