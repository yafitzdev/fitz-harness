import type { AgentEffort } from "./agent.js";
import type { Recipe } from "./domain.js";

export interface ResolvedAgentTopology {
  sharedContextTokens: number;
  orchestratorContextTokens: number;
  workerCount: number;
  workerContextTokens: number;
  totalAllocatedContextTokens: number;
}

/** UI-facing policy for the selected route. Worker counts vary by effort;
 * local worker context may shrink within the product tolerance. */
export interface AgentTopologyPresentation {
  orchestratorContextTokens: number;
  workerContextTokens: number;
  workerCounts: Readonly<Record<AgentEffort, number>>;
}

/** Product-level quality envelope for every self-hosted text engine. Engines
 * may advertise or allocate more context, but Fitz keeps the main agent inside
 * the range where long-horizon agent behavior remains dependable. */
export const LOCAL_MAIN_CONTEXT_TOKENS = 131_072;
export const LOCAL_WORKER_CONTEXT_TOKENS = 32_768;
export const LOCAL_MIN_WORKER_CONTEXT_TOKENS = Math.ceil(LOCAL_WORKER_CONTEXT_TOKENS * 0.9);
export const LOCAL_MAX_CONCURRENT_AGENTS = 3;

/** Resolve a homogeneous local pool from the capacity the loaded engine made
 * available. The adapter owns capacity discovery; this policy is deliberately
 * engine-independent. A recipe's concurrency remains the hard process limit. */
export function resolveLocalAgentTopology(
  recipe: Recipe,
  loadedSharedContextTokens = recipe.contextTokens,
): ResolvedAgentTopology {
  const sharedContextTokens = positiveInteger(loadedSharedContextTokens)
    ? loadedSharedContextTokens
    : recipe.contextTokens;
  const orchestratorContextTokens = Math.min(
    LOCAL_MAIN_CONTEXT_TOKENS,
    recipe.contextTokens,
    sharedContextTokens,
  );
  const remainingContextTokens = Math.max(0, sharedContextTokens - orchestratorContextTokens);
  const maximumWorkerCount = Math.min(
    LOCAL_MAX_CONCURRENT_AGENTS - 1,
    Math.max(0, recipe.capabilities.maxConcurrentGenerations - 1),
  );
  const workerCount = largestWorkerCount(
    remainingContextTokens,
    maximumWorkerCount,
    recipe.contextTokens,
  );
  const workerContextTokens = workerCount > 0
    ? Math.min(LOCAL_WORKER_CONTEXT_TOKENS, Math.floor(remainingContextTokens / workerCount))
    : LOCAL_WORKER_CONTEXT_TOKENS;
  return {
    sharedContextTokens,
    orchestratorContextTokens,
    workerCount,
    workerContextTokens,
    totalAllocatedContextTokens: orchestratorContextTokens + (workerCount * workerContextTokens),
  };
}

function largestWorkerCount(remainingContextTokens: number, maximumWorkerCount: number, modelContextTokens: number): number {
  if (modelContextTokens < LOCAL_MIN_WORKER_CONTEXT_TOKENS) return 0;
  for (let count = maximumWorkerCount; count > 0; count -= 1) {
    if (Math.floor(remainingContextTokens / count) >= LOCAL_MIN_WORKER_CONTEXT_TOKENS) return count;
  }
  return 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
