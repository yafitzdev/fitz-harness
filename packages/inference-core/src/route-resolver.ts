import type { Recipe, Route } from "@fitz/protocol";

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

  constructor(routes: Route[] = [], recipes: Recipe[] = []) {
    for (const recipe of recipes) this.upsertRecipe(recipe);
    for (const route of routes) this.upsertRoute(route);
  }

  upsertRecipe(recipe: Recipe): void {
    this.#recipes.set(recipe.id, structuredClone(recipe));
  }

  upsertRoute(route: Route): void {
    this.#routes.set(route.id, structuredClone(route));
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
    return { route: structuredClone(route), recipe: structuredClone(recipe) };
  }

  resolveRecipe(recipeId: string): Recipe {
    const recipe = this.#recipes.get(recipeId);
    if (!recipe) throw new RecipeNotFoundError(recipeId);
    return structuredClone(recipe);
  }

  listRoutes(): Route[] {
    return [...this.#routes.values()]
      .filter((route) => route.enabled)
      .map((route) => structuredClone(route));
  }

  listRecipes(): Recipe[] {
    return [...this.#recipes.values()].map((recipe) => structuredClone(recipe));
  }
}
