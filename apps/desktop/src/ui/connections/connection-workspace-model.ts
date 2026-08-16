import type { ConsumerConnectionSummary } from "../../preload.js";
import { engineDisplayName, type RecipeModality } from "../recipes/recipe-metadata.js";

export type Json = Record<string, any>;
export type MediaModality = Exclude<RecipeModality, "text">;
export const LOCAL_CONNECTION_ID = "hosted--local";

export type ConnectionModelView = ConsumerConnectionSummary["models"][number] & {
  displayName?: string;
  modelId?: string;
  engine?: string;
  contextTokens?: number;
  maxConcurrentGenerations?: number;
};

export interface MediaModelView {
  recipeId: string;
  displayName: string;
  modelId: string;
  engine: string;
  modalities: MediaModality[];
  limits?: { maxDurationSeconds?: number; maxFps?: number; maxResolution?: string; maxRefs?: number; maxFrames?: number };
}

export type HostedConnectionView = Omit<ConsumerConnectionSummary, "models" | "mediaModels"> & {
  hosted: true;
  availableModels: ConnectionModelView[];
  availableMediaModels: MediaModelView[];
};

export type SavedConnectionView = Omit<ConsumerConnectionSummary, "models" | "mediaModels"> & {
  hosted: false;
  availableModels: ConnectionModelView[];
  availableMediaModels: MediaModelView[];
  source: ConsumerConnectionSummary;
};

export type ConnectionView = HostedConnectionView | SavedConnectionView;

/** Build the renderable local-engine and saved-cloud view from one snapshot. */
export function buildConnectionViews(configuration: Json | undefined, records: readonly ConsumerConnectionSummary[]): ConnectionView[] {
  const recipes = localRecipes(configuration);
  const localByEngine = new Map<string, Json[]>();
  for (const recipe of recipes) {
    const engineId = String(recipe.playbookId ?? recipe.adapter ?? "Local");
    localByEngine.set(engineId, [...(localByEngine.get(engineId) ?? []), recipe]);
  }
  const engineFolders = configuration?.engineFolders ?? [];
  const hostedConnections = [...localByEngine.entries()].map(([engineId, engineRecipes]): HostedConnectionView => {
    const folder = engineFolders.find((candidate: Json) => String(candidate.folderName).toLowerCase() === engineId.toLowerCase());
    return {
      id: `${LOCAL_CONNECTION_ID}--${engineId}`,
      displayName: String(folder?.engine?.displayName ?? engineDisplayName(engineId)),
      baseUrl: "",
      authType: "none",
      hasCredential: false,
      template: "openai-compatible",
      executionClass: "self_hosted",
      accessClass: "same_device",
      availableModels: engineRecipes
        .filter((recipe: Json) => recipe.capabilities?.chatCompletions !== false)
        .map((recipe: Json): ConnectionModelView => ({
          id: String(recipe.id),
          recipeId: String(recipe.id),
          displayName: String(recipe.displayName ?? recipe.modelId ?? recipe.id),
          modelId: String(recipe.modelId ?? recipe.id),
          engine: engineId,
          contextTokens: Number(recipe.contextTokens),
          maxConcurrentGenerations: Number(recipe.capabilities?.maxConcurrentGenerations ?? 1),
        })),
      availableMediaModels: hostedMediaViews(engineRecipes),
      updatedAt: "",
      hosted: true,
    };
  });

  return [
    ...hostedConnections,
    ...records.map((connection): SavedConnectionView => ({
      ...connection,
      hosted: false,
      availableModels: connection.models.map((model) => {
        const recipe = (configuration?.recipes ?? []).find((candidate: Json) => candidate.id === model.recipeId);
        return {
          ...model,
          displayName: String(recipe?.displayName ?? model.id),
          modelId: String(recipe?.modelId ?? model.id),
          contextTokens: Number(recipe?.contextTokens),
          engine: String(connection.template ?? recipe?.adapter ?? "openai-compatible"),
          maxConcurrentGenerations: Number(recipe?.capabilities?.maxConcurrentGenerations ?? 1),
        };
      }),
      availableMediaModels: savedMediaViews(connection),
      source: connection,
    })),
  ];
}

export function connectionSearchValues(connection: ConnectionView): string[] {
  return [
    connection.displayName,
    ...connection.availableModels.flatMap((model) => [model.id, model.displayName, model.modelId, model.engine]),
    ...connection.availableMediaModels.flatMap((model) => [model.modelId, model.displayName, model.engine]),
  ].map((value) => String(value ?? ""));
}

export function connectionMatches(connection: ConnectionView, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || connectionSearchValues(connection).some((value) => value.toLowerCase().includes(normalized));
}

export function localRecipes(configuration: Json | undefined): Json[] {
  return (configuration?.recipes ?? []).filter((recipe: Json) => !String(recipe.id).startsWith("consumer-recipe--"));
}

function hostedMediaViews(recipes: Json[]): MediaModelView[] {
  return recipes
    .filter((recipe: Json) => !String(recipe.id).startsWith("consumer-recipe--")
      && recipe.capabilities?.chatCompletions === false
      && Array.isArray(recipe.capabilities?.modalities?.output)
      && recipe.capabilities.modalities.output.length)
    .map((recipe: Json): MediaModelView => ({
      recipeId: String(recipe.id),
      displayName: String(recipe.displayName ?? recipe.modelId ?? recipe.id),
      modelId: String(recipe.modelId ?? recipe.id),
      modalities: recipe.capabilities.modalities.output.filter((modality: unknown) => modality === "image" || modality === "video" || modality === "audio"),
      ...(recipe.capabilities?.modalities?.limits ? { limits: recipe.capabilities.modalities.limits } : {}),
      engine: String(recipe.playbookId ?? recipe.adapter ?? "Local"),
    }));
}

/** Media providers register one entry per (model, modality); the UI shows one card per model. */
function savedMediaViews(connection: ConsumerConnectionSummary): MediaModelView[] {
  const byRecipe = new Map<string, MediaModelView>();
  for (const model of connection.mediaModels ?? []) {
    const view = byRecipe.get(model.recipeId) ?? {
      recipeId: model.recipeId,
      displayName: model.id,
      modelId: model.id,
      modalities: [],
      engine: model.template,
    };
    if (!view.modalities.includes(model.modality)) view.modalities.push(model.modality);
    byRecipe.set(model.recipeId, view);
  }
  return [...byRecipe.values()];
}
