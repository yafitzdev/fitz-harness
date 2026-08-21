import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { managedLinuxRuntimeLayout } from "./managed-linux-runtime.js";
import {
  createComfyUIPlaybook,
  RETIRED_COMFYUI_RECIPE_IDS,
  type ComfyUIRecipeId,
} from "./comfyui-playbook.js";

export interface LocalComfyUIPaths {
  hostBaseDir: string;
  hostEngineDir: string;
  hostEnvironmentMarker: string;
  hostModelConfigPath: string;
  hostOutputDir: string;
  baseDir: string;
  engineDir: string;
  executable: string;
  modelConfigPath: string;
  outputDir: string;
}

export function localComfyUIPaths(paths: FitzRuntimePaths): LocalComfyUIPaths {
  const runtime = managedLinuxRuntimeLayout(paths);
  return {
    hostBaseDir: join(paths.llmRoot, "config", "comfyui"),
    hostEngineDir: join(paths.engineRoot, "ComfyUI"),
    hostEnvironmentMarker: join(paths.environmentRoot, "comfyui", "pyvenv.cfg"),
    hostModelConfigPath: join(paths.llmRoot, "config", "comfyui-extra-model-paths.yaml"),
    hostOutputDir: join(paths.llmRoot, "logs", "comfyui-output"),
    baseDir: `${runtime.guestRoot}/config/comfyui`,
    engineDir: `${runtime.engineRoot}/ComfyUI`,
    executable: `${runtime.environmentRoot}/comfyui/bin/python`,
    modelConfigPath: `${runtime.guestRoot}/config/comfyui-extra-model-paths.yaml`,
    outputDir: `${runtime.logRoot}/comfyui-output`,
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

export function localH3ReferenceModelInstalled(paths: FitzRuntimePaths): boolean {
  return existsSync(join(paths.modelRoot, "comfyui", "diffusion_models", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"));
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
    join(models, "diffusion_models", "minimax_music3_dit_fp16.safetensors"),
    join(models, "text_encoders", "minimax_music3_text_encoder_pruned_int8_convrot.safetensors"),
    join(models, "vae", "minimax_music3_dav.safetensors"),
  ].every((path) => existsSync(path))) installed.push("minimax-music3-audio");
  const krea2BaseFiles = [
    join(models, "diffusion_models", "krea2_turbo_nvfp4.safetensors"),
    join(models, "text_encoders", "qwen3vl_4b_fp8_scaled.safetensors"),
    join(models, "vae", "qwen_image_vae.safetensors"),
  ];
  if (krea2BaseFiles.every((path) => existsSync(path))) installed.push("krea2-turbo-image");
  if ([...krea2BaseFiles, join(models, "loras", "KNP_V2_copy_copy.safetensors")]
    .every((path) => existsSync(path))) installed.push("krea2-nsfw-image");
  const qwenImageFiles = [
    join(models, "diffusion_models", "qwen_image_2512_fp8_e4m3fn.safetensors"),
    join(models, "diffusion_models", "qwen_image_edit_2511_int8_convrot.safetensors"),
    join(models, "text_encoders", "qwen_2.5_vl_7b_fp8_scaled.safetensors"),
    join(models, "vae", "qwen_image_vae.safetensors"),
  ];
  if (qwenImageFiles.every((path) => existsSync(path))) installed.push("qwen-image");
  return installed;
}

/** Registers every complete local ComfyUI recipe, removes explicitly retired
 * built-ins, and never replaces any remaining valid media route assignment. */
export function reconcileLocalComfyUIConfiguration(store: SqliteStore, paths: FitzRuntimePaths): boolean {
  const local = localComfyUIPaths(paths);
  let changed = false;
  for (const retiredRecipeId of RETIRED_COMFYUI_RECIPE_IDS) {
    for (const route of store.listRoutes().filter((candidate) => candidate.recipeId === retiredRecipeId)) {
      store.deleteRoute(route.id);
      changed = true;
    }
    if (store.listRecipes().some((candidate) => candidate.id === retiredRecipeId)) {
      store.deleteRecipe(retiredRecipeId);
      changed = true;
    }
  }

  if (!localComfyUIRuntimeInstalled(local)) return changed;

  const recipeIds = localComfyUIRecipeIds(paths, local);
  if (recipeIds.length === 0) return changed;

  mkdirSync(local.hostOutputDir, { recursive: true });
  const playbook = createComfyUIPlaybook({
    engineDir: local.engineDir,
    executable: local.executable,
    launchArgs: ["--base-directory", local.baseDir, "--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
    runtime: "linux-managed",
    runtimeId: "inference-linux",
    recipeIds,
    h3ReferenceEnabled: recipeIds.includes("h3-video") && localH3ReferenceModelInstalled(paths),
  });
  const now = new Date().toISOString();
  const existingEngine = store.getEngine(playbook.id);
  if (!existingEngine) {
    store.upsertEngine({
      id: playbook.id,
      folderName: "ComfyUI",
      displayName: playbook.displayName,
      connectionMode: "managed",
      runtime: "linux-managed",
      baseUrl: "http://127.0.0.1",
      healthPath: "/system_stats",
      launchCommand: local.executable,
      launchArguments: ["main.py", "--base-directory", local.baseDir, "--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
      workingDirectory: ".",
      runtimeId: "inference-linux",
      createdAt: now,
      updatedAt: now,
    });
  }
  const existingRecipes = new Map(store.listRecipes().map((recipe) => [recipe.id, recipe]));
  for (const recipe of playbook.recipes) {
    const existing = existingRecipes.get(recipe.id);
    // Discovery owns the executable model contract, while the display name is
    // user-owned. Reapplying the manifest must never undo a rename on restart.
    store.upsertRecipe(existing ? { ...recipe, displayName: existing.displayName } : recipe);
  }

  const recipes = store.listRecipes();
  const discoveredRecipes = new Map(playbook.recipes.map((recipe) => [recipe.id, recipe]));
  // A recipe capability may become narrower as its routing contract is
  // corrected. Never retain an assignment that discovery can no longer
  // execute: H3's synchronized soundtrack belongs to its MP4 artifact and
  // does not make H3 an audio-generation route.
  for (const existingRoute of store.listRoutes()) {
    const discoveredRecipe = discoveredRecipes.get(existingRoute.recipeId);
    const routeKind = existingRoute.kind ?? "chat";
    if (routeKind === "chat" || !discoveredRecipe || discoveredRecipe.capabilities.modalities?.output.includes(routeKind)) continue;
    store.upsertRoute({ ...existingRoute, recipeId: "", enabled: false });
    changed = true;
  }
  for (const route of playbook.routes) {
    const existing = store.listRoutes().find((candidate) => candidate.id === route.id);
    const migrateBuiltInImageRoute = route.id === "image"
      && route.recipeId === "qwen-image"
      && existing !== undefined
      && ["krea2-turbo-image", "krea2-nsfw-image"].includes(existing.recipeId);
    if (!existing || !recipes.some((recipe) => recipe.id === existing.recipeId) || migrateBuiltInImageRoute) store.upsertRoute(route);
  }
  return true;
}

function localComfyUIRuntimeFiles(local: LocalComfyUIPaths): string[] {
  // Linux venv executables are symlinks. Through the WSL UNC provider Node can
  // report those symlinks as EISDIR, so discovery uses the regular venv marker
  // while launch still uses the guest `bin/python` path.
  return [join(local.hostEngineDir, "main.py"), local.hostEnvironmentMarker, local.hostModelConfigPath];
}

function localH3SharedFiles(models: string): string[] {
  return [
    join(models, "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
    join(models, "vae", "minimax_h3_video_vae_fp16.safetensors"),
    join(models, "vae", "minimax_h3_audio_vae_fp32.safetensors"),
  ];
}
