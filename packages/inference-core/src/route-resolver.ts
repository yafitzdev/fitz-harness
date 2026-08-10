import type { EnginePerformanceMode, Recipe, Route } from "@fitz/protocol";

export class RouteNotFoundError extends Error {
  constructor(readonly routeId: string) {
    super(`Unknown or disabled route: ${routeId}`);
    this.name = "RouteNotFoundError";
  }
}

export class RecipeNotFoundError extends Error {
  constructor(readonly recipeId: string) {
    super(`Recipe not found: ${recipeId}`);
    this.name = "RecipeNotFoundError";
  }
}

export interface ResolvedRoute {
  route: Route;
  recipe: Recipe;
}

export class RouteResolver {
  readonly #routes = new Map<string, Route>();
  readonly #recipes = new Map<string, Recipe>();
  readonly #performanceModes = new Map<string, EnginePerformanceMode>();

  constructor(routes: Route[] = [], recipes: Recipe[] = [], performanceModes: ReadonlyMap<string, EnginePerformanceMode> = new Map()) {
    for (const recipe of recipes) this.upsertRecipe(recipe);
    for (const route of routes) this.upsertRoute(route);
    for (const [playbookId, mode] of performanceModes) this.setEnginePerformanceMode(playbookId, mode);
  }

  upsertRecipe(recipe: Recipe): void {
    this.#recipes.set(recipe.id, structuredClone(recipe));
  }

  upsertRoute(route: Route): void {
    this.#routes.set(route.id, structuredClone(route));
  }

  setEnginePerformanceMode(playbookId: string, mode: EnginePerformanceMode): void {
    this.#performanceModes.set(playbookId.toLowerCase(), mode);
  }

  deleteRoute(routeId: string): void {
    this.#routes.delete(routeId);
  }

  deleteRecipe(recipeId: string): void {
    this.#recipes.delete(recipeId);
  }

  resolve(routeId: string): ResolvedRoute {
    const route = this.#routes.get(routeId);
    if (!route?.enabled) throw new RouteNotFoundError(routeId);
    const recipe = this.#recipes.get(route.recipeId);
    if (!recipe) throw new RecipeNotFoundError(route.recipeId);
    return { route: structuredClone(route), recipe: this.#resolvedRecipe(recipe) };
  }

  resolveRecipe(recipeId: string): Recipe {
    const recipe = this.#recipes.get(recipeId);
    if (!recipe) throw new RecipeNotFoundError(recipeId);
    return this.#resolvedRecipe(recipe);
  }

  listRoutes(includeDisabled = false): Route[] {
    return [...this.#routes.values()]
      .filter((route) => includeDisabled || route.enabled)
      .map((route) => structuredClone(route));
  }

  listRecipes(): Recipe[] {
    return [...this.#recipes.values()].map((recipe) => structuredClone(recipe));
  }

  #resolvedRecipe(recipe: Recipe): Recipe {
    const mode = this.#performanceModes.get(recipe.playbookId.toLowerCase()) ?? "normal";
    return { ...structuredClone(recipe), configuration: { ...structuredClone(recipe.configuration), performanceMode: mode } };
  }
}
