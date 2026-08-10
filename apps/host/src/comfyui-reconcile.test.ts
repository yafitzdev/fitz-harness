import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
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
    expect(store.getEngine("comfyui")).toMatchObject({ folderName: "ComfyUI", displayName: "comfyui", connectionMode: "managed", performanceMode: "safe" });
    expect(store.getEngine("comfyui")?.launchArguments).toContain(local.baseDir);
    expect(localComfyUIRecipeIds(paths)).toEqual(["h3-video"]);
    expect(store.listRecipes().filter((recipe) => recipe.playbookId === "comfyui")).toEqual([
      expect.objectContaining({ id: "h3-video", playbookId: "comfyui" }),
    ]);
    store.close();
  });

  it("discovers and registers video variants and text-to-image independently", () => {
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
      join(paths.modelRoot, "comfyui", "diffusion_models", "pinkcherry-h3", "alpha-0.5-testing", "PinkCherry_h3_fl2va_pruned_int8_v0.5-alpha.safetensors"),
      join(paths.modelRoot, "comfyui", "diffusion_models", "krea2_turbo_nvfp4.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
      join(paths.modelRoot, "comfyui", "text_encoders", "qwen3vl_4b_fp8_scaled.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_video_vae_fp16.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "minimax_h3_audio_vae_fp32.safetensors"),
      join(paths.modelRoot, "comfyui", "vae", "qwen_image_vae.safetensors"),
    ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture"); }

    expect(localComfyUIRecipeIds(paths)).toEqual(["h3-video", "pinkcherry-h3-video", "krea2-turbo-image"]);
    const store = SqliteStore.memory();
    expect(reconcileLocalComfyUIConfiguration(store, paths)).toBe(true);
    expect(store.listRecipes().filter((recipe) => recipe.playbookId === "comfyui").map((recipe) => recipe.id).sort()).toEqual([
      "h3-video",
      "krea2-turbo-image",
      "pinkcherry-h3-video",
    ]);
    expect(store.listRoutes()).toContainEqual(expect.objectContaining({ id: "video", recipeId: "h3-video" }));
    expect(store.listRoutes()).toContainEqual(expect.objectContaining({ id: "image", recipeId: "krea2-turbo-image" }));
    store.close();
  });
});
