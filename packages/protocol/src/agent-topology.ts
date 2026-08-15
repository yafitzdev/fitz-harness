import type { Recipe, RecipeAgentTopology, ValidationIssue } from "./domain.js";

export interface ResolvedRecipeAgentTopology {
  sharedContextTokens: number;
  orchestratorContextTokens: number;
  workerCount: number;
  workerContextTokens: number;
  totalAllocatedContextTokens: number;
}

/** Every chat recipe has an implicit main agent. Recipes without an explicit
 * worker pool resolve to the historical single-agent context contract. */
export function resolveRecipeAgentTopology(recipe: Recipe): ResolvedRecipeAgentTopology {
  const topology = recipe.agentTopology;
  if (!topology) {
    return {
      sharedContextTokens: recipe.contextTokens,
      orchestratorContextTokens: recipe.contextTokens,
      workerCount: 0,
      workerContextTokens: 0,
      totalAllocatedContextTokens: recipe.contextTokens,
    };
  }
  const workers = topology.workers.count * topology.workers.contextTokens;
  const orchestratorContextTokens = Math.min(recipe.contextTokens, topology.sharedContextTokens - workers);
  return {
    sharedContextTokens: topology.sharedContextTokens,
    orchestratorContextTokens,
    workerCount: topology.workers.count,
    workerContextTokens: topology.workers.contextTokens,
    totalAllocatedContextTokens: orchestratorContextTokens + workers,
  };
}

export function validateRecipeAgentTopology(recipe: Recipe): ValidationIssue[] {
  const topology = recipe.agentTopology;
  if (!topology) return [];
  const issues: ValidationIssue[] = [];
  if (!recipe.capabilities.chatCompletions || !recipe.capabilities.toolCalls) {
    issues.push({ level: "error", code: "agent_topology_unsupported", message: "Worker pools require chat completions and tool calls" });
  }
  if (!positiveInteger(topology.sharedContextTokens)) {
    issues.push({ level: "error", code: "invalid_shared_context", message: "Shared context tokens must be a positive integer" });
  }
  if (!nonNegativeInteger(topology.workers.count)) {
    issues.push({ level: "error", code: "invalid_worker_count", message: "Worker count must be a non-negative integer" });
  }
  if (!positiveInteger(topology.workers.contextTokens)) {
    issues.push({ level: "error", code: "invalid_worker_context", message: "Worker context tokens must be a positive integer" });
  }
  if (issues.length) return issues;
  if (topology.workers.count + 1 > recipe.capabilities.maxConcurrentGenerations) {
    issues.push({
      level: "error",
      code: "worker_concurrency_exceeded",
      message: `The recipe supports ${recipe.capabilities.maxConcurrentGenerations} concurrent agents, so it can configure at most ${Math.max(0, recipe.capabilities.maxConcurrentGenerations - 1)} workers`,
    });
  }
  if (topology.workers.contextTokens > recipe.contextTokens) {
    issues.push({ level: "error", code: "worker_context_exceeded", message: "Worker context cannot exceed the model's per-agent context limit" });
  }
  const resolved = resolveRecipeAgentTopology(recipe);
  if (resolved.orchestratorContextTokens < 2_048) {
    issues.push({ level: "error", code: "orchestrator_context_exhausted", message: "The worker pool must leave at least 2,048 context tokens for the main agent" });
  }
  return issues;
}

export function recipeWithAgentTopology(
  recipe: Recipe,
  topology: RecipeAgentTopology | undefined,
): Recipe {
  return topology ? { ...recipe, agentTopology: topology } : recipe;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
