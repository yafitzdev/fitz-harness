import type { Recipe, Route } from "@fitz/protocol";
import type { ManagementConfiguration } from "../../management-configuration.js";

export type TextRouteConfiguration = Pick<ManagementConfiguration, "routes" | "recipes" | "cloudRoutes">;

export type TextRouteId = "default" | "fast" | "smart";
export type CloudTextRouteId = Exclude<TextRouteId, "default">;

export interface TextRouteDefinition<T extends TextRouteId = TextRouteId> {
  id: T;
  label: string;
  ownership: "host" | "consumer";
}

/**
 * The single presentation contract for text roles. Connections and the chat
 * composer consume this same ordered list so labels and ordering cannot drift.
 */
export const TEXT_ROUTE_DEFINITIONS: readonly TextRouteDefinition[] = [
  { id: "default", label: "Local", ownership: "host" },
  { id: "fast", label: "Fast", ownership: "consumer" },
  { id: "smart", label: "Smart", ownership: "consumer" },
];

export const CLOUD_TEXT_ROUTE_DEFINITIONS = TEXT_ROUTE_DEFINITIONS.filter(
  (definition): definition is TextRouteDefinition<CloudTextRouteId> => definition.ownership === "consumer",
);

export interface TextRouteOption {
  id: TextRouteId;
  label: string;
  displayName: string;
  group: "Routes";
}

/** Resolves a role through its real owner: Local through host routes, cloud
 * roles through the consumer-owned binding map. The routes fallback supports
 * the public configuration response, which also materializes resolved roles. */
export function textRouteRecipeId(configuration: TextRouteConfiguration | undefined, routeId: TextRouteId): string | undefined {
  const cloudRecipeId = routeId === "default" ? undefined : configuration?.cloudRoutes?.[routeId];
  if (typeof cloudRecipeId === "string" && cloudRecipeId) return cloudRecipeId;
  const route = (configuration?.routes ?? []).find((candidate: Route) => candidate.id === routeId && candidate.enabled !== false);
  return typeof route?.recipeId === "string" && route.recipeId ? route.recipeId : undefined;
}

export function textRouteRecipe(configuration: TextRouteConfiguration | undefined, routeId: TextRouteId): Recipe | undefined {
  const recipeId = textRouteRecipeId(configuration, routeId);
  return recipeId ? (configuration?.recipes ?? []).find((candidate: Recipe) => candidate.id === recipeId) : undefined;
}

/** Builds every configured chat choice, including the concrete model name. */
export function textRouteOptions(configuration: TextRouteConfiguration | undefined): TextRouteOption[] {
  return TEXT_ROUTE_DEFINITIONS.flatMap((definition) => {
    const recipe = textRouteRecipe(configuration, definition.id);
    if (!recipe) return [];
    const modelName = String(recipe.displayName ?? recipe.modelId ?? recipe.id).trim();
    return [{
      id: definition.id,
      label: modelName ? `${definition.label} · ${modelName}` : definition.label,
      displayName: definition.label,
      group: "Routes" as const,
    }];
  });
}
