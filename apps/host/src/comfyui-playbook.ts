import { join } from "node:path";
import type { Recipe, Route } from "@fitz/protocol";

export const COMFYUI_PLAYBOOK_ID = "comfyui";
export const COMFYUI_RECIPE_IDS = ["h3-video", "pinkcherry-h3-video", "krea2-turbo-image"] as const;
export type ComfyUIRecipeId = (typeof COMFYUI_RECIPE_IDS)[number];

export interface ComfyUIPlaybook {
  id: string;
  displayName: string;
  recipes: Recipe[];
  routes: Route[];
}

export interface ComfyUIPlaybookOptions {
  /** ComfyUI checkout folder (managed mode): main.py + workflows live here. */
  engineDir: string;
  /** Managed-mode executable, e.g. a venv python (default "python"). */
  executable?: string;
  /** Managed-mode entrypoint script inside engineDir (default "main.py"). */
  entrypoint?: string;
  /** External mode: base URL of an already-running ComfyUI server
   *  (mutually exclusive with managed launch pieces). */
  baseUrl?: string;
  /** VRAM estimate in MiB (KD-4; default 24576 ≈ 24 GiB for H3 at 768p/1K). */
  expectedVramMiB?: number;
  /** Additional managed ComfyUI CLI arguments, such as the external Fitz model
   *  registry and an output folder outside the upstream engine checkout. */
  launchArgs?: string[];
  /** Recipes whose independently stored model artifacts are available. */
  recipeIds?: readonly ComfyUIRecipeId[];
}

const OFFICIAL_H3_MODEL = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const PINKCHERRY_H3_MODEL = join(
  "pinkcherry-h3",
  "alpha-0.5-testing",
  "PinkCherry_h3_fl2va_pruned_int8_v0.5-alpha.safetensors",
);

function h3VideoWorkflow(unetName: string) {
  return {
    "6": {
      class_type: "UNETLoader",
      inputs: { unet_name: unetName, weight_dtype: "default" },
    },
    "13": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" },
    },
    "11": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
    "24": { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
    "111": { class_type: "PrimitiveFloat", inputs: { value: "{{duration_seconds}}" } },
    "107": {
      class_type: "ComfyMathExpression",
      inputs: {
        expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
        "values.a": ["111", 0],
      },
    },
    "104": {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: {
        clip: ["13", 0],
        vae: ["11", 0],
        prompt: "{{prompt}}",
        width: "{{width}}",
        height: "{{height}}",
        length: ["107", 1],
      },
    },
    "16": { class_type: "BasicGuider", inputs: { model: ["6", 0], conditioning: ["104", 0] } },
    "15": { class_type: "RandomNoise", inputs: { noise_seed: "{{seed}}" } },
    "17": { class_type: "KSamplerSelect", inputs: { sampler_name: "{{sampler}}" } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: "simple", steps: "{{steps}}", denoise: 1 } },
    "14": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["15", 0],
        guider: ["16", 0],
        sampler: ["17", 0],
        sigmas: ["9", 0],
        latent_image: ["104", 1],
      },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["11", 0] } },
    "23": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["24", 0] } },
    "91": { class_type: "CreateVideo", inputs: { images: ["10", 0], audio: ["23", 0], fps: "{{fps}}", bit_depth: 8 } },
    "92": {
      class_type: "SaveVideo",
      inputs: { video: ["91", 0], filename_prefix: "fitz-h3", format: "auto", codec: "auto" },
    },
  };
}

/** Minimal API-form translation of Comfy-Org's official Krea 2 Turbo T2I
 * workflow. Prompt enhancement and optional LoRAs intentionally remain agent
 * concerns; the media recipe is deterministic and contains only native nodes. */
const KREA2_TURBO_IMAGE_WORKFLOW = {
  "1": {
    class_type: "UNETLoader",
    inputs: { unet_name: "krea2_turbo_nvfp4.safetensors", weight_dtype: "default" },
  },
  "2": {
    class_type: "CLIPLoader",
    inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" },
  },
  "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "{{prompt}}" } },
  "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
  "6": {
    class_type: "EmptyLatentImage",
    inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 },
  },
  "7": {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["6", 0],
      seed: "{{seed}}",
      steps: "{{steps}}",
      cfg: "{{guidance}}",
      sampler_name: "{{sampler}}",
      scheduler: "simple",
      denoise: 1,
    },
  },
  "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "fitz-krea2" } },
};

/** Local ComfyUI media playbook. H3 variants share the official 1344×768
 * text-to-video plus stereo-audio graph; Krea 2 Turbo owns text-to-image.
 * Every independently downloaded weight remains in Fitz's external registry. */
export function createComfyUIPlaybook(options: ComfyUIPlaybookOptions): ComfyUIPlaybook {
  const { engineDir, executable, entrypoint, baseUrl, expectedVramMiB, launchArgs } = options;
  const recipeIds = new Set(options.recipeIds ?? ["h3-video"]);
  const launch = baseUrl
    ? { baseUrl }
    : {
        executable: executable ?? "python",
        cwd: engineDir,
        ...(entrypoint ? { entrypoint } : {}),
        ...(launchArgs?.length ? { launchArgs } : {}),
      };
  const recipes: Recipe[] = [];
  if (recipeIds.has("h3-video")) {
    recipes.push(recipe({
      id: "h3-video",
      displayName: "MiniMax H3 · Text to Video + Audio",
      modelId: "minimax-h3-fl2va-int8",
      modalities: { input: ["text"], output: ["video", "audio"] },
      limits: { maxDurationSeconds: 15, maxResolution: "1344x768" },
      configuration: {
        ...launch,
        expectedVramMiB: expectedVramMiB ?? 24_576,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: h3VideoWorkflow(OFFICIAL_H3_MODEL),
        outputFormats: ["mp4"],
        defaults: { resolution: "1344x768", fps: 24, durationSeconds: 2, sampler: "res_multistep", steps: 20 },
      },
    }));
  }
  if (recipeIds.has("pinkcherry-h3-video")) {
    recipes.push(recipe({
      id: "pinkcherry-h3-video",
      displayName: "PinkCherry MiniMax H3 v0.5 · Text to Video + Audio",
      modelId: "pinkcherry-minimax-h3-v0.5-pruned-int8",
      modalities: { input: ["text"], output: ["video", "audio"] },
      limits: { maxDurationSeconds: 15, maxResolution: "1344x768" },
      configuration: {
        ...launch,
        expectedVramMiB: expectedVramMiB ?? 24_576,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: h3VideoWorkflow(PINKCHERRY_H3_MODEL),
        outputFormats: ["mp4"],
        defaults: { resolution: "1344x768", fps: 24, durationSeconds: 2, sampler: "res_multistep", steps: 20 },
      },
    }));
  }
  if (recipeIds.has("krea2-turbo-image")) {
    recipes.push(recipe({
      id: "krea2-turbo-image",
      displayName: "Krea 2 Turbo NVFP4 · Text to Image",
      modelId: "krea2-turbo-nvfp4",
      modalities: { input: ["text"], output: ["image"] },
      limits: { maxResolution: "2048x2048" },
      configuration: {
        ...launch,
        expectedVramMiB: 18_432,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: KREA2_TURBO_IMAGE_WORKFLOW,
        outputFormats: ["png"],
        defaults: { resolution: "1024x1024", sampler: "euler", steps: 8, guidance: 1 },
      },
    }));
  }
  const routes: Route[] = [];
  const defaultVideoRecipeId = recipeIds.has("h3-video")
    ? "h3-video"
    : recipeIds.has("pinkcherry-h3-video")
      ? "pinkcherry-h3-video"
      : undefined;
  if (defaultVideoRecipeId) {
    routes.push({
      id: "video",
      displayName: "Video generation",
      description: "Local video generation via ComfyUI",
      recipeId: defaultVideoRecipeId,
      kind: "video",
      enabled: true,
    });
  }
  if (recipeIds.has("krea2-turbo-image")) {
    routes.push({
      id: "image",
      displayName: "Image generation",
      description: "Krea 2 Turbo via local ComfyUI",
      recipeId: "krea2-turbo-image",
      kind: "image",
      enabled: true,
    });
  }
  return { id: COMFYUI_PLAYBOOK_ID, displayName: "comfyui", recipes, routes };
}

function recipe(input: {
  id: string;
  displayName: string;
  modelId: string;
  modalities: { input: Array<"text" | "image" | "video" | "audio">; output: Array<"image" | "video" | "audio"> };
  limits?: { maxDurationSeconds?: number; maxResolution?: string; maxRefs?: number };
  configuration: Record<string, unknown>;
}): Recipe {
  return {
    id: input.id,
    playbookId: COMFYUI_PLAYBOOK_ID,
    displayName: input.displayName,
    adapter: "comfyui",
    modelId: input.modelId,
    contextTokens: 1, // unused for media recipes; must be a positive integer for the recipe parser
    capabilities: {
      chatCompletions: false,
      streaming: false,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
      modalities: {
        input: input.modalities.input,
        output: input.modalities.output,
        ...(input.limits ? { limits: input.limits } : {}),
      },
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "immediate",
      idleTtlSeconds: 0,
      minimumResidencySeconds: 0,
    },
    configuration: input.configuration,
  };
}
