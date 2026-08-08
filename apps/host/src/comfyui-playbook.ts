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
}

const H3_VIDEO_WORKFLOW = {
  "1": {
    class_type: "HailuoVideoGenerate",
    inputs: {
      prompt: "{{prompt}}",
      seed: "{{seed}}",
      width: "{{width}}",
      height: "{{height}}",
      fps: "{{fps}}",
      duration_seconds: "{{duration_seconds}}",
    },
  },
  "2": { class_type: "SaveVideo", inputs: { filename_prefix: "fitz-h3" } },
};

const H3_IMAGE_WORKFLOW = {
  "1": {
    class_type: "HailuoImageGenerate",
    inputs: {
      prompt: "{{prompt}}",
      negative_prompt: "{{negative_prompt}}",
      seed: "{{seed}}",
      width: "{{width}}",
      height: "{{height}}",
    },
  },
  "2": { class_type: "SaveImage", inputs: { filename_prefix: "fitz-h3" } },
};

/** MiniMax H3 via ComfyUI (KD-1/KD-2): the local media playbook. The video
 *  recipe serves the well-known `video` route at 768p/1K-class with a VRAM
 *  estimate for the ResourceGovernor; the H3-as-image recipe stays
 *  `experimental: true` (KD-2 — no official text→image task) and is not
 *  assigned to the `image` route by default. Workflows are pinned inline with
 *  {{placeholder}} inputs; admins replace them with their own pinned graphs
 *  (KD-13 manual placement — weights live in the ComfyUI model folders). */
export function createComfyUIPlaybook(options: ComfyUIPlaybookOptions): ComfyUIPlaybook {
  const { engineDir, executable, entrypoint, baseUrl, expectedVramMiB } = options;
  const launch = baseUrl
    ? { baseUrl }
    : {
        executable: executable ?? "python",
        cwd: engineDir,
        ...(entrypoint ? { entrypoint } : {}),
      };
  const recipes: Recipe[] = [
    recipe({
      id: "h3-video",
      displayName: "MiniMax H3 · Video & Audio (ComfyUI)",
      modelId: "h3",
      modalities: { input: ["text", "image", "video", "audio"], output: ["video", "audio"] },
      limits: { maxDurationSeconds: 15, maxResolution: "1280x720", maxRefs: 12 },
      configuration: {
        ...launch,
        expectedVramMiB: expectedVramMiB ?? 24_576,
        readinessTimeoutMs: 180_000,
        comfyuiWorkflow: H3_VIDEO_WORKFLOW,
        outputFormats: ["mp4"],
        defaults: { resolution: "1280x720", fps: 30, durationSeconds: 10 },
      },
    }),
    recipe({
      id: "h3-image",
      displayName: "MiniMax H3 · Image (experimental)",
      modelId: "h3-image",
      modalities: { input: ["text", "image"], output: ["image"] },
      configuration: {
        ...launch,
        expectedVramMiB: expectedVramMiB ?? 24_576,
        readinessTimeoutMs: 180_000,
        experimental: true,
        comfyuiWorkflow: H3_IMAGE_WORKFLOW,
        outputFormats: ["png"],
        defaults: { resolution: "768x768" },
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
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 600,
      minimumResidencySeconds: 0,
    },
    configuration: input.configuration,
  };
}
