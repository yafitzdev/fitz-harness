import type { SqliteStore } from "@fitz/storage";

/**
 * Context window (tokens) of the recipe the given route currently resolves to.
 * The pi agent session is created with this window so the SDK's in-run context
 * management matches the recipe the app budgets and the meter displays.
 * Falls back to the pi SDK default when the route or recipe is unknown.
 */
export function contextTokensForRoute(store: SqliteStore, routeId: string): number {
  const route = store.listRoutes().find((candidate) => candidate.id === routeId);
  const recipe = route ? store.listRecipes().find((candidate) => candidate.id === route.recipeId) : undefined;
  return recipe?.contextTokens ?? 100_000;
}
