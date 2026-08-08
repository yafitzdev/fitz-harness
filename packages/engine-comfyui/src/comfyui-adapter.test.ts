import { describe, expect, it } from "vitest";
import type { Recipe } from "@fitz/protocol";
import {
  ComfyUIEngineAdapter,
  readComfyUIConfiguration,
  substituteWorkflow,
  validateComfyUIConfiguration,
} from "./comfyui-adapter.js";

const VIDEO_WORKFLOW = {
  "1": { class_type: "HailuoVideoGenerate", inputs: { prompt: "{{prompt}}", seed: "{{seed}}", fps: "{{fps}}", width: "{{width}}", height: "{{height}}" } },
  "2": { class_type: "SaveVideo", inputs: { filename_prefix: "h3" } },
};

describe("validateComfyUIConfiguration", () => {
  it("accepts a valid managed recipe with an inline workflow", () => {
    const issues = validateComfyUIConfiguration(recipeFor({ executable: "python", cwd: "/engines/comfyui", comfyuiWorkflow: VIDEO_WORKFLOW }));
    expect(issues).toEqual([]);
  });

  it("accepts an external recipe with a workflow path", () => {
    const issues = validateComfyUIConfiguration(recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflowPath: "workflows/h3.json" }));
    expect(issues).toEqual([]);
  });

  it("requires exactly one pinned workflow", () => {
    expect(validateComfyUIConfiguration(recipeFor({ executable: "python", cwd: "/engines/comfyui" }))).toEqual([
      expect.objectContaining({ code: "missing_workflow" }),
    ]);
    expect(validateComfyUIConfiguration(recipeFor({
      executable: "python", cwd: "/engines/comfyui",
      comfyuiWorkflow: VIDEO_WORKFLOW, comfyuiWorkflowPath: "workflows/h3.json",
    }))).toEqual([
      expect.objectContaining({ code: "conflicting_workflow" }),
    ]);
  });

  it("rejects malformed workflows", () => {
    expect(validateComfyUIConfiguration(recipeFor({ executable: "python", cwd: "/e", comfyuiWorkflow: "{not json" }))).toEqual([
      expect.objectContaining({ code: "invalid_configuration" }),
    ]);
    expect(validateComfyUIConfiguration(recipeFor({ executable: "python", cwd: "/e", comfyuiWorkflow: { "1": { class_type: "X" } } }))).toEqual([
      expect.objectContaining({ code: "invalid_workflow_graph" }),
    ]);
  });

  it("rejects a managed recipe missing its launch pieces", () => {
    expect(validateComfyUIConfiguration(recipeFor({ cwd: "/engines/comfyui", comfyuiWorkflow: VIDEO_WORKFLOW }))).toEqual([
      expect.objectContaining({ code: "missing_executable" }),
    ]);
    expect(validateComfyUIConfiguration(recipeFor({ executable: "python", comfyuiWorkflow: VIDEO_WORKFLOW }))).toEqual([
      expect.objectContaining({ code: "missing_cwd" }),
    ]);
  });

  it("rejects reserved launch args and conflicting modes", () => {
    expect(validateComfyUIConfiguration(recipeFor({
      executable: "python", cwd: "/e", comfyuiWorkflow: VIDEO_WORKFLOW, launchArgs: ["--port=1"],
    }))).toEqual([expect.objectContaining({ code: "reserved_argument" })]);
    expect(validateComfyUIConfiguration(recipeFor({
      executable: "python", cwd: "/e", baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW,
    }))).toEqual([expect.objectContaining({ code: "conflicting_mode" })]);
  });

  it("rejects bad external endpoints", () => {
    expect(validateComfyUIConfiguration(recipeFor({ baseUrl: "ftp://127.0.0.1", comfyuiWorkflow: VIDEO_WORKFLOW }))).toEqual([
      expect.objectContaining({ code: "invalid_protocol" }),
    ]);
    expect(validateComfyUIConfiguration(recipeFor({ baseUrl: "http://user:pass@127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW }))).toEqual([
      expect.objectContaining({ code: "embedded_credentials" }),
    ]);
  });

  it("validates defaults and outputFormats types", () => {
    expect(validateComfyUIConfiguration(recipeFor({
      executable: "python", cwd: "/e", comfyuiWorkflow: VIDEO_WORKFLOW,
      defaults: { steps: "many" }, outputFormats: [1],
    }))).toEqual([expect.objectContaining({ code: "invalid_configuration" })]);
  });
});

describe("substituteWorkflow", () => {
  it("replaces {{placeholders}} from generation params", () => {
    const graph = substituteWorkflow(VIDEO_WORKFLOW, {
      prompt: "a red cube",
      seed: 7,
      size: "1280x720",
      fps: 30,
      durationSeconds: 5,
      steps: 24,
      guidance: 7.5,
      sampler: "euler",
    });
    expect(graph).toEqual({
      "1": {
        class_type: "HailuoVideoGenerate",
        inputs: { prompt: "a red cube", seed: 7, fps: 30, width: 1280, height: 720 },
      },
      "2": { class_type: "SaveVideo", inputs: { filename_prefix: "h3" } },
    });
  });

  it("applies node-id overrides and leaves missing params untouched", () => {
    const workflow = {
      "3": { class_type: "CLIPTextEncode", inputs: { text: "base" } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: "base" } },
      "5": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
    };
    const graph = substituteWorkflow(workflow, { prompt: "hello" }, {
      promptNodeId: "3", negativeNodeId: "4", seedNodeIds: ["5"],
    });
    expect(graph).toEqual({
      "3": { class_type: "CLIPTextEncode", inputs: { text: "hello" } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: "base" } },
      "5": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
    });
    // seed provided → node override applies; negative prompt absent → untouched
    const withParams = substituteWorkflow(workflow, { prompt: "hi", negativePrompt: "blur", seed: 99 }, {
      promptNodeId: "3", negativeNodeId: "4", seedNodeIds: ["5"],
    });
    expect(withParams["5"]).toEqual({ class_type: "KSampler", inputs: { seed: 99, steps: 20 } });
    expect(withParams["4"]).toEqual({ class_type: "CLIPTextEncode", inputs: { text: "blur" } });
  });

  it("never mutates the pinned workflow", () => {
    const original = structuredClone(VIDEO_WORKFLOW);
    substituteWorkflow(VIDEO_WORKFLOW, { prompt: "changed" });
    expect(VIDEO_WORKFLOW).toEqual(original);
  });
});

describe("ComfyUIEngineAdapter configuration surface", () => {
  it("reads the configuration with typed validation", () => {
    const config = readComfyUIConfiguration(recipeFor({
      executable: "python", cwd: "/engines/comfyui", expectedVramMiB: 24_576, readinessTimeoutMs: 30_000,
      comfyuiWorkflow: JSON.stringify(VIDEO_WORKFLOW), outputFormats: ["mp4"],
      defaults: { resolution: "1280x720", fps: 30 }, comfyuiOverrides: { promptNodeId: "1", seedNodeIds: ["1"] },
    }));
    expect(config).toMatchObject({
      executable: "python",
      cwd: "/engines/comfyui",
      expectedVramMiB: 24_576,
      readinessTimeoutMs: 30_000,
      outputFormats: ["mp4"],
      comfyuiOverrides: { promptNodeId: "1", seedNodeIds: ["1"] },
    });
    expect(config.comfyuiWorkflow).toEqual(VIDEO_WORKFLOW);
    expect(config.defaults).toEqual({ resolution: "1280x720", fps: 30 });
  });

  it("estimates VRAM from the recipe configuration", async () => {
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });
    await expect(adapter.estimateResources(recipeFor({ executable: "python", cwd: "/e", comfyuiWorkflow: VIDEO_WORKFLOW, expectedVramMiB: 24_576 })))
      .resolves.toEqual({ vramMiB: 24_576 });
    await expect(adapter.estimateResources(recipeFor({ executable: "python", cwd: "/e", comfyuiWorkflow: VIDEO_WORKFLOW })))
      .resolves.toEqual({});
  });

  it("builds a managed launch spec with Fitz-managed arguments", async () => {
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });
    const spec = await adapter.buildLaunchSpec(
      recipeFor({ executable: "/venv/bin/python", cwd: "/engines/comfyui", comfyuiWorkflow: VIDEO_WORKFLOW, launchArgs: ["--highvram"] }),
      { host: "127.0.0.1", port: 8188 },
    );
    expect(spec).toEqual({
      executable: "/venv/bin/python",
      args: ["main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch", "--highvram"],
      cwd: "/engines/comfyui",
      env: {},
      internalHost: "127.0.0.1",
      internalPort: 8188,
    });
  });

  it("builds an external launch spec that mirrors the base URL", async () => {
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });
    const spec = await adapter.buildLaunchSpec(
      recipeFor({ baseUrl: "http://127.0.0.1:9000", comfyuiWorkflow: VIDEO_WORKFLOW }),
      { host: "127.0.0.1", port: 8188 },
    );
    expect(spec).toMatchObject({ executable: "external-comfyui-server", internalHost: "127.0.0.1", internalPort: 9000 });
  });
});

function recipeFor(configuration: Record<string, unknown>): Recipe {
  return {
    id: "h3", playbookId: "comfyui", displayName: "H3", adapter: "comfyui", modelId: "h3", contextTokens: 4096,
    capabilities: { chatCompletions: false, streaming: false, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 60, minimumResidencySeconds: 0 },
    configuration,
  };
}
