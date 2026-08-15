import { resolveRecipeAgentTopology, validateRecipeAgentTopology, type Recipe } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";

export interface LocalAgentTopology {
  recipe: Recipe;
  sharedContextTokens: number;
  orchestratorContextTokens: number;
  workerContextTokens: number;
  maxWorkers: number;
}

/** Reads the anonymous worker pool owned by the selected local Default recipe.
 * The main agent is implicit and receives the shared-context remainder. */
export function localAgentTopology(store: SqliteStore): LocalAgentTopology | undefined {
  const route = store.listRoutes().find((candidate) => candidate.id === "default" && candidate.enabled);
  const recipe = route ? store.listRecipes().find((candidate) => candidate.id === route.recipeId) : undefined;
  if (!recipe?.agentTopology || validateRecipeAgentTopology(recipe).some((issue) => issue.level === "error")) return undefined;
  const resolved = resolveRecipeAgentTopology(recipe);
  if (resolved.workerCount < 1) return undefined;
  return {
    recipe,
    sharedContextTokens: resolved.sharedContextTokens,
    orchestratorContextTokens: resolved.orchestratorContextTokens,
    workerContextTokens: resolved.workerContextTokens,
    maxWorkers: resolved.workerCount,
  };
}
