import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";

export interface LocalComfyUIPaths {
  engineDir: string;
  executable: string;
  modelConfigPath: string;
  outputDir: string;
}

export function localComfyUIPaths(paths: FitzRuntimePaths): LocalComfyUIPaths {
  return {
    engineDir: join(paths.engineRoot, "ComfyUI"),
    executable: join(paths.llmRoot, "runtimes", "comfyui", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    modelConfigPath: join(paths.llmRoot, "config", "comfyui-extra-model-paths.yaml"),
    outputDir: join(paths.cacheDir, "comfyui-output"),
  };
}

export function localH3RuntimeInstalled(paths: FitzRuntimePaths, local = localComfyUIPaths(paths)): boolean {
  const models = join(paths.modelRoot, "comfyui");
  return [
    join(local.engineDir, "main.py"),
    local.executable,
    local.modelConfigPath,
    join(models, "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
    join(models, "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
    join(models, "vae", "minimax_h3_video_vae_fp16.safetensors"),
    join(models, "vae", "minimax_h3_audio_vae_fp32.safetensors"),
  ].every((path) => existsSync(path));
}

/** Registers the official local H3 recipe when the independently managed
 * ComfyUI runtime is present. This is deliberately additive: it never replaces
 * a user's existing video route assignment to a different provider. */
export function reconcileLocalComfyUIConfiguration(store: SqliteStore, paths: FitzRuntimePaths): boolean {
  const local = localComfyUIPaths(paths);
  if (!localH3RuntimeInstalled(paths, local)) return false;

  mkdirSync(local.outputDir, { recursive: true });
  const playbook = createComfyUIPlaybook({
    engineDir: local.engineDir,
    executable: local.executable,
    launchArgs: ["--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
  });
  for (const recipe of playbook.recipes) store.upsertRecipe(recipe);

  const videoRoute = store.listRoutes().find((route) => route.id === "video");
  if (!videoRoute || !store.listRecipes().some((recipe) => recipe.id === videoRoute.recipeId)) {
    store.upsertRoute(playbook.routes[0]!);
  }
  return true;
}
