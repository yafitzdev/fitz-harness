import { describe, expect, it } from "vitest";
import { mediaCardPresentation, mediaExecutionSettings, mediaPromptChain, type MediaCardJob } from "./media-card-model.js";

describe("media card model", () => {
  it.each([
    ["queued", "Image generation in progress"],
    ["started", "Image generation in progress"],
    ["progressing", "Image generation in progress"],
    ["completed", "Image ready"],
    ["failed", "Image generation failed"],
    ["cancelled", "Image generation cancelled"],
    ["interrupted", "Image generation failed"],
  ])("presents the %s generation state consistently", (status, title) => {
    expect(mediaCardPresentation({ id: "job", modality: "image", status }).title).toBe(title);
  });

  it.each([
    ["queued", "Image edit in progress"],
    ["completed", "Image ready"],
    ["failed", "Image edit failed"],
    ["cancelled", "Image edit cancelled"],
  ])("presents the %s edit state consistently", (status, title) => {
    expect(mediaCardPresentation({ id: "job", modality: "image", status, params: { operation: "edit" } }).title).toBe(title);
  });

  it("derives complete settings and a cycle-safe prompt chain", () => {
    const original: MediaCardJob = {
      id: "original", routeId: "image", modality: "image", status: "completed",
      execution: { recipeDisplayName: "Qwen Image", recipeId: "qwen", modelId: "qwen-model", adapter: "comfyui" },
      params: { prompt: "dog", size: "1024x1024", seed: 42, negativePrompt: "" },
    };
    const edit: MediaCardJob = {
      id: "edit", sourceJobId: "original", modality: "image", status: "completed",
      params: { operation: "edit", prompt: "make it a cat" },
    };
    const jobs = new Map([[original.id, original], [edit.id, edit]]);
    expect(mediaExecutionSettings(original)).toEqual(expect.arrayContaining([
      ["Model", "Qwen Image"], ["Engine", "ComfyUI"], ["Resolution", "1024x1024"], ["Seed", "42"], ["Negative prompt", "None"],
    ]));
    expect(mediaPromptChain(edit, (job) => job.sourceJobId ? jobs.get(job.sourceJobId) : undefined)).toEqual([
      { jobId: "original", label: "Original", prompt: "dog" },
      { jobId: "edit", label: "Edit 1", prompt: "make it a cat" },
    ]);
    original.sourceJobId = "edit";
    expect(mediaPromptChain(edit, (job) => job.sourceJobId ? jobs.get(job.sourceJobId) : undefined)).toHaveLength(2);
  });

  it("presents animation state and labels image-to-video lineage", () => {
    const original: MediaCardJob = { id: "original", modality: "image", status: "completed", params: { prompt: "dog swimming" } };
    const animation: MediaCardJob = {
      id: "animation", sourceJobId: "original", modality: "video", status: "queued",
      params: { operation: "animate", prompt: "slow underwater tracking shot" },
    };
    expect(mediaCardPresentation(animation).title).toBe("Video animation in progress");
    expect(mediaExecutionSettings(animation)).toContainEqual(["Operation", "Animate"]);
    expect(mediaPromptChain(animation, (job) => job.sourceJobId ? original : undefined)).toEqual([
      { jobId: "original", label: "Original", prompt: "dog swimming" },
      { jobId: "animation", label: "Animation 1", prompt: "slow underwater tracking shot" },
    ]);
  });
});
