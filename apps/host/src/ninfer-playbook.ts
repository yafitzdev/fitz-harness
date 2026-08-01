import { buildCurrentNInferRecipe } from "@fitz/engine-ninfer";
import type { Recipe, Route } from "@fitz/protocol";

export const NINFER_PLAYBOOK_ID = "ninfer";

export interface NInferPlaybook {
  id: string;
  displayName: string;
  recipes: Recipe[];
  routes: Route[];
}

export function createNInferPlaybook(): NInferPlaybook {
  const recipes = [
    recipe(
      "qwen36-35b-a3b-mtp4-100k",
      "Qwen 3.6 35B A3B · Best",
      "qwen3.6-35b-a3b",
      "/opt/ninfer/models/qwen3_6_35b_a3b.ninfer",
      4,
    ),
    recipe(
      "qwen36-27b-mtp3-100k",
      "Qwen 3.6 27B · Fast",
      "qwen3.6-27b",
      "/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer",
      3,
    ),
  ];
  const routes: Route[] = [
    {
      id: "fast",
      displayName: "Fast",
      description: "Lowest-latency route",
      recipeId: recipes[1]!.id,
      enabled: true,
    },
    {
      id: "default",
      displayName: "Default",
      description: "Primary route",
      recipeId: recipes[0]!.id,
      enabled: true,
      isDefault: true,
    },
    {
      id: "smart",
      displayName: "Smart",
      description: "Highest-capability route",
      recipeId: recipes[0]!.id,
      enabled: true,
    },
  ];
  return { id: NINFER_PLAYBOOK_ID, displayName: "ninfer", recipes, routes };
}

function recipe(id: string, displayName: string, modelId: string, artifact: string, draftTokens: number): Recipe {
  const value = buildCurrentNInferRecipe(id, modelId, artifact, draftTokens);
  return {
    ...value,
    playbookId: NINFER_PLAYBOOK_ID,
    displayName,
    configuration: { ...value.configuration, readinessTimeoutMs: 180_000 },
  };
}
