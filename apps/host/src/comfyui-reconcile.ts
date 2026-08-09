import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { createComfyUIPlaybook, type ComfyUIRecipeId } from "./comfyui-playbook.js";

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
    ...localComfyUIRuntimeFiles(local),
    join(models, "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
    ...localH3SharedFiles(models),
  ].every((path) => existsSync(path));
}

export function localComfyUIRuntimeInstalled(local: LocalComfyUIPaths): boolean {
  return localComfyUIRuntimeFiles(local).every((path) => existsSync(path));
}

export function localComfyUIRecipeIds(paths: FitzRuntimePaths, local = localComfyUIPaths(paths)): ComfyUIRecipeId[] {
  if (!localComfyUIRuntimeInstalled(local)) return [];
  const models = join(paths.modelRoot, "comfyui");
  const installed: ComfyUIRecipeId[] = [];
  if ([
    join(models, "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
    ...localH3SharedFiles(models),
  ].every((path) => existsSync(path))) installed.push("h3-video");
  if ([
    join(models, "diffusion_models", "pinkcherry-h3", "alpha-0.5-testing", "PinkCherry_h3_fl2va_pruned_int8_v0.5-alpha.safetensors"),
    ...localH3SharedFiles(models),
  ].every((path) => existsSync(path))) installed.push("pinkcherry-h3-video");
  if ([
    join(models, "diffusion_models", "krea2_turbo_nvfp4.safetensors"),
    join(models, "text_encoders", "qwen3vl_4b_fp8_scaled.safetensors"),
    join(models, "vae", "qwen_image_vae.safetensors"),
  ].every((path) => existsSync(path))) installed.push("krea2-turbo-image");
  return installed;
}

/** Registers every complete local ComfyUI recipe. This is deliberately
 * additive: it never replaces a user's valid media route assignment. */
export function reconcileLocalComfyUIConfiguration(store: SqliteStore, paths: FitzRuntimePaths): boolean {
  const local = localComfyUIPaths(paths);
  const recipeIds = localComfyUIRecipeIds(paths, local);
  if (recipeIds.length === 0) return false;

  mkdirSync(local.outputDir, { recursive: true });
  const playbook = createComfyUIPlaybook({
    engineDir: local.engineDir,
    executable: local.executable,
    launchArgs: ["--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
    recipeIds,
  });
  const now = new Date().toISOString();
  const existingEngine = store.getEngine(playbook.id);
  if (!existingEngine) {
    store.upsertEngine({
      id: playbook.id,
      folderName: "ComfyUI",
      displayName: playbook.displayName,
      connectionMode: "managed",
      runtime: "windows",
      baseUrl: "http://127.0.0.1",
      healthPath: "/system_stats",
      launchCommand: local.executable,
      launchArguments: ["main.py", "--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
      workingDirectory: ".",
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const recipe of playbook.recipes) store.upsertRecipe(recipe);

  const recipes = store.listRecipes();
  for (const route of playbook.routes) {
    const existing = store.listRoutes().find((candidate) => candidate.id === route.id);
    if (!existing || !recipes.some((recipe) => recipe.id === existing.recipeId)) store.upsertRoute(route);
  }
  return true;
}

function localComfyUIRuntimeFiles(local: LocalComfyUIPaths): string[] {
  return [join(local.engineDir, "main.py"), local.executable, local.modelConfigPath];
}

function localH3SharedFiles(models: string): string[] {
  return [
    join(models, "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
    join(models, "vae", "minimax_h3_video_vae_fp16.safetensors"),
    join(models, "vae", "minimax_h3_audio_vae_fp32.safetensors"),
  ];
}
