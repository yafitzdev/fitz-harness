import { buildCurrentNInferRecipe } from "@fitz/engine-ninfer";
import type { Recipe, Route } from "@fitz/protocol";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";

export const NINFER_PLAYBOOK_ID = "ninfer";

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
      "qwen36-35b-a3b-mtp4-100k",
      "Qwen 3.6 35B A3B · Best",
      "qwen3.6-35b-a3b",
      `${modelRoot}/qwen3_6_35b_a3b.ninfer`,
      4,
      executable,
      runtime,
    ),
    recipe(
      "qwen36-27b-mtp3-100k",
      "Qwen 3.6 27B · Fast",
      "qwen3.6-27b",
      `${modelRoot}/qwen3_6_27b_nvfp4.ninfer`,
      3,
      executable,
      runtime,
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

function recipe(id: string, displayName: string, modelId: string, artifact: string, draftTokens: number, executable: string, runtime: NInferRuntimeLayout): Recipe {
  const value = buildCurrentNInferRecipe(id, modelId, artifact, draftTokens, executable);
  return {
    ...value,
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
