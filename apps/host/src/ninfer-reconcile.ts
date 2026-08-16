import type { SqliteStore } from "@fitz/storage";
import type { Recipe } from "@fitz/protocol";
import { createNInferPlaybook, QWEN36_35B_RECIPE_ID, QWEN38_ORCHESTRATOR_RECIPE_ID } from "./ninfer-playbook.js";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";

/** Well-known media route ids created by `ensureMediaRoutes` (model-management-routes.ts).
 *  The ninfer boot reconcile deletes every route that is not a consumer route or
 *  a ninfer template; without this exemption the image/video/audio routes would
 *  be wiped at every boot and assignments lost (§5.2). */
const NINFER_MEDIA_ROUTE_EXEMPTIONS = new Set(["image", "video", "audio"]);
const RETIRED_NINFER_RECIPES = new Map([
  ["qwen38-27b-mtp3-16k-vision-c2", QWEN38_ORCHESTRATOR_RECIPE_ID],
  ["qwen38-27b-mtp3-128k-vision-c3", QWEN38_ORCHESTRATOR_RECIPE_ID],
  ["qwen36-27b-mtp3-100k", QWEN36_35B_RECIPE_ID],
]);

/** Runs before `createHost()` in ninfer mode: additively materializes current
 * recipes, refreshes their canonical configuration, migrates explicitly retired
 * recipe ids, and prunes routes outside the current route contract. */
export function reconcileNInferConfiguration(store: SqliteStore, runtime: NInferRuntimeLayout): void {
  const playbook = createNInferPlaybook(runtime);
  const existingRecipes = store.listRecipes();
  for (const template of playbook.recipes) {
    const persisted = existingRecipes.find((recipe) => recipe.id === template.id);
    const existing = persisted ? withoutLegacyAgentTopology(persisted) : undefined;
    if (!existing) {
      store.upsertRecipe(template);
      continue;
    }
    if (existing.adapter !== "ninfer") continue;
    const {
      runtimeDistribution: _discardedDistribution,
      workerContextTokens: _legacyWorkerContext,
      maxLocalWorkers: _legacyWorkerCount,
      ...currentConfiguration
    } = existing.configuration;
    store.upsertRecipe({
      ...existing,
      playbookId: template.playbookId,
      displayName: existing.displayName,
      adapter: template.adapter,
      modelId: template.modelId,
      contextTokens: template.contextTokens,
      capabilities: template.capabilities,
      lifecycle: template.lifecycle,
      configuration: { ...currentConfiguration, ...template.configuration },
    });
  }
  const templates = playbook.routes;
  const existingRoutes = store.listRoutes();
  const existingById = new Map(existingRoutes.map((route) => [route.id, route]));
  const recipeIds = new Set([...store.listRecipes(), ...playbook.recipes].map((recipe) => recipe.id));
  for (const route of existingRoutes) {
    if (!route.id.startsWith("consumer--") && !NINFER_MEDIA_ROUTE_EXEMPTIONS.has(route.id) && !templates.some((template) => template.id === route.id)) store.deleteRoute(route.id);
  }
  for (const template of templates) {
    const existing = existingById.get(template.id);
    const selectedRecipeId = existing ? (RETIRED_NINFER_RECIPES.get(existing.recipeId) ?? existing.recipeId) : undefined;
    const recipeId = selectedRecipeId && recipeIds.has(selectedRecipeId) ? selectedRecipeId : template.recipeId;
    store.upsertRoute({ ...template, recipeId });
  }
  const referencedRecipeIds = new Set(store.listRoutes().map((route) => route.recipeId));
  for (const retiredRecipeId of RETIRED_NINFER_RECIPES.keys()) {
    if (!referencedRecipeIds.has(retiredRecipeId)) store.deleteRecipe(retiredRecipeId);
  }
}

function withoutLegacyAgentTopology(recipe: Recipe): Recipe {
  const { agentTopology: _legacy, ...current } = recipe as Recipe & { agentTopology?: unknown };
  return current;
}
