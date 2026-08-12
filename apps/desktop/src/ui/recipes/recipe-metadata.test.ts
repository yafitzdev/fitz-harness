// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { recipeMetadata } from "./recipe-metadata.js";

describe("recipeMetadata", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("shows text context only for chat recipes", () => {
    const labels = recipeMetadata({ modelId: "qwen.gguf", contextTokens: 131_072, capabilities: { chatCompletions: true } });
    expect(labels.map((label) => label.textContent)).toEqual(["qwen.gguf", "Text", "131k ctx", "Sequential"]);
  });

  it("shows declared concurrent generation capacity for chat recipes", () => {
    const labels = recipeMetadata({ modelId: "worker", contextTokens: 32_768, capabilities: { chatCompletions: true, maxConcurrentGenerations: 8 } });
    expect(labels.map((label) => label.textContent)).toContain("8 concurrent");
  });

  it("shows media modalities and limits without a context badge", () => {
    const labels = recipeMetadata({
      modelId: "minimax-h3",
      contextTokens: 1,
      capabilities: { chatCompletions: false, modalities: { output: ["video", "audio"], limits: { maxDurationSeconds: 8, maxFps: 30, maxResolution: "1080p" } } },
    });
    expect(labels.map((label) => label.textContent)).toEqual(["minimax-h3", "Video", "Audio", "≤8s", "≤30fps", "≤1080p"]);
  });
});
