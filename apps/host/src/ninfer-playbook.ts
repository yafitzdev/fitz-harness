import { buildCurrentNInferRecipe } from "@fitz/engine-ninfer";
import type { Recipe, Route } from "@fitz/protocol";
import type { NInferRuntimeLayout } from "./ninfer-runtime.js";
import { LOCAL_AGENT_MAX_CONCURRENCY } from "./local-agent-capacity.js";

export const NINFER_PLAYBOOK_ID = "ninfer";
export const QWEN38_ORCHESTRATOR_RECIPE_ID = "qwen38-27b-mtp3-agent-pool-c3";
export const QWEN38_MODEL_CONTEXT_TOKENS = 262_144;
export const QWEN38_SHARED_CONTEXT_TOKENS = 256_000;
export const QWEN38_WORKER_CONTEXT_TOKENS = 64_000;
export const QWEN38_LOCAL_WORKERS = 2;
export const QWEN38_ORCHESTRATOR_CONTEXT_TOKENS = QWEN38_SHARED_CONTEXT_TOKENS - (QWEN38_WORKER_CONTEXT_TOKENS * QWEN38_LOCAL_WORKERS);
export const NINFER_MAX_CONCURRENT_AGENTS = LOCAL_AGENT_MAX_CONCURRENCY;
export const NINFER_DEFAULT_SHARED_CONTEXT_TOKENS = 100_000;
export const NINFER_DEFAULT_WORKER_CONTEXT_TOKENS = 32_000;

type NInferRecipeOptions = Parameters<typeof buildCurrentNInferRecipe>[5] & {
  modelContextTokens?: number;
  agentTopology?: Recipe["agentTopology"];
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
        maxContext: QWEN38_ORCHESTRATOR_CONTEXT_TOKENS,
        kvCapacity: QWEN38_SHARED_CONTEXT_TOKENS,
        maxConcurrency: QWEN38_LOCAL_WORKERS + 1,
        vision: true,
        modelContextTokens: QWEN38_MODEL_CONTEXT_TOKENS,
        agentTopology: {
          sharedContextTokens: QWEN38_SHARED_CONTEXT_TOKENS,
          workers: {
            count: QWEN38_LOCAL_WORKERS,
            contextTokens: QWEN38_WORKER_CONTEXT_TOKENS,
          },
        },
      },
    ),
    recipe(
      "qwen36-35b-a3b-mtp4-100k",
      "Qwen 3.6 35B A3B · Best",
      "qwen3.6-35b-a3b",
      `${modelRoot}/qwen3_6_35b_a3b.ninfer`,
      4,
      executable,
      runtime,
      configurableWorkerPool(),
    ),
    recipe(
      "qwen36-27b-mtp3-100k",
      "Qwen 3.6 27B · Fast",
      "qwen3.6-27b",
      `${modelRoot}/qwen3_6_27b_nvfp4.ninfer`,
      3,
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
    maxConcurrency: NINFER_MAX_CONCURRENT_AGENTS,
    kvCapacity: NINFER_DEFAULT_SHARED_CONTEXT_TOKENS,
    agentTopology: {
      sharedContextTokens: NINFER_DEFAULT_SHARED_CONTEXT_TOKENS,
      workers: { count: 0, contextTokens: NINFER_DEFAULT_WORKER_CONTEXT_TOKENS },
    },
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
  const { modelContextTokens, agentTopology, ...engineOptions } = options;
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
    ...(agentTopology ? { agentTopology } : {}),
  };
}
