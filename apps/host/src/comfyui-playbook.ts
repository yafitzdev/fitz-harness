import type { Recipe, Route } from "@fitz/protocol";

export const COMFYUI_PLAYBOOK_ID = "comfyui";
export const COMFYUI_RECIPE_IDS = ["h3-video", "minimax-music3-audio", "krea2-turbo-image", "krea2-nsfw-image", "qwen-image"] as const;
export type ComfyUIRecipeId = (typeof COMFYUI_RECIPE_IDS)[number];
export const RETIRED_COMFYUI_RECIPE_IDS = ["pinkcherry-h3-video"] as const;

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
  /** Managed Linux runtime. Omitted only for external/test configurations. */
  runtime?: "linux-managed";
  runtimeId?: string;
  /** Recipes whose independently stored model artifacts are available. */
  recipeIds?: readonly ComfyUIRecipeId[];
  /** The optional Ref2VA checkpoint is installed alongside the base H3 files. */
  h3ReferenceEnabled?: boolean;
}

const OFFICIAL_H3_MODEL = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const OFFICIAL_H3_REFERENCE_MODEL = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
const MINIMAX_MUSIC3_MODEL = "minimax_music3_dit_fp16.safetensors";
const MINIMAX_MUSIC3_ENCODER = "minimax_music3_text_encoder_pruned_int8_convrot.safetensors";
const MINIMAX_MUSIC3_VAE = "minimax_music3_dav.safetensors";
const KREA2_NSFW_LORA = "KNP_V2_copy_copy.safetensors";
const QWEN_IMAGE_MODEL = "qwen_image_2512_fp8_e4m3fn.safetensors";
const QWEN_IMAGE_EDIT_MODEL = "qwen_image_edit_2511_int8_convrot.safetensors";
const QWEN_IMAGE_ENCODER = "qwen_2.5_vl_7b_fp8_scaled.safetensors";

function h3VideoWorkflow(unetName: string, firstFrame?: string) {
  return {
    ...(firstFrame ? { "103": { class_type: "LoadImage", inputs: { image: firstFrame } } } : {}),
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
        // H3 `length` is a frame count; the duration→frames conversion must use the
        // requested fps ({{fps}} resolves to the recipe default 24 when unset) or a
        // 30/60 fps request would play back shorter than the requested duration.
        expression: "max(5, round(a * {{fps}})) + (5 - (max(5, round(a * {{fps}})) % 17)) % 17",
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
        ...(firstFrame ? { first_frame: ["103", 0] } : {}),
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

/** API-form translation of Comfy-Org's native H3 Ref2VA graph. Reference
 * loader nodes are added by the ComfyUI adapter after typed artifacts have
 * been uploaded; the target uses flattened v3 Autogrow input names. */
function h3ReferenceWorkflow() {
  return {
    "6": { class_type: "UNETLoader", inputs: { unet_name: OFFICIAL_H3_REFERENCE_MODEL, weight_dtype: "default" } },
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
        expression: "max(5, round(a * {{fps}})) + (5 - (max(5, round(a * {{fps}})) % 17)) % 17",
        "values.a": ["111", 0],
      },
    },
    "104": {
      class_type: "MiniMaxH3ReferenceToVideo",
      inputs: {
        clip: ["13", 0],
        vae: ["11", 0],
        audio_vae: ["24", 0],
        prompt: "{{prompt}}",
        width: "{{width}}",
        height: "{{height}}",
        length: ["107", 1],
        ref_image_size: "match",
      },
    },
    "16": { class_type: "BasicGuider", inputs: { model: ["6", 0], conditioning: ["104", 0] } },
    "15": { class_type: "RandomNoise", inputs: { noise_seed: "{{seed}}" } },
    "17": { class_type: "KSamplerSelect", inputs: { sampler_name: "{{sampler}}" } },
    "9": { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: "simple", steps: "{{steps}}", denoise: 1 } },
    "14": {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["15", 0], guider: ["16", 0], sampler: ["17", 0], sigmas: ["9", 0], latent_image: ["104", 1] },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["14", 0], vae: ["11", 0] } },
    "23": { class_type: "VAEDecodeAudio", inputs: { samples: ["14", 0], vae: ["24", 0] } },
    "91": { class_type: "CreateVideo", inputs: { images: ["10", 0], audio: ["23", 0], fps: "{{fps}}", bit_depth: 8 } },
    "92": { class_type: "SaveVideo", inputs: { video: ["91", 0], filename_prefix: "fitz-h3-reference", format: "auto", codec: "auto" } },
  };
}

/** API-form translation of Comfy-Org's official MiniMax Music 3 workflow.
 * The text encoder decides the actual song length up to max_duration and feeds
 * that duration into the latent. Tiled VAE decoding keeps long songs within a
 * predictable VRAM envelope on the local 32 GB GPU. */
function minimaxMusic3Workflow() {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: MINIMAX_MUSIC3_MODEL, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: MINIMAX_MUSIC3_ENCODER, type: "minimax", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: MINIMAX_MUSIC3_VAE } },
    "4": {
      class_type: "MiniMaxMusic3TextEncode",
      inputs: {
        clip: ["2", 0],
        caption: "{{prompt}}",
        lyrics: "{{lyrics}}",
        seed: "{{seed}}",
        max_duration: "{{duration_seconds}}",
        cfg_scale: "{{guidance}}",
        top_k: 50,
      },
    },
    "5": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "6": { class_type: "EmptyMiniMaxMusic3LatentAudio", inputs: { seconds: ["4", 1], batch_size: 1 } },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0],
        seed: "{{seed}}", steps: "{{steps}}", cfg: "{{guidance}}", sampler_name: "{{sampler}}",
        scheduler: "simple", denoise: 1,
      },
    },
    "8": {
      class_type: "VAEDecodeAudioTiled",
      inputs: { samples: ["7", 0], vae: ["3", 0], tile_size: 1536, overlap: 64 },
    },
    "9": {
      class_type: "SaveAudioAdvanced",
      inputs: {
        audio: ["8", 0],
        filename_prefix: "fitz-minimax-music3",
        // DynamicCombo inputs are flattened on ComfyUI's API wire. The
        // executor rebuilds these as { format: "mp3", quality: "V0" }.
        format: "mp3",
        "format.quality": "V0",
      },
    },
  };
}

/** API-form translation of Comfy-Org's Krea 2 Turbo T2I workflow. An optional
 * model-only LoRA creates a distinct recipe without duplicating the base model. */
function krea2TurboImageWorkflow(loraName?: string) {
  const model = loraName ? ["10", 0] : ["1", 0];
  return {
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
        model,
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
    "9": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: loraName ? "fitz-krea2-nsfw" : "fitz-krea2" },
    },
    ...(loraName
      ? {
          "10": {
            class_type: "LoraLoaderModelOnly",
            inputs: { model: ["1", 0], lora_name: loraName, strength_model: 1 },
          },
        }
      : {}),
  };
}

function qwenImageWorkflow() {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: QWEN_IMAGE_MODEL, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: QWEN_IMAGE_ENCODER, type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "{{prompt}}" } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "{{negative_prompt}}" } },
    "7": { class_type: "EmptySD3LatentImage", inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed: "{{seed}}", steps: "{{steps}}", cfg: "{{guidance}}", sampler_name: "{{sampler}}",
        scheduler: "simple", denoise: 1,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "fitz-qwen-image" } },
  };
}

/** One-reference edit path. Fitz uploads the durable artifact to ComfyUI's
 * input store and substitutes its returned filename into {{ref_0}}. */
function qwenImageEditWorkflow() {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: QWEN_IMAGE_EDIT_MODEL, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: QWEN_IMAGE_ENCODER, type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
    "5": { class_type: "CFGNorm", inputs: { model: ["4", 0], strength: 1 } },
    "6": { class_type: "LoadImage", inputs: { image: "{{ref_0}}" } },
    "7": { class_type: "FluxKontextImageScale", inputs: { image: ["6", 0] } },
    "8": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], prompt: "{{prompt}}", vae: ["3", 0], image1: ["7", 0] } },
    "9": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], prompt: "{{negative_prompt}}" } },
    "10": { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["8", 0], reference_latents_method: "index_timestep_zero" } },
    "11": { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["9", 0], reference_latents_method: "index_timestep_zero" } },
    "12": { class_type: "VAEEncode", inputs: { pixels: ["7", 0], vae: ["3", 0] } },
    "13": {
      class_type: "KSampler",
      inputs: {
        model: ["5", 0], positive: ["10", 0], negative: ["11", 0], latent_image: ["12", 0],
        seed: "{{seed}}", steps: "{{steps}}", cfg: "{{guidance}}", sampler_name: "{{sampler}}",
        scheduler: "simple", denoise: 1,
      },
    },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["3", 0] } },
    "15": { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: "fitz-qwen-edit" } },
  };
}

/** Local ComfyUI media playbook. H3 owns the official 1344×768 text/image-to-video
 * graph; synchronized audio is part of its video artifact, not an audio-route
 * capability. Music 3 exclusively owns text-to-audio. Krea 2 Turbo and its optional LoRA own text-to-image.
 * Every independently downloaded weight remains in Fitz's external registry. */
export function createComfyUIPlaybook(options: ComfyUIPlaybookOptions): ComfyUIPlaybook {
  const { engineDir, executable, entrypoint, baseUrl, expectedVramMiB, launchArgs, runtime, runtimeId } = options;
  const recipeIds = new Set(options.recipeIds ?? ["h3-video"]);
  const launch = baseUrl
    ? { baseUrl }
    : {
        executable: executable ?? "python",
        cwd: engineDir,
        ...(runtime ? { runtime, runtimeId } : {}),
        ...(entrypoint ? { entrypoint } : {}),
        ...(launchArgs?.length ? { launchArgs } : {}),
      };
  const recipes: Recipe[] = [];
  if (recipeIds.has("h3-video")) {
    recipes.push(recipe({
      id: "h3-video",
      displayName: options.h3ReferenceEnabled ? "MiniMax H3 · Text/Image/Reference to Video" : "MiniMax H3 · Text/Image to Video",
      modelId: options.h3ReferenceEnabled ? "minimax-h3-fl2va+ref2va-int8" : "minimax-h3-fl2va-int8",
      modalities: { input: options.h3ReferenceEnabled ? ["text", "image", "video", "audio"] : ["text", "image"], output: ["video"] },
      limits: options.h3ReferenceEnabled
        ? { maxDurationSeconds: 6, maxFps: 30, maxResolution: "1344x768", maxRefs: 15, maxRefsByModality: { image: 9, video: 3, audio: 3 } }
        : { maxDurationSeconds: 6, maxFps: 30, maxResolution: "1344x768", maxRefs: 1 },
      configuration: {
        ...launch,
        expectedVramMiB: expectedVramMiB ?? 24_576,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: h3VideoWorkflow(OFFICIAL_H3_MODEL),
        comfyuiAnimateWorkflow: h3VideoWorkflow(OFFICIAL_H3_MODEL, "{{ref_0}}"),
        ...(options.h3ReferenceEnabled ? {
          comfyuiReferenceWorkflow: h3ReferenceWorkflow(),
          comfyuiReferenceBindings: {
            targetNodeId: "104",
            imageInputPrefix: "ref_images.ref_image_",
            videoInputPrefix: "ref_videos.ref_video_",
            videoAudioInputPrefix: "ref_video_audios.ref_video_audio_",
            audioInputPrefix: "ref_audios.ref_audio_",
          },
        } : {}),
        outputFormats: ["mp4"],
        // MiniMaxH3ImageToVideo declares a 32-pixel spatial grid. A 720px
        // height creates mismatched keyframe/video latents and fails during
        // patchification, so every requested size is snapped before execution.
        sizeGrid: 32,
        defaults: { resolution: "1344x768", fps: 24, durationSeconds: 2, sampler: "res_multistep", steps: 20 },
      },
    }));
  }
  if (recipeIds.has("minimax-music3-audio")) {
    recipes.push(recipe({
      id: "minimax-music3-audio",
      displayName: "MiniMax Music 3 · Text to Music",
      modelId: "minimax-music3-fp16",
      modalities: { input: ["text"], output: ["audio"] },
      limits: { maxDurationSeconds: 300 },
      configuration: {
        ...launch,
        expectedVramMiB: 22_528,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: minimaxMusic3Workflow(),
        outputFormats: ["mp3"],
        defaults: { durationSeconds: 60, sampler: "euler", steps: 30, guidance: 1.7 },
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
        comfyuiWorkflow: krea2TurboImageWorkflow(),
        outputFormats: ["png"],
        defaults: { resolution: "1024x1024", sampler: "euler", steps: 8, guidance: 1 },
      },
    }));
  }
  if (recipeIds.has("krea2-nsfw-image")) {
    recipes.push(recipe({
      id: "krea2-nsfw-image",
      displayName: "Krea 2 Turbo NVFP4 + NSFW LoRA · Text to Image",
      modelId: "krea2-turbo-nvfp4-nsfw",
      modalities: { input: ["text"], output: ["image"] },
      limits: { maxResolution: "2048x2048" },
      configuration: {
        ...launch,
        expectedVramMiB: 18_432,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: krea2TurboImageWorkflow(KREA2_NSFW_LORA),
        outputFormats: ["png"],
        defaults: { resolution: "1024x1024", sampler: "euler", steps: 8, guidance: 1 },
      },
    }));
  }
  if (recipeIds.has("qwen-image")) {
    recipes.push(recipe({
      id: "qwen-image",
      displayName: "Qwen Image 2512 + Edit 2511",
      modelId: "qwen-image-2512-edit-2511",
      modalities: { input: ["text", "image"], output: ["image"] },
      limits: { maxResolution: "2048x2048", maxRefs: 1 },
      configuration: {
        ...launch,
        // ComfyUI smart memory keeps the FP8 diffusion model resident while
        // offloading the shared Qwen encoder as needed. This is a peak
        // dedicated-VRAM budget, not the sum of every model file on disk.
        expectedVramMiB: 24_576,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: qwenImageWorkflow(),
        comfyuiEditWorkflow: qwenImageEditWorkflow(),
        outputFormats: ["png"],
        defaults: { resolution: "1024x1024", sampler: "euler", steps: 40, guidance: 4 },
      },
    }));
  }
  const routes: Route[] = [];
  const defaultVideoRecipeId = recipeIds.has("h3-video") ? "h3-video" : undefined;
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
  if (recipeIds.has("minimax-music3-audio")) {
    routes.push({
      id: "audio",
      displayName: "Audio generation",
      description: "MiniMax Music 3 via local ComfyUI",
      recipeId: "minimax-music3-audio",
      kind: "audio",
      enabled: true,
    });
  }
  const defaultImageRecipeId = recipeIds.has("qwen-image")
    ? "qwen-image"
    : recipeIds.has("krea2-turbo-image")
    ? "krea2-turbo-image"
    : recipeIds.has("krea2-nsfw-image")
      ? "krea2-nsfw-image"
      : undefined;
  if (defaultImageRecipeId) {
    routes.push({
      id: "image",
      displayName: "Image generation",
      description: defaultImageRecipeId === "qwen-image" ? "Qwen Image generation and editing via local ComfyUI" : "Krea 2 Turbo via local ComfyUI",
      recipeId: defaultImageRecipeId,
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
  limits?: {
    maxDurationSeconds?: number;
    maxFps?: number;
    maxResolution?: string;
    maxRefs?: number;
    maxRefsByModality?: { image?: number; video?: number; audio?: number };
  };
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
