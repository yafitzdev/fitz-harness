import type { DatabaseSync } from "node:sqlite";
import type { EngineRegistration, Recipe, Route, RouteKind } from "@fitz/protocol";

interface RecipeRow { recipe_json: string }
interface PlaybookRow { id: string; name: string; adapter: string; configuration_json: string; created_at: string; updated_at: string }
interface RouteRow { id: string; display_name: string; description: string | null; recipe_id: string; kind: string; enabled: number; is_default: number }

/** Engine, recipe, and route configuration persistence. */
export class SqliteConfigurationStore {
  constructor(private readonly database: DatabaseSync) {}

  upsertRecipe(recipe: Recipe): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO recipes (id, playbook_id, display_name, adapter, model_id, context_tokens, recipe_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET playbook_id = excluded.playbook_id, display_name = excluded.display_name, adapter = excluded.adapter, model_id = excluded.model_id, context_tokens = excluded.context_tokens, recipe_json = excluded.recipe_json, updated_at = excluded.updated_at`).run(recipe.id, recipe.playbookId, recipe.displayName, recipe.adapter, recipe.modelId, recipe.contextTokens, JSON.stringify(recipe), now, now);
  }

  upsertEngine(engine: EngineRegistration): void {
    this.database.prepare(`INSERT INTO playbooks (id, name, adapter, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, adapter = excluded.adapter, configuration_json = excluded.configuration_json, updated_at = excluded.updated_at`).run(
      engine.id,
      engine.displayName,
      "openai-compatible",
      JSON.stringify({ folderName: engine.folderName, connectionMode: engine.connectionMode, runtime: engine.runtime, baseUrl: engine.baseUrl, healthPath: engine.healthPath, launchCommand: engine.launchCommand, launchArguments: engine.launchArguments, workingDirectory: engine.workingDirectory, runtimeId: engine.runtimeId }),
      engine.createdAt,
      engine.updatedAt,
    );
  }

  getEngine(id: string): EngineRegistration | undefined { const row = this.database.prepare("SELECT id, name, adapter, configuration_json, created_at, updated_at FROM playbooks WHERE id = ?").get(id) as PlaybookRow | undefined; return row ? mapPlaybook(row) : undefined; }
  listEngines(): EngineRegistration[] { return (this.database.prepare("SELECT id, name, adapter, configuration_json, created_at, updated_at FROM playbooks ORDER BY name").all() as unknown as PlaybookRow[]).map(mapPlaybook); }
  deleteEngine(id: string): boolean { return this.database.prepare("DELETE FROM playbooks WHERE id = ?").run(id).changes > 0; }

  upsertRoute(route: Route): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO routes (id, display_name, description, recipe_id, kind, enabled, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, recipe_id = excluded.recipe_id, kind = excluded.kind, enabled = excluded.enabled, is_default = excluded.is_default, updated_at = excluded.updated_at`).run(route.id, route.displayName, route.description ?? null, route.recipeId, route.kind ?? "chat", route.enabled ? 1 : 0, route.isDefault ? 1 : 0, now, now);
  }
  deleteRoute(routeId: string): void { this.database.prepare("DELETE FROM routes WHERE id = ?").run(routeId); }
  deleteRecipe(recipeId: string): void { this.database.prepare("DELETE FROM recipes WHERE id = ?").run(recipeId); }
  listRecipes(): Recipe[] { return (this.database.prepare("SELECT recipe_json FROM recipes ORDER BY id").all() as unknown as RecipeRow[]).map((row) => JSON.parse(row.recipe_json) as Recipe); }
  listRoutes(): Route[] {
    const rows = this.database.prepare(`SELECT id, display_name, description, recipe_id, kind, enabled, is_default FROM routes ORDER BY id`).all() as unknown as RouteRow[];
    return rows.map((row) => ({ id: row.id, displayName: row.display_name, recipeId: row.recipe_id, enabled: row.enabled === 1, ...(row.description ? { description: row.description } : {}), ...(row.is_default === 1 ? { isDefault: true } : {}), ...(row.kind !== "chat" ? { kind: row.kind as RouteKind } : {}) }));
  }
}

function mapPlaybook(row: PlaybookRow): EngineRegistration { const value = JSON.parse(row.configuration_json) as Omit<EngineRegistration, "id" | "displayName" | "createdAt" | "updatedAt">; return { id: row.id, displayName: row.name, ...value, createdAt: row.created_at, updatedAt: row.updated_at }; }
