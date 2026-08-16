import { buildCurrentNInferRecipe } from "@fitz/engine-ninfer";
import { LOCAL_MAIN_CONTEXT_TOKENS, LOCAL_MAX_CONCURRENT_AGENTS, type Recipe, type Route } from "@fitz/protocol";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";

export const NINFER_PLAYBOOK_ID = "ninfer";
export const QWEN38_ORCHESTRATOR_RECIPE_ID = "qwen38-27b-mtp3-agent-pool-c3";
export const QWEN36_35B_RECIPE_ID = "qwen36-35b-a3b-mtp4-100k";
export const QWEN38_MODEL_CONTEXT_TOKENS = 262_144;
export const NINFER_MAX_CONCURRENT_AGENTS = LOCAL_MAX_CONCURRENT_AGENTS;

type NInferRecipeOptions = Parameters<typeof buildCurrentNInferRecipe>[5] & {
  modelContextTokens?: number;
};

export interface NInferPlaybook {
  id: string;
  displayName: string;
  recipes: Recipe[];
  routes: Route[];
}

export function createNInferPlaybook(runtime: NInferRuntimeLayout): NInferPlaybook {
  const modelRoot = runtime.modelRoot;
  const executable = runtime.executable;
  const recipes = [
    recipe(
      QWEN38_ORCHESTRATOR_RECIPE_ID,
      "Qwen 3.8 27B · Vision · Orchestrator + 2 Workers",
      "qwen3.8-27b",
      `${modelRoot}/qwen3_8_27b.ninfer`,
      3,
      executable,
      runtime,
      {
        maxContext: LOCAL_MAIN_CONTEXT_TOKENS,
        kvCapacity: "auto",
        maxConcurrency: NINFER_MAX_CONCURRENT_AGENTS,
        vision: true,
        modelContextTokens: QWEN38_MODEL_CONTEXT_TOKENS,
      },
    ),
    recipe(
      QWEN36_35B_RECIPE_ID,
      "Qwen 3.6 35B A3B · Best",
      "qwen3.6-35b-a3b",
      `${modelRoot}/qwen3_6_35b_a3b.ninfer`,
      4,
      executable,
      runtime,
      configurableWorkerPool(),
    ),
  ];
  const routes: Route[] = [
    {
      id: "default",
      displayName: "Local",
      description: "Primary route",
      recipeId: recipes[0]!.id,
      enabled: true,
      isDefault: true,
    },
  ];
  return { id: NINFER_PLAYBOOK_ID, displayName: "ninfer", recipes, routes };
}

function configurableWorkerPool(): NInferRecipeOptions {
  return {
    maxContext: LOCAL_MAIN_CONTEXT_TOKENS,
    modelContextTokens: 262_144,
    maxConcurrency: NINFER_MAX_CONCURRENT_AGENTS,
    kvCapacity: "auto",
  };
}

function recipe(
  id: string,
  displayName: string,
  modelId: string,
  artifact: string,
  draftTokens: number,
  executable: string,
  runtime: NInferRuntimeLayout,
  options: NInferRecipeOptions = {},
): Recipe {
  const { modelContextTokens, ...engineOptions } = options;
  const value = buildCurrentNInferRecipe(id, modelId, artifact, draftTokens, executable, { ...engineOptions, thinking: true });
  return {
    ...value,
    contextTokens: modelContextTokens ?? value.contextTokens,
    playbookId: NINFER_PLAYBOOK_ID,
    displayName,
    lifecycle: { ...value.lifecycle, evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: {
      ...value.configuration,
      readinessTimeoutMs: 180_000,
      requestLogJsonl: `${runtime.guestRoot}/logs/ninfer-requests.jsonl`,
      runtimeId: runtime.id,
      engineRef: "llm://engines/ninfer",
      modelRef: `llm://models/${modelId}`,
    },
  };
}
