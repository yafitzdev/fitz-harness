import {
  LOCAL_MAIN_CONTEXT_TOKENS,
  LOCAL_MAX_CONCURRENT_AGENTS,
} from "@fitz/protocol";

export type NInferKvDtype = "int8" | "bf16";

export interface NInferModelProfile {
  registrationId: string;
  recipeId: string;
  displayName: string;
  modelId: string;
  fileName: string;
  draftTokens: number;
  maxContextTokens: number;
  modelContextTokens: number;
  maxConcurrency: number;
  kvDtype: NInferKvDtype;
  vision: boolean;
}

export const QWEN38_GROUPWISE_RECIPE_ID = "qwen38-27b-groupwise-bf16-main";
export const QWEN38_NVFP4_RECIPE_ID = "qwen38-27b-nvfp4-q8-agent-pool";
export const QWEN36_35B_RECIPE_ID = "qwen36-35b-a3b-mtp4-100k";

/** Deployment policy for every managed NInfer artifact. This is the single
 * authority used by runtime discovery and recipe construction. */
export const NINFER_MODEL_PROFILES: readonly NInferModelProfile[] = [
  {
    registrationId: "qwen3.8-27b",
    recipeId: QWEN38_GROUPWISE_RECIPE_ID,
    displayName: "Qwen 3.8 27B · Groupwise · BF16 KV · Main only",
    modelId: "qwen3.8-27b",
    fileName: "qwen3_8_27b.ninfer",
    draftTokens: 4,
    maxContextTokens: LOCAL_MAIN_CONTEXT_TOKENS,
    modelContextTokens: 262_144,
    maxConcurrency: 1,
    kvDtype: "bf16",
    vision: true,
  },
  {
    registrationId: "qwen3.8-27b-nvfp4",
    recipeId: QWEN38_NVFP4_RECIPE_ID,
    displayName: "Qwen 3.8 27B · NVFP4 · Q8 KV · Workers",
    modelId: "qwen3.8-27b-nvfp4",
    fileName: "qwen3_8_27b_nvfp4.ninfer",
    draftTokens: 4,
    maxContextTokens: LOCAL_MAIN_CONTEXT_TOKENS,
    modelContextTokens: 262_144,
    maxConcurrency: LOCAL_MAX_CONCURRENT_AGENTS,
    kvDtype: "int8",
    vision: true,
  },
  {
    registrationId: "qwen3.6-35b-a3b",
    recipeId: QWEN36_35B_RECIPE_ID,
    displayName: "Qwen 3.6 35B A3B · Best",
    modelId: "qwen3.6-35b-a3b",
    fileName: "qwen3_6_35b_a3b.ninfer",
    draftTokens: 4,
    maxContextTokens: LOCAL_MAIN_CONTEXT_TOKENS,
    modelContextTokens: 262_144,
    maxConcurrency: LOCAL_MAX_CONCURRENT_AGENTS,
    kvDtype: "int8",
    vision: false,
  },
] satisfies readonly NInferModelProfile[];
