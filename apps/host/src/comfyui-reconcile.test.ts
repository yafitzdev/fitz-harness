import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { createComfyUIPlaybook } from "./comfyui-playbook.js";
import { localComfyUIPaths, localComfyUIRecipeIds, reconcileLocalComfyUIConfiguration } from "./comfyui-reconcile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local ComfyUI reconciliation", () => {
  it("registers the installed engine and H3 recipe as one configured playbook", () => {
    const root = mkdtempSync(join(tmpdir(), "fitz-comfy-reconcile-")); roots.push(root);
    const paths: FitzRuntimePaths = {
      dataRoot: join(root, "data"), databasePath: join(root, "data", "fitz.db"), piAgentDir: join(root, "data", "pi"),
      logsDir: join(root, "data", "logs"), cacheDir: join(root, "data", "cache"), llmRoot: join(root, "llm"),
      engineRoot: join(root, "llm", "engines"), modelRoot: join(root, "llm", "models"), snapshotsDir: join(root, "data", "snapshots"),
    };
    const local = localComfyUIPaths(paths);
    for (const file of [
      join(local.engineDir, "main.py"), local.executable, local.modelConfigPath,
      join(paths.modelRoot, "comfyui", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_video_vae_fp16.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_audio_vae_fp32.safetensors"),
    ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture"); }
    const store = SqliteStore.memory();
    expect(reconcileLocalComfyUIConfiguration(store, paths)).toBe(true);
    expect(store.getEngine("comfyui")).toMatchObject({ folderName: "ComfyUI", displayName: "comfyui", connectionMode: "managed" });
    expect(store.getEngine("comfyui")?.launchArguments).toContain(local.baseDir);
    expect(localComfyUIRecipeIds(paths)).toEqual(["h3-video"]);
    expect(store.listRecipes().filter((recipe) => recipe.playbookId === "comfyui")).toEqual([
      expect.objectContaining({ id: "h3-video", playbookId: "comfyui" }),
    ]);
    store.close();
  });

  it("discovers H3, Krea variants, and the unified Qwen generation/edit recipe", () => {
    const root = mkdtempSync(join(tmpdir(), "fitz-comfy-reconcile-all-")); roots.push(root);
    const paths: FitzRuntimePaths = {
      dataRoot: join(root, "data"), databasePath: join(root, "data", "fitz.db"), piAgentDir: join(root, "data", "pi"),
      logsDir: join(root, "data", "logs"), cacheDir: join(root, "data", "cache"), llmRoot: join(root, "llm"),
      engineRoot: join(root, "llm", "engines"), modelRoot: join(root, "llm", "models"), snapshotsDir: join(root, "data", "snapshots"),
    };
    const local = localComfyUIPaths(paths);
    for (const file of [
      join(local.engineDir, "main.py"), local.executable, local.modelConfigPath,
      join(paths.modelRoot, "comfyui", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
      join(paths.modelRoot, "comfyui", "diffusion_models", "krea2_turbo_nvfp4.safetensors"),
      join(paths.modelRoot, "comfyui", "diffusion_models", "qwen_image_2512_fp8_e4m3fn.safetensors"),
      join(paths.modelRoot, "comfyui", "diffusion_models", "qwen_image_edit_2511_int8_convrot.safetensors"),
      join(paths.modelRoot, "comfyui", "loras", "KNP_V2_copy_copy.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_4b_fp8_scaled.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen_2.5_vl_7b_fp8_scaled.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_video_vae_fp16.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_audio_vae_fp32.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "qwen_image_vae.safetensors"),
    ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture"); }

    expect(localComfyUIRecipeIds(paths)).toEqual(["h3-video", "krea2-turbo-image", "krea2-nsfw-image", "qwen-image"]);
    const store = SqliteStore.memory();
    expect(reconcileLocalComfyUIConfiguration(store, paths)).toBe(true);
    expect(store.listRecipes().filter((recipe) => recipe.playbookId === "comfyui").map((recipe) => recipe.id).sort()).toEqual([
      "h3-video",
      "krea2-nsfw-image",
      "krea2-turbo-image",
      "qwen-image",
    ]);
    expect(store.listRoutes()).toContainEqual(expect.objectContaining({ id: "video", recipeId: "h3-video" }));
    expect(store.listRoutes()).toContainEqual(expect.objectContaining({ id: "image", recipeId: "qwen-image" }));
    store.close();
  });

  it("removes the retired PinkCherry recipe and repairs its route", () => {
    const root = mkdtempSync(join(tmpdir(), "fitz-comfy-reconcile-retired-")); roots.push(root);
    const paths: FitzRuntimePaths = {
      dataRoot: join(root, "data"), databasePath: join(root, "data", "fitz.db"), piAgentDir: join(root, "data", "pi"),
      logsDir: join(root, "data", "logs"), cacheDir: join(root, "data", "cache"), llmRoot: join(root, "llm"),
      engineRoot: join(root, "llm", "engines"), modelRoot: join(root, "llm", "models"), snapshotsDir: join(root, "data", "snapshots"),
    };
    const local = localComfyUIPaths(paths);
    for (const file of [
      join(local.engineDir, "main.py"), local.executable, local.modelConfigPath,
      join(paths.modelRoot, "comfyui", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_video_vae_fp16.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_audio_vae_fp32.safetensors"),
    ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture"); }

    const store = SqliteStore.memory();
    const retired = createComfyUIPlaybook({ engineDir: local.engineDir }).recipes[0]!;
    store.upsertRecipe({ ...retired, id: "pinkcherry-h3-video", modelId: "retired-pinkcherry" });
    store.upsertRoute({ id: "video", displayName: "Video generation", recipeId: "pinkcherry-h3-video", kind: "video", enabled: true });

    expect(reconcileLocalComfyUIConfiguration(store, paths)).toBe(true);
    expect(store.listRecipes().some((recipe) => recipe.id === "pinkcherry-h3-video")).toBe(false);
    expect(store.listRoutes()).toContainEqual(expect.objectContaining({ id: "video", recipeId: "h3-video" }));
    store.close();
  });

  it("preserves user-edited recipe names when startup discovery refreshes operational configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "fitz-comfy-reconcile-name-")); roots.push(root);
    const paths: FitzRuntimePaths = {
      dataRoot: join(root, "data"), databasePath: join(root, "data", "fitz.db"), piAgentDir: join(root, "data", "pi"),
      logsDir: join(root, "data", "logs"), cacheDir: join(root, "data", "cache"), llmRoot: join(root, "llm"),
      engineRoot: join(root, "llm", "engines"), modelRoot: join(root, "llm", "models"), snapshotsDir: join(root, "data", "snapshots"),
    };
    const local = localComfyUIPaths(paths);
    for (const file of [
      join(local.engineDir, "main.py"), local.executable, local.modelConfigPath,
      join(paths.modelRoot, "comfyui", "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_video_vae_fp16.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_audio_vae_fp32.safetensors"),
    ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture"); }

    const store = SqliteStore.memory();
    reconcileLocalComfyUIConfiguration(store, paths);
    const recipe = store.listRecipes().find((candidate) => candidate.id === "h3-video")!;
    store.upsertRecipe({ ...recipe, displayName: "My H3 video model", configuration: { stale: true } });

    reconcileLocalComfyUIConfiguration(store, paths);

    expect(store.listRecipes().find((candidate) => candidate.id === "h3-video")).toMatchObject({
      displayName: "My H3 video model",
      configuration: expect.not.objectContaining({ stale: true }),
    });
    store.close();
  });
});
