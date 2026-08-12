import type { SqliteStore } from "@fitz/storage";
import { createNInferPlaybook } from "./ninfer-playbook.js";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";

/** Well-known media route ids created by `ensureMediaRoutes` (create-app.ts).
 *  The ninfer boot reconcile deletes every route that is not a consumer route or
 *  a ninfer template; without this exemption the image/video/audio routes would
 *  be wiped at every boot and assignments lost (§5.2). */
const NINFER_MEDIA_ROUTE_EXEMPTIONS = new Set(["image", "video", "audio"]);

/** Runs before `createHost()` in ninfer mode: refreshes canonical executable and
 * artifact paths, prunes routes outside the current route contract, and
 * materializes the current templates. It deliberately contains no old-id or
 * old-schema aliases. */
export function reconcileNInferConfiguration(store: SqliteStore, runtime: NInferRuntimeLayout): void {
  const playbook = createNInferPlaybook(runtime);
  const templatesById = new Map(playbook.recipes.map((recipe) => [recipe.id, recipe]));
  for (const recipe of store.listRecipes()) {
    const template = templatesById.get(recipe.id);
    const { runtimeDistribution: _discardedDistribution, ...currentConfiguration } = recipe.configuration;
    const migratedConfiguration = template && recipe.adapter === "ninfer"
      ? {
          ...currentConfiguration,
          executable: template.configuration.executable,
          artifact: template.configuration.artifact,
          requestLogJsonl: template.configuration.requestLogJsonl,
          ...(template.configuration.runtimeId ? {
            runtimeId: template.configuration.runtimeId,
            engineRef: template.configuration.engineRef,
            modelRef: template.configuration.modelRef,
          } : {}),
        }
      : recipe.configuration;
    const configurationChanged = migratedConfiguration !== recipe.configuration
      && (migratedConfiguration.executable !== recipe.configuration.executable
        || migratedConfiguration.artifact !== recipe.configuration.artifact
        || migratedConfiguration.requestLogJsonl !== recipe.configuration.requestLogJsonl
        || migratedConfiguration.runtimeId !== recipe.configuration.runtimeId
        || migratedConfiguration.engineRef !== recipe.configuration.engineRef
        || migratedConfiguration.modelRef !== recipe.configuration.modelRef
        || "runtimeDistribution" in recipe.configuration);
    if (configurationChanged) {
      store.upsertRecipe({ ...recipe, configuration: migratedConfiguration });
    }
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
    const recipeId = existing && recipeIds.has(existing.recipeId) ? existing.recipeId : template.recipeId;
    store.upsertRoute({ ...template, recipeId });
  }
}
