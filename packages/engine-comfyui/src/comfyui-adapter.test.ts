import { describe, expect, it } from "vitest";
import type { MediaGenerationRequest, Recipe } from "@fitz/protocol";
import {
  ComfyUIEngineAdapter,
  readComfyUIConfiguration,
  substituteWorkflow,
  validateComfyUIConfiguration,
} from "./comfyui-adapter.js";
import { ComfyUIProgressListener, type ComfyUIWebSocket } from "./comfyui-client.js";

const VIDEO_WORKFLOW = {
  "1": { class_type: "HailuoVideoGenerate", inputs: { prompt: "{{prompt}}", seed: "{{seed}}", fps: "{{fps}}", width: "{{width}}", height: "{{height}}" } },
  "2": { class_type: "SaveVideo", inputs: { filename_prefix: "h3" } },
};
const EDIT_WORKFLOW = {
  "8": { class_type: "LoadImage", inputs: { image: "{{ref_0}}" } },
  "9": { class_type: "ImageEdit", inputs: { image: ["8", 0], prompt: "{{prompt}}" } },
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

  it("requires a runtime id for managed Linux recipes", () => {
    expect(validateComfyUIConfiguration(recipeFor({
      executable: "/venv/bin/python", cwd: "/engines/comfyui", runtime: "linux-managed", comfyuiWorkflow: VIDEO_WORKFLOW,
    }))).toEqual([expect.objectContaining({ code: "missing_runtime_id" })]);
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

describe("ComfyUI effective generation parameters", () => {
  it("resolves recipe defaults and a durable random seed before submission", () => {
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false });
    const params = adapter.resolveParams(recipeFor({
      baseUrl: "http://127.0.0.1:8188",
      comfyuiWorkflow: VIDEO_WORKFLOW,
      defaults: { resolution: "1024x1024", sampler: "euler", steps: 40, guidance: 4 },
    }), { prompt: "a dog" });
    expect(params).toEqual({
      prompt: "a dog",
      negativePrompt: "",
      size: "1024x1024",
      sampler: "euler",
      steps: 40,
      guidance: 4,
      seed: expect.any(Number),
    });
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

  it("substitutes uploaded reference filenames into edit workflows", () => {
    const graph = substituteWorkflow(
      { "1": { class_type: "LoadImage", inputs: { image: "{{ref_0}}" } } },
      { prompt: "make it blue", refs: [{ url: "data:image/png;base64,AA==" }] },
      {},
      ["fitz-reference.png"],
    );
    expect(graph["1"]).toEqual({ class_type: "LoadImage", inputs: { image: "fitz-reference.png" } });
  });

  it("substitutes {{fps}} inside embedded expressions (H3 frame count)", () => {
    const workflow = {
      "111": { class_type: "PrimitiveFloat", inputs: { value: "{{duration_seconds}}" } },
      "107": {
        class_type: "ComfyMathExpression",
        inputs: {
          expression: "max(5, round(a * {{fps}})) + (5 - (max(5, round(a * {{fps}})) % 17)) % 17",
          "values.a": ["111", 0],
        },
      },
      "91": { class_type: "CreateVideo", inputs: { fps: "{{fps}}" } },
    };
    const graph = substituteWorkflow(workflow, { prompt: "x", durationSeconds: 10, fps: 30 });
    expect(graph["107"].inputs.expression).toBe("max(5, round(a * 30)) + (5 - (max(5, round(a * 30)) % 17)) % 17");
    expect(graph["91"].inputs.fps).toBe(30);
  });
});

describe("ComfyUIEngineAdapter configuration surface", () => {
  it("reads the configuration with typed validation", () => {
    const config = readComfyUIConfiguration(recipeFor({
      executable: "python", cwd: "/engines/comfyui", expectedVramMiB: 24_576, readinessTimeoutMs: 30_000,
      comfyuiWorkflow: JSON.stringify(VIDEO_WORKFLOW), outputFormats: ["mp4"],
      comfyuiEditWorkflow: VIDEO_WORKFLOW,
      comfyuiAnimateWorkflow: VIDEO_WORKFLOW,
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
    expect(config.comfyuiEditWorkflow).toEqual(VIDEO_WORKFLOW);
    expect(config.comfyuiAnimateWorkflow).toEqual(VIDEO_WORKFLOW);
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

  it("builds a managed Linux launch through the named inference runtime", async () => {
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      linuxRuntimes: new Map([["inference-linux", { distribution: "Fitz-Inference" }]]),
    });
    const spec = await adapter.buildLaunchSpec(
      recipeFor({
        executable: "/opt/fitz/llm/environments/comfyui/bin/python",
        cwd: "/opt/fitz/llm/engines/ComfyUI",
        runtime: "linux-managed",
        runtimeId: "inference-linux",
        comfyuiWorkflow: VIDEO_WORKFLOW,
        launchArgs: ["--base-directory", "/opt/fitz/llm/config/comfyui"],
      }),
      { host: "127.0.0.1", port: 8188 },
    );
    expect(spec).toEqual({
      executable: "wsl.exe",
      args: [
        "-d", "Fitz-Inference", "-u", "root", "--", "sh", "-s", "--",
        "/opt/fitz/llm/engines/ComfyUI", "/opt/fitz/llm/environments/comfyui/bin/python",
        "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch",
        "--base-directory", "/opt/fitz/llm/config/comfyui",
      ],
      env: {}, internalHost: "127.0.0.1", internalPort: 8188,
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

// ---------------------------------------------------------------------------
// WebSocket progress (modern ComfyUI builds stream progress over /ws; there is
// no HTTP /progress route, see comfyui-client.ts)
// ---------------------------------------------------------------------------

class FakeWebSocket implements ComfyUIWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  url = "";
  closed = false;

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  close(): void {
    this.closed = true;
  }
}

describe("ComfyUIProgressListener", () => {
  it("tracks the latest progress fraction per prompt from /ws messages", () => {
    const sockets: FakeWebSocket[] = [];
    const listener = new ComfyUIProgressListener({
      baseUrl: "http://127.0.0.1:8188",
      clientId: "client-1",
      createSocket: (url) => {
        const socket = new FakeWebSocket();
        socket.url = url;
        sockets.push(socket);
        return socket;
      },
    });
    const socket = sockets[0]!;
    expect(socket.url).toBe("ws://127.0.0.1:8188/ws?clientId=client-1");

    // Non-progress envelopes, binary preview frames, malformed JSON, and
    // progress without a prompt id are all ignored.
    expect(listener.progress("p1")).toBeUndefined();
    socket.emit({ type: "status", data: { status: { exec_info: {} } } });
    socket.emitRaw(new Uint8Array([0x00, 0x01, 0x02]));
    socket.emitRaw("not json");
    socket.emitRaw('{"type":"progress","data":{"value":1,"max":10}}');
    expect(listener.progress("p1")).toBeUndefined();

    socket.emit({ type: "progress", data: { value: 5, max: 20, prompt_id: "p1", node: "9" } });
    expect(listener.progress("p1")).toBeCloseTo(0.25);
    socket.emit({ type: "progress", data: { value: 25, max: 20, prompt_id: "p1", node: "9" } });
    expect(listener.progress("p1")).toBe(1); // clamped to 1
    socket.emit({ type: "progress", data: { value: 1, max: 10, prompt_id: "p2", node: "5" } });
    expect(listener.progress("p2")).toBeCloseTo(0.1);
    expect(listener.progress("p1")).toBe(1); // per-prompt isolation

    listener.close();
    expect(socket.closed).toBe(true);
    listener.close(); // idempotent
    expect(socket.closed).toBe(true);
  });

  it("preserves a reverse-proxy base path in the WebSocket endpoint", () => {
    const sockets: FakeWebSocket[] = [];
    const listener = new ComfyUIProgressListener({
      baseUrl: "https://media.example.test/comfy/",
      clientId: "proxy-client",
      createSocket: (url) => {
        const socket = new FakeWebSocket();
        socket.url = url;
        sockets.push(socket);
        return socket;
      },
    });
    expect(sockets[0]?.url).toBe("wss://media.example.test/comfy/ws?clientId=proxy-client");
    listener.close();
  });
});

describe("ComfyUIEngineAdapter progress streaming", () => {
  it("selects the edit graph only for an explicit edit operation", async () => {
    let submitted: Record<string, unknown> | undefined;
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      createWebSocket: () => new FakeWebSocket(),
      fetch: stubFetch({ captureSubmit: (body) => { submitted = body; } }),
    });
    const recipe = recipeFor({
      baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW, comfyuiEditWorkflow: EDIT_WORKFLOW,
    });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await adapter.submit(instance, mediaRequest("image", {
      operation: "edit", prompt: "make it blue", refs: [{ url: "data:image/png;base64,AA==" }],
    }), new AbortController().signal);

    expect(submitted?.prompt).toEqual({
      "8": { class_type: "LoadImage", inputs: { image: "uploaded-reference.png" } },
      "9": { class_type: "ImageEdit", inputs: { image: ["8", 0], prompt: "make it blue" } },
    });
  });

  it("rejects explicit edits when the recipe has no edit graph", async () => {
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false, fetch: stubFetch({}) });
    const recipe = recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await expect(adapter.submit(instance, mediaRequest("image", {
      operation: "edit", prompt: "make it blue", refs: [{ url: "data:image/png;base64,AA==" }],
    }), new AbortController().signal)).rejects.toThrow("does not configure an image edit workflow");
  });

  it("selects the animation graph and uploads its source frame", async () => {
    let submitted: Record<string, unknown> | undefined;
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      createWebSocket: () => new FakeWebSocket(),
      fetch: stubFetch({ captureSubmit: (body) => { submitted = body; } }),
    });
    const recipe = recipeFor({
      baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW, comfyuiAnimateWorkflow: EDIT_WORKFLOW,
    });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await adapter.submit(instance, mediaRequest("video", {
      operation: "animate", prompt: "camera orbit", refs: [{ url: "data:image/png;base64,AA==" }],
    }), new AbortController().signal);
    expect(submitted?.prompt).toEqual({
      "8": { class_type: "LoadImage", inputs: { image: "uploaded-reference.png" } },
      "9": { class_type: "ImageEdit", inputs: { image: ["8", 0], prompt: "camera orbit" } },
    });
  });

  it("rejects animation when the recipe has no animation graph", async () => {
    const adapter = new ComfyUIEngineAdapter({ validatePaths: false, fetch: stubFetch({}) });
    const recipe = recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    await expect(adapter.submit(instance, mediaRequest("video", {
      operation: "animate", prompt: "camera orbit", refs: [{ url: "data:image/png;base64,AA==" }],
    }), new AbortController().signal)).rejects.toThrow("does not configure an image animation workflow");
  });

  it("reports WebSocket-streamed progress for a running job", async () => {
    const sockets: FakeWebSocket[] = [];
    let submitted: Record<string, unknown> | undefined;
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      createWebSocket: (url) => {
        const socket = new FakeWebSocket();
        socket.url = url;
        sockets.push(socket);
        return socket;
      },
      fetch: stubFetch({ captureSubmit: (body) => { submitted = body; } }),
    });
    const recipe = recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);

    const job = await adapter.submit(instance, mediaRequest("video", { prompt: "a red cube" }), new AbortController().signal);
    expect(job.id).toBe("job-1");
    expect(sockets).toHaveLength(1);
    // The WS connection uses the same clientId that POST /prompt was tagged with.
    const clientId = new URL(sockets[0]!.url).searchParams.get("clientId");
    expect(clientId).toBeTruthy();
    expect(submitted?.client_id).toBe(clientId);

    sockets[0]!.emit({ type: "progress", data: { value: 5, max: 20, prompt_id: job.id, node: "9" } });
    const poll = await adapter.poll(instance, job, new AbortController().signal);
    expect(poll).toEqual({ status: "progressing", progress: 0.25 });
  });

  it("falls back to the HTTP /progress endpoint when no WS progress has arrived", async () => {
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      createWebSocket: () => new FakeWebSocket(), // never emits
      fetch: stubFetch({ progress: { running: { "job-1": { progress: 37 } }, completed: {}, queue_remaining: 0 } }),
    });
    const recipe = recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    const job = await adapter.submit(instance, mediaRequest("video", { prompt: "a red cube" }), new AbortController().signal);

    const poll = await adapter.poll(instance, job, new AbortController().signal);
    expect(poll).toEqual({ status: "progressing", progress: 0.37 });
  });

  it("closes the progress socket when a job completes or fails", async () => {
    const sockets: FakeWebSocket[] = [];
    const history: Record<string, unknown> = {};
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      createWebSocket: (url) => {
        const socket = new FakeWebSocket();
        socket.url = url;
        sockets.push(socket);
        return socket;
      },
      fetch: stubFetch({ history, viewBytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) }),
    });
    const recipe = recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);

    const job = await adapter.submit(instance, mediaRequest("video", { prompt: "a red cube" }), new AbortController().signal);
    history["job-1"] = {
      outputs: { "9": { videos: [{ filename: "o.mp4", subfolder: "video", type: "output", format: "video/h264-mp4" }] } },
      status: { status_str: "success", completed: true },
    };
    const completed = await adapter.poll(instance, job, new AbortController().signal);
    expect(completed.status).toBe("completed");
    expect(sockets[0]!.closed).toBe(true);

    const job2 = await adapter.submit(instance, mediaRequest("video", { prompt: "boom" }), new AbortController().signal);
    history["job-1"] = {
      outputs: {},
      status: { status_str: "error", messages: [["execution_error", {
        node_id: "14", node_type: "SamplerCustomAdvanced", exception_message: "invalid latent shape\n",
      }]] },
    };
    const failed = await adapter.poll(instance, job2, new AbortController().signal);
    expect(failed).toEqual({ status: "failed", error: "ComfyUI SamplerCustomAdvanced (node 14) failed: invalid latent shape" });
    expect(sockets[1]!.closed).toBe(true);
  });

  it("closes the progress socket on cancel", async () => {
    const sockets: FakeWebSocket[] = [];
    const adapter = new ComfyUIEngineAdapter({
      validatePaths: false,
      createWebSocket: (url) => {
        const socket = new FakeWebSocket();
        socket.url = url;
        sockets.push(socket);
        return socket;
      },
      fetch: stubFetch({}),
    });
    const recipe = recipeFor({ baseUrl: "http://127.0.0.1:8188", comfyuiWorkflow: VIDEO_WORKFLOW });
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, new AbortController().signal);
    const job = await adapter.submit(instance, mediaRequest("video", { prompt: "a red cube" }), new AbortController().signal);

    await adapter.cancel(instance, job);
    expect(sockets[0]!.closed).toBe(true);
  });
});

function mediaRequest(modality: "image" | "video" | "audio", params: Record<string, unknown>): MediaGenerationRequest {
  return { id: "request-1", routeId: modality, modality, params: params as MediaGenerationRequest["params"] };
}

interface StubFetchOptions {
  promptId?: string;
  history?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  viewBytes?: Uint8Array;
  captureSubmit?: (body: Record<string, unknown>) => void;
}

function stubFetch(options: StubFetchOptions): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    if (url.protocol === "data:") {
      return new Response(new Uint8Array([0]), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.pathname === "/prompt") {
      if (typeof init?.body === "string") {
        try {
          options.captureSubmit?.(JSON.parse(init.body) as Record<string, unknown>);
        } catch {
          // ignore malformed capture
        }
      }
      return jsonResponse({ prompt_id: options.promptId ?? "job-1" });
    }
    if (url.pathname === "/upload/image") {
      return jsonResponse({ name: "uploaded-reference.png", subfolder: "", type: "input" });
    }
    if (url.pathname.startsWith("/history/")) {
      return jsonResponse(options.history ?? {});
    }
    if (url.pathname === "/progress") {
      return jsonResponse(options.progress ?? { running: {}, completed: {}, queue_remaining: 0 });
    }
    if (url.pathname === "/view") {
      return new Response(options.viewBytes ?? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { status: 200 });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
