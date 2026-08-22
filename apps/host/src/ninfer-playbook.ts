import { buildCurrentNInferRecipe } from "@fitz/engine-ninfer";
import type { Recipe, Route } from "@fitz/protocol";
import { NINFER_MODEL_PROFILES, type NInferModelProfile } from "./ninfer-model-profiles.js";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";

export const NINFER_PLAYBOOK_ID = "ninfer";

export interface NInferPlaybook {
  id: string;
  displayName: string;
  recipes: Recipe[];
  routes: Route[];
}

export function createNInferPlaybook(runtime: NInferRuntimeLayout): NInferPlaybook {
  const recipes = NINFER_MODEL_PROFILES.map((profile) => recipe(profile, runtime));
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

function recipe(
  profile: NInferModelProfile,
  runtime: NInferRuntimeLayout,
): Recipe {
  const value = buildCurrentNInferRecipe(
    profile.recipeId,
    profile.modelId,
    `${runtime.modelRoot}/${profile.fileName}`,
    profile.draftTokens,
    runtime.executable,
    {
      maxContext: profile.maxContextTokens,
      kvCapacity: profile.kvCapacityTokens,
      maxConcurrency: profile.maxConcurrency,
      vision: profile.vision,
      thinking: true,
      kvDtype: profile.kvDtype,
    },
  );
  return {
    ...value,
    contextTokens: profile.modelContextTokens,
    playbookId: NINFER_PLAYBOOK_ID,
    displayName: profile.displayName,
    lifecycle: { ...value.lifecycle, evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: {
      ...value.configuration,
      readinessTimeoutMs: 180_000,
      requestLogJsonl: `${runtime.guestRoot}/logs/ninfer-requests.jsonl`,
      runtimeId: runtime.id,
      engineRef: "llm://engines/ninfer",
      modelRef: `llm://models/${profile.registrationId}`,
    },
  };
}
