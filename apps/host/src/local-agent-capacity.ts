import type { Recipe, RecipeAgentTopology } from "@fitz/protocol";
import { compileRecipeAgentTopology } from "./recipe-agent-topology.js";

/** Host-wide local inference capacity. The scheduler has three GPU lanes, so
 * every tool-capable local chat engine exposes one main agent plus two workers. */
export const LOCAL_AGENT_MAX_CONCURRENCY = 3;

export function withLocalAgentCapacity(recipe: Recipe, preservedTopology?: RecipeAgentTopology): Recipe {
  if (!recipe.capabilities.chatCompletions || !recipe.capabilities.toolCalls) return recipe;
  const agentTopology = preservedTopology ?? recipe.agentTopology ?? defaultLocalAgentTopology(recipe.contextTokens);
  return compileRecipeAgentTopology({
    ...recipe,
    capabilities: { ...recipe.capabilities, maxConcurrentGenerations: LOCAL_AGENT_MAX_CONCURRENCY },
    agentTopology,
  });
}

export function defaultLocalAgentTopology(sharedContextTokens: number): RecipeAgentTopology {
  const workerContextTokens = Math.max(2_048, Math.min(32_000, Math.floor((sharedContextTokens - 2_048) / 2)));
  return { sharedContextTokens, workers: { count: 0, contextTokens: workerContextTokens } };
}
