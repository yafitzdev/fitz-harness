import type { SqliteStore } from "@fitz/storage";
import { createNInferPlaybook, NINFER_PLAYBOOK_ID } from "./ninfer-playbook.js";

/** Well-known media route ids created by `ensureMediaRoutes` (create-app.ts).
 *  The ninfer boot reconcile deletes every route that is not a consumer route or
 *  a ninfer template; without this exemption the image/video/audio routes would
 *  be wiped at every boot and assignments lost (§5.2). */
const NINFER_MEDIA_ROUTE_EXEMPTIONS = new Set(["image", "video", "audio"]);

/** Runs before `createHost()` in ninfer mode: migrates playbook recipes forward,
 *  prunes routes that are neither consumer routes nor ninfer templates (exempting
 *  the well-known media routes), and re-materializes the template routes. */
export function reconcileNInferConfiguration(store: SqliteStore): void {
  const playbook = createNInferPlaybook();
  const templatesById = new Map(playbook.recipes.map((recipe) => [recipe.id, recipe]));
  for (const recipe of store.listRecipes()) {
    const template = templatesById.get(recipe.id);
    const migratedPlaybookId = recipe.playbookId === "ninfer-qwen36" ? NINFER_PLAYBOOK_ID : recipe.playbookId;
    const migratedLifecycle = template && recipe.lifecycle.evictionPolicy === "idle-ttl" && recipe.lifecycle.idleTtlSeconds === 60
      ? { ...recipe.lifecycle, idleTtlSeconds: template.lifecycle.idleTtlSeconds }
      : recipe.lifecycle;
    const migratedCapabilities = template && !recipe.capabilities.toolCalls
      ? { ...recipe.capabilities, toolCalls: true }
      : recipe.capabilities;
    const migratedConfiguration = template && recipe.adapter === "ninfer"
      ? {
          ...recipe.configuration,
          executable: template.configuration.executable,
          artifact: template.configuration.artifact,
        }
      : recipe.configuration;
    const configurationChanged = migratedConfiguration !== recipe.configuration
      && (migratedConfiguration.executable !== recipe.configuration.executable
        || migratedConfiguration.artifact !== recipe.configuration.artifact);
    if (migratedPlaybookId !== recipe.playbookId || migratedLifecycle !== recipe.lifecycle || migratedCapabilities !== recipe.capabilities || configurationChanged) {
      store.upsertRecipe({ ...recipe, playbookId: migratedPlaybookId, lifecycle: migratedLifecycle, capabilities: migratedCapabilities, configuration: migratedConfiguration });
    }
  }
  const templates = playbook.routes;
  const existingRoutes = store.listRoutes();
  const existingById = new Map(existingRoutes.map((route) => [route.id, route]));
  const legacyDefault = existingById.get("default-agent");
  const recipeIds = new Set([...store.listRecipes(), ...playbook.recipes].map((recipe) => recipe.id));
  for (const route of existingRoutes) {
    if (!route.id.startsWith("consumer--") && !NINFER_MEDIA_ROUTE_EXEMPTIONS.has(route.id) && !templates.some((template) => template.id === route.id)) store.deleteRoute(route.id);
  }
  for (const template of templates) {
    const existing = existingById.get(template.id) ?? (template.id === "default" ? legacyDefault : undefined);
    const recipeId = existing && recipeIds.has(existing.recipeId) ? existing.recipeId : template.recipeId;
    store.upsertRoute({ ...template, recipeId });
  }
}
