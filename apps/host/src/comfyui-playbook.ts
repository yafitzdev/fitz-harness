import type { Recipe, Route } from "@fitz/protocol";

export const COMFYUI_PLAYBOOK_ID = "comfyui";

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
}

const H3_VIDEO_WORKFLOW = {
  "6": {
    class_type: "UNETLoader",
    inputs: { unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype: "default" },
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

/** MiniMax H3 via ComfyUI (KD-1/KD-2): the local media playbook. The video
 *  recipe serves the well-known `video` route at the official 1344×768 canvas
 *  with native stereo audio. The graph is a pinned API-form translation of
 *  Comfy-Org's official T2V workflow; there is deliberately no invented H3
 *  text-to-image recipe. Weights remain in Fitz's external model registry. */
export function createComfyUIPlaybook(options: ComfyUIPlaybookOptions): ComfyUIPlaybook {
  const { engineDir, executable, entrypoint, baseUrl, expectedVramMiB, launchArgs } = options;
  const launch = baseUrl
    ? { baseUrl }
    : {
        executable: executable ?? "python",
        cwd: engineDir,
        ...(entrypoint ? { entrypoint } : {}),
        ...(launchArgs?.length ? { launchArgs } : {}),
      };
  const recipes: Recipe[] = [
    recipe({
      id: "h3-video",
      displayName: "MiniMax H3 · Text to Video + Audio",
      modelId: "minimax-h3-fl2va-int8",
      modalities: { input: ["text"], output: ["video", "audio"] },
      limits: { maxDurationSeconds: 15, maxResolution: "1344x768" },
      configuration: {
        ...launch,
        expectedVramMiB: expectedVramMiB ?? 24_576,
        readinessTimeoutMs: 300_000,
        comfyuiWorkflow: H3_VIDEO_WORKFLOW,
        outputFormats: ["mp4"],
        defaults: { resolution: "1344x768", fps: 24, durationSeconds: 2, sampler: "res_multistep", steps: 20 },
      },
    }),
  ];
  const routes: Route[] = [
    {
      id: "video",
      displayName: "Video generation",
      description: "MiniMax H3 via local ComfyUI",
      recipeId: "h3-video",
      kind: "video",
      enabled: true,
    },
  ];
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
