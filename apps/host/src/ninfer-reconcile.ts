import type { SqliteStore } from "@fitz/storage";
import { createNInferPlaybook, QWEN38_ORCHESTRATOR_RECIPE_ID } from "./ninfer-playbook.js";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";
import { compileRecipeAgentTopology } from "./recipe-agent-topology.js";

/** Well-known media route ids created by `ensureMediaRoutes` (model-management-routes.ts).
 *  The ninfer boot reconcile deletes every route that is not a consumer route or
 *  a ninfer template; without this exemption the image/video/audio routes would
 *  be wiped at every boot and assignments lost (§5.2). */
const NINFER_MEDIA_ROUTE_EXEMPTIONS = new Set(["image", "video", "audio"]);
const RETIRED_NINFER_RECIPES = new Map([
  ["qwen38-27b-mtp3-16k-vision-c2", QWEN38_ORCHESTRATOR_RECIPE_ID],
  ["qwen38-27b-mtp3-128k-vision-c3", QWEN38_ORCHESTRATOR_RECIPE_ID],
]);

/** Runs before `createHost()` in ninfer mode: additively materializes current
 * recipes, refreshes their canonical configuration, migrates explicitly retired
 * recipe ids, and prunes routes outside the current route contract. */
export function reconcileNInferConfiguration(store: SqliteStore, runtime: NInferRuntimeLayout): void {
  const playbook = createNInferPlaybook(runtime);
  const existingRecipes = store.listRecipes();
  for (const template of playbook.recipes) {
    const existing = existingRecipes.find((recipe) => recipe.id === template.id);
    if (!existing) {
      store.upsertRecipe(template);
      continue;
    }
    if (existing.adapter !== "ninfer") continue;
    const {
      runtimeDistribution: _discardedDistribution,
      workerContextTokens: legacyWorkerContext,
      maxLocalWorkers: legacyWorkerCount,
      ...currentConfiguration
    } = existing.configuration;
    const migratedLegacyWorkers = Number.isSafeInteger(legacyWorkerCount) && Number(legacyWorkerCount) >= 0
      && Number.isSafeInteger(legacyWorkerContext) && Number(legacyWorkerContext) > 0
      ? { count: Number(legacyWorkerCount), contextTokens: Number(legacyWorkerContext) }
      : undefined;
    const agentTopology = template.agentTopology
      ? {
          sharedContextTokens: template.agentTopology.sharedContextTokens,
          workers: existing.agentTopology?.workers ?? migratedLegacyWorkers ?? template.agentTopology.workers,
        }
      : existing.agentTopology;
    store.upsertRecipe(compileRecipeAgentTopology({
      ...existing,
      playbookId: template.playbookId,
      displayName: existing.displayName,
      adapter: template.adapter,
      modelId: template.modelId,
      contextTokens: template.contextTokens,
      capabilities: template.capabilities,
      lifecycle: template.lifecycle,
      configuration: { ...currentConfiguration, ...template.configuration },
      ...(agentTopology ? { agentTopology } : {}),
    }));
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
