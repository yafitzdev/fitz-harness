import { describe, expect, it } from "vitest";
import type { ConsumerConnectionSummary } from "../../preload.js";
import {
  buildConnectionViews,
  connectionMatches,
  connectionSearchValues,
  localRecipes,
  LOCAL_CONNECTION_ID,
} from "./connection-workspace-model.js";

function configuration() {
  return {
    recipes: [
      {
        id: "local-llama",
        playbookId: "llama.cpp",
        displayName: "Llama local",
        modelId: "llama.gguf",
        contextTokens: 32_768,
        capabilities: { chatCompletions: true, maxConcurrentGenerations: 3 },
      },
      {
        id: "local-ninfer",
        playbookId: "ninfer",
        displayName: "Qwen local",
        modelId: "qwen.gguf",
        contextTokens: 131_072,
        capabilities: { chatCompletions: true },
      },
      {
        id: "local-video",
        playbookId: "comfyui",
        displayName: "Video local",
        modelId: "video-model",
        capabilities: {
          chatCompletions: false,
          modalities: { output: ["video", "audio"], limits: { maxDurationSeconds: 6 } },
        },
      },
      {
        id: "consumer-recipe--remote",
        playbookId: "remote",
        displayName: "Remote recipe",
        modelId: "remote-model",
        contextTokens: 99_999,
        capabilities: { chatCompletions: true },
      },
    ],
    engineFolders: [
      { folderName: "llama.cpp", engine: { displayName: "llama.cpp" } },
      { folderName: "ninfer", engine: { displayName: "NInfer" } },
      { folderName: "comfyui", engine: { displayName: "ComfyUI" } },
    ],
  };
}

function remoteConnection(): ConsumerConnectionSummary {
  return {
    id: "remote-1",
    displayName: "Remote API",
    baseUrl: "https://remote.test/v1",
    authType: "bearer",
    hasCredential: true,
    template: "openai-compatible",
    executionClass: "metered_cloud",
    accessClass: "public_remote",
    models: [{ id: "remote-model", recipeId: "consumer-recipe--remote" }],
    mediaModels: [
      { id: "remote-image", routeId: "image", recipeId: "consumer-media", modality: "image", template: "openai-media" },
      { id: "remote-video", routeId: "video", recipeId: "consumer-media", modality: "video", template: "openai-media" },
      { id: "other-image", routeId: "image", recipeId: "consumer-other", modality: "image", template: "fal" },
    ],
    updatedAt: "now",
  };
}

describe("connection workspace model", () => {
  it("groups local recipes by engine and separates chat and media models", () => {
    const views = buildConnectionViews(configuration(), []);

    expect(views.map((view) => view.id)).toEqual([
      `${LOCAL_CONNECTION_ID}--llama.cpp`,
      `${LOCAL_CONNECTION_ID}--ninfer`,
      `${LOCAL_CONNECTION_ID}--comfyui`,
    ]);
    const llama = views[0]!;
    expect(llama.hosted).toBe(true);
    expect(llama.displayName).toBe("llama.cpp");
    expect(llama.availableModels).toMatchObject([{ recipeId: "local-llama", modelId: "llama.gguf", contextTokens: 32_768, maxConcurrentGenerations: 3 }]);
    expect(llama.availableMediaModels).toEqual([]);
    expect(views[1]!.availableModels).toMatchObject([{ recipeId: "local-ninfer", engine: "ninfer", maxConcurrentGenerations: 1 }]);
    expect(views[2]!.availableModels).toEqual([]);
    expect(views[2]!.availableMediaModels).toMatchObject([{ recipeId: "local-video", displayName: "Video local", modalities: ["video", "audio"], engine: "comfyui" }]);
    expect(localRecipes(configuration()).map((recipe) => recipe.id)).not.toContain("consumer-recipe--remote");
  });

  it("enriches saved models and deduplicates media routes per recipe", () => {
    const saved = buildConnectionViews(configuration(), [remoteConnection()]).find((candidate) => !candidate.hosted)!;
    expect(saved.hosted).toBe(false);
    expect(saved.source.id).toBe("remote-1");
    expect(saved.availableModels).toMatchObject([{
      id: "remote-model",
      displayName: "Remote recipe",
      modelId: "remote-model",
      contextTokens: 99_999,
      engine: "openai-compatible",
      maxConcurrentGenerations: 1,
    }]);
    expect(saved.availableMediaModels).toHaveLength(2);
    expect(saved.availableMediaModels[0]).toMatchObject({ recipeId: "consumer-media", modelId: "remote-image", modalities: ["image", "video"], engine: "openai-media" });
  });

  it("matches providers, models, engines, and empty searches consistently", () => {
    const [connection] = buildConnectionViews(configuration(), []);
    expect(connectionMatches(connection!, "")).toBe(true);
    expect(connectionMatches(connection!, "LLAMA.GGUF")).toBe(true);
    expect(connectionMatches(connection!, "llama.cpp")).toBe(true);
    expect(connectionMatches(connection!, "missing-model")).toBe(false);
    expect(connectionSearchValues(connection!)).toContain("Llama local");
  });
});
