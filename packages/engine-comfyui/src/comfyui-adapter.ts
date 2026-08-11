import { access, readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { isAbsolute, join } from "node:path";
import type {
  EngineInstanceHandle,
  InstanceInspection,
  MediaEngineAdapter,
  MediaJobHandle,
  MediaJobPoll,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "@fitz/inference-core";
import type {
  LaunchSpec,
  MediaGenerationParams,
  MediaGenerationRequest,
  MediaModality,
  Recipe,
  ResourceEstimate,
  ValidationIssue,
  ValidationReport,
} from "@fitz/protocol";
import { ComfyUIClient, ComfyUIProgressListener, type ComfyUIFileRef, type ComfyUIHistoryEntry, type ComfyUIWebSocketFactory } from "./comfyui-client.js";

/** Node-id → inputs overrides for injecting generation params into a pinned
 *  workflow without {{placeholder}} strings (H3 workflows are complex graphs;
 *  both mechanisms are supported, §5.1 workflow JSON pinning). */
export interface ComfyUIWorkflowOverrides {
  /** Node id whose `inputs.text` receives the prompt. */
  promptNodeId?: string;
  /** Node id whose `inputs.text` receives the negative prompt. */
  negativeNodeId?: string;
  /** Node ids whose `inputs.seed` receive `params.seed` when provided. */
  seedNodeIds?: string[];
}

export interface ComfyUIConfiguration {
  /** Managed mode: executable that launches the ComfyUI server (e.g. a venv
   *  python or a launcher script). Mutually exclusive with `baseUrl`. */
  executable?: string;
  /** Managed mode: ComfyUI checkout folder — the entrypoint script lives here
   *  and relative `comfyuiWorkflowPath` values resolve against it. */
  cwd?: string;
  /** Managed mode: script ComfyUI runs inside `cwd` (default "main.py" —
   *  some launchers/forks differ). */
  entrypoint?: string;
  /** Managed mode: extra arguments appended after the Fitz-managed
   *  `--listen`/`--port`/`--disable-auto-launch` arguments. */
  launchArgs?: string[];
  /** External mode: base URL of an already-running ComfyUI server
   *  (same pattern as OpenAICompatibleEngineAdapter). */
  baseUrl?: string;
  /** VRAM estimate in MiB — the ResourceGovernor's refusal safety net (KD-4). */
  expectedVramMiB?: number;
  readinessTimeoutMs?: number;
  /** Pinned workflow: inline graph object or JSON string (KD-13 weight/workflow
   *  placement is manual; the recipe pins the graph that ComfyUI runs). The
   *  configuration reader resolves JSON strings to the graph. */
  comfyuiWorkflow?: Readonly<Record<string, unknown>>;
  /** Pinned workflow: path to a workflow JSON file (absolute, or relative to
   *  `cwd` when managed). Mutually exclusive with `comfyuiWorkflow`. */
  comfyuiWorkflowPath?: string;
  /** Declared output formats, e.g. `["mp4"]` or `["png"]` (validated, informational). */
  outputFormats?: string[];
  /** Declared generation defaults — sampler, steps, guidance, resolution, fps,
   *  duration cap (validated, informational; the pinned workflow is the source
   *  of truth for values). */
  defaults?: Readonly<Record<string, unknown>>;
  /** Direct node-id overrides for prompt/seed injection. */
  comfyuiOverrides?: ComfyUIWorkflowOverrides;
}

export interface ComfyUIHandle extends EngineInstanceHandle {
  modelId: string;
  config: ComfyUIConfiguration;
  client: ComfyUIClient;
  /** Managed-mode checkout folder; external-mode handles omit it. */
  cwd?: string;
  readinessTimeoutMs: number;
  /** Managed-mode child process; external-mode handles omit it. */
  process?: ChildProcessWithoutNullStreams;
  logs?: string[];
  /** WebSocket progress listeners keyed by ComfyUI prompt id. */
  progressListeners?: Map<string, ComfyUIProgressListener>;
}

export interface ComfyUIAdapterOptions {
  fetch?: typeof globalThis.fetch;
  /** WebSocket factory for streaming progress; defaults to the runtime's
   *  global `WebSocket` (Node ≥ 22). Tests inject a fake. */
  createWebSocket?: ComfyUIWebSocketFactory;
  validatePaths?: boolean;
  /** Readiness-poll interval (default 250 ms). */
  pollIntervalMs?: number;
  /** Job poll interval exposed to `runMedia` (default 1000 ms). */
  defaultPollIntervalMs?: number;
  readinessTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** First real local media engine (§5.4, KD-1): drives a ComfyUI server — spawned
 *  and owned in managed mode, or an external endpoint in connection mode — via
 *  `/prompt` → `/history/{id}` with progress streamed over the WebSocket
 *  (`/ws`, with an HTTP `/progress` fallback for older servers), and downloads
 *  output files through `/view`. The workflow is pinned per recipe and generation
 *  params are injected through {{placeholders}} and/or node-id overrides. */
export class ComfyUIEngineAdapter implements MediaEngineAdapter<ComfyUIHandle> {
  readonly id = "comfyui";
  readonly modalities: MediaModality[] = ["image", "video", "audio"];
  readonly defaultPollIntervalMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #createWebSocket: ComfyUIWebSocketFactory | undefined;
  readonly #validatePaths: boolean;
  readonly #pollIntervalMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #stopTimeoutMs: number;

  constructor(options: ComfyUIAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#createWebSocket = options.createWebSocket;
    this.#validatePaths = options.validatePaths ?? true;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? 1_000;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  }

  executionLocation(recipe: Recipe): "local" | "remote" {
    const baseUrl = readComfyUIConfiguration(recipe).baseUrl;
    if (baseUrl === undefined) return "local";
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" ? "local" : "remote";
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = validateComfyUIConfiguration(recipe);
    if (issues.every((issue) => issue.level !== "error") && this.#validatePaths) {
      const config = readComfyUIConfiguration(recipe);
      if (config.comfyuiWorkflowPath) {
        const resolved = resolvePath(config.comfyuiWorkflowPath, config.cwd);
        try {
          const content = await readFile(resolved, "utf8");
          const parsed = JSON.parse(content) as unknown;
          if (!isGraph(parsed)) throw new Error("workflow file does not contain a graph");
        } catch (error) {
          issues.push({ level: "error", code: "invalid_workflow_file", message: `Workflow file is not readable JSON: ${resolved}: ${errorMessage(error)}` });
        }
      }
      if (config.executable && !config.baseUrl) {
        try {
          await access(config.executable);
        } catch {
          issues.push({ level: "error", code: "missing_executable", message: `Executable is not readable: ${config.executable}` });
        }
      }
    }
    return { valid: issues.every((issue) => issue.level !== "error"), issues };
  }

  async estimateResources(recipe: Recipe): Promise<ResourceEstimate> {
    const config = readComfyUIConfiguration(recipe);
    return config.expectedVramMiB === undefined ? {} : { vramMiB: config.expectedVramMiB };
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    const config = readComfyUIConfiguration(recipe);
    if (config.baseUrl !== undefined) {
      const url = new URL(config.baseUrl);
      return {
        executable: "external-comfyui-server",
        args: [],
        env: {},
        internalHost: url.hostname || allocation.host,
        internalPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      };
    }
    return {
      executable: config.executable ?? "python",
      args: [
        config.entrypoint ?? "main.py",
        "--listen", allocation.host,
        "--port", String(allocation.port),
        "--disable-auto-launch",
        ...(config.launchArgs ?? []),
      ],
      ...(config.cwd ? { cwd: config.cwd } : {}),
      env: {},
      internalHost: allocation.host,
      internalPort: allocation.port,
    };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<ComfyUIHandle> {
    if (signal.aborted) throw abortError();
    const config = readComfyUIConfiguration(recipe);
    if (config.baseUrl !== undefined) {
      return {
        id: randomUUID(),
        recipeId: recipe.id,
        modelId: recipe.modelId,
        baseUrl: config.baseUrl.replace(/\/+$/, ""),
        startedAt: new Date(),
        config,
        client: new ComfyUIClient({ fetch: this.#fetch }),
        readinessTimeoutMs: config.readinessTimeoutMs ?? this.#readinessTimeoutMs,
        progressListeners: new Map(),
      };
    }
    const child = spawn(spec.executable, spec.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: { ...process.env, ...spec.env },
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    const logs: string[] = [];
    captureLines(child.stdout, logs, "stdout");
    captureLines(child.stderr, logs, "stderr");
    await waitForSpawn(child, signal);
    return {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: `http://${spec.internalHost}:${spec.internalPort}`,
      startedAt: new Date(),
      config,
      client: new ComfyUIClient({ fetch: this.#fetch }),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      readinessTimeoutMs: config.readinessTimeoutMs ?? this.#readinessTimeoutMs,
      process: child,
      logs,
      progressListeners: new Map(),
    };
  }

  async waitUntilReady(instance: ComfyUIHandle, signal: AbortSignal): Promise<ReadyInfo> {
    const deadline = Date.now() + instance.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      if (instance.process && hasExited(instance.process)) {
        throw new Error(`ComfyUI exited before ready: ${recentLogs(instance.logs ?? [])}`);
      }
      if (await instance.client.healthy(instance.baseUrl, signal)) {
        return { modelId: instance.modelId, baseUrl: instance.baseUrl };
      }
      await delay(this.#pollIntervalMs, signal);
    }
    throw new Error(`Timed out waiting for ComfyUI at ${instance.baseUrl}`);
  }

  async submit(
    instance: ComfyUIHandle,
    request: MediaGenerationRequest,
    signal: AbortSignal,
  ): Promise<MediaJobHandle> {
    if (signal.aborted) throw abortError();
    const graph = await this.#loadWorkflow(instance, signal);
    const overrides = instance.config.comfyuiOverrides;
    const params = applyGenerationDefaults(request.params, instance.config.defaults);
    const substituted = substituteWorkflow(graph, params, overrides);
    const clientId = randomUUID();
    // Open the progress socket before POSTing so it is (likely) connected by
    // the time the server starts executing the prompt.
    const listener = this.#openProgressListener(instance, clientId);
    try {
      const promptId = await instance.client.submitPrompt(instance.baseUrl, substituted, clientId, signal);
      if (listener !== undefined) instance.progressListeners?.set(promptId, listener);
      return { id: promptId, modality: request.modality };
    } catch (error) {
      listener?.close();
      throw error;
    }
  }

  async poll(instance: ComfyUIHandle, job: MediaJobHandle, signal: AbortSignal): Promise<MediaJobPoll> {
    if (signal.aborted) throw abortError();
    const history = await instance.client.history(instance.baseUrl, job.id, signal);
    const entry = history[job.id];
    if (entry) {
      if (entry.status?.status_str === "error") {
        this.#closeListener(instance, job.id);
        return { status: "failed", error: "ComfyUI workflow execution failed" };
      }
      const file = pickOutputFile(entry, job.modality);
      if (!file) {
        this.#closeListener(instance, job.id);
        return { status: "failed", error: "ComfyUI job finished without output files" };
      }
      const bytes = await instance.client.view(instance.baseUrl, file, signal);
      const mimeType = mimeTypeForOutput(file);
      this.#closeListener(instance, job.id);
      return {
        status: "completed",
        progress: 1,
        result: {
          data: bytes,
          mimeType,
          byteSize: bytes.byteLength,
          ...(file.width !== undefined ? { width: file.width } : {}),
          ...(file.height !== undefined ? { height: file.height } : {}),
        },
      };
    }
    // Progress first from the WebSocket stream (modern ComfyUI builds), then
    // fall back to the legacy HTTP /progress endpoint (older builds).
    const wsProgress = instance.progressListeners?.get(job.id)?.progress(job.id);
    if (wsProgress !== undefined && wsProgress > 0) {
      return { status: "progressing", progress: wsProgress };
    }
    const state = await instance.client.progress(instance.baseUrl, signal);
    const running = state.running[job.id];
    if (running && running.progress > 0) {
      return { status: "progressing", progress: Math.min(1, running.progress / 100) };
    }
    return { status: "started" };
  }

  async cancel(instance: ComfyUIHandle, job: MediaJobHandle, signal?: AbortSignal): Promise<void> {
    this.#closeListener(instance, job.id);
    await instance.client.cancel(instance.baseUrl, job.id, signal);
  }

  async stop(instance: ComfyUIHandle, mode: StopMode): Promise<StopReport> {
    for (const listener of instance.progressListeners?.values() ?? []) listener.close();
    instance.progressListeners?.clear();
    if (!instance.process) return { stopped: true, detail: "External endpoint left running" };
    if (hasExited(instance.process)) return { stopped: true };
    instance.process.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
    const exited = await waitForExit(instance.process, this.#stopTimeoutMs);
    if (!exited && mode !== "force") {
      instance.process.kill("SIGKILL");
      await waitForExit(instance.process, Math.min(this.#stopTimeoutMs, 2_000));
    }
    return { stopped: hasExited(instance.process) };
  }

  async inspect(instance: ComfyUIHandle): Promise<InstanceInspection> {
    if (instance.process && hasExited(instance.process)) {
      return { healthy: false, modelId: instance.modelId, detail: recentLogs(instance.logs ?? []) };
    }
    try {
      return { healthy: await instance.client.healthy(instance.baseUrl), modelId: instance.modelId };
    } catch (error) {
      return { healthy: false, modelId: instance.modelId, detail: errorMessage(error) };
    }
  }

  async #loadWorkflow(instance: ComfyUIHandle, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    if (signal.aborted) throw abortError();
    const config = instance.config;
    if (config.comfyuiWorkflow !== undefined) return config.comfyuiWorkflow;
    if (config.comfyuiWorkflowPath !== undefined) {
      const resolved = resolvePath(config.comfyuiWorkflowPath, instance.cwd);
      const content = await readFile(resolved, "utf8");
      const graph = JSON.parse(content) as unknown;
      if (!isGraph(graph)) throw new Error(`Workflow file is not a graph: ${resolved}`);
      return graph;
    }
    throw new Error(`Recipe ${instance.recipeId} has no pinned workflow`);
  }

  /** Opens a WebSocket progress listener for a submit; returns undefined when
   *  no WebSocket is available (progress then falls back to HTTP /progress). */
  #openProgressListener(instance: ComfyUIHandle, clientId: string): ComfyUIProgressListener | undefined {
    try {
      return new ComfyUIProgressListener({
        baseUrl: instance.baseUrl,
        clientId,
        ...(this.#createWebSocket !== undefined ? { createSocket: this.#createWebSocket } : {}),
      });
    } catch {
      return undefined;
    }
  }

  #closeListener(instance: ComfyUIHandle, promptId: string): void {
    const listener = instance.progressListeners?.get(promptId);
    if (listener === undefined) return;
    listener.close();
    instance.progressListeners?.delete(promptId);
  }
}

/** Reads and validates the ComfyUI-specific recipe configuration. */
export function readComfyUIConfiguration(recipe: Recipe): ComfyUIConfiguration {
  if (recipe.adapter !== "comfyui") throw new TypeError("Recipe adapter must be comfyui");
  const value = recipe.configuration;
  return {
    ...(value.executable !== undefined ? { executable: stringValue(value.executable, "executable") } : {}),
    ...(value.cwd !== undefined ? { cwd: stringValue(value.cwd, "cwd") } : {}),
    ...(value.entrypoint !== undefined ? { entrypoint: stringValue(value.entrypoint, "entrypoint") } : {}),
    ...(value.launchArgs !== undefined ? { launchArgs: stringArray(value.launchArgs, "launchArgs") } : {}),
    ...(value.baseUrl !== undefined ? { baseUrl: stringValue(value.baseUrl, "baseUrl") } : {}),
    ...(value.expectedVramMiB !== undefined ? { expectedVramMiB: nonNegativeNumber(value.expectedVramMiB, "expectedVramMiB") } : {}),
    ...(value.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: nonNegativeNumber(value.readinessTimeoutMs, "readinessTimeoutMs") } : {}),
    ...(value.comfyuiWorkflow !== undefined ? { comfyuiWorkflow: parseWorkflowValue(value.comfyuiWorkflow) } : {}),
    ...(value.comfyuiWorkflowPath !== undefined ? { comfyuiWorkflowPath: stringValue(value.comfyuiWorkflowPath, "comfyuiWorkflowPath") } : {}),
    ...(value.outputFormats !== undefined ? { outputFormats: stringArray(value.outputFormats, "outputFormats") } : {}),
    ...(value.defaults !== undefined ? { defaults: readDefaults(value.defaults) } : {}),
    ...(value.comfyuiOverrides !== undefined ? { comfyuiOverrides: readComfyUIOverrides(value.comfyuiOverrides) } : {}),
  };
}

/** Validates `comfyuiWorkflow`/`comfyuiWorkflowPath` pinning, managed/external
 *  mode exclusivity, and the informational media keys from §5.1. */
export function validateComfyUIConfiguration(recipe: Recipe): ValidationIssue[] {
  try {
    const config = readComfyUIConfiguration(recipe);
    const issues: ValidationIssue[] = [];
    const hasWorkflow = config.comfyuiWorkflow !== undefined;
    const hasWorkflowPath = config.comfyuiWorkflowPath !== undefined;
    if (!hasWorkflow && !hasWorkflowPath) {
      issues.push({ level: "error", code: "missing_workflow", message: "comfyuiWorkflow (inline graph) or comfyuiWorkflowPath is required" });
    }
    if (hasWorkflow && hasWorkflowPath) {
      issues.push({ level: "error", code: "conflicting_workflow", message: "comfyuiWorkflow and comfyuiWorkflowPath are mutually exclusive" });
    }
    if (config.comfyuiWorkflow !== undefined && !isGraph(config.comfyuiWorkflow)) {
      issues.push({ level: "error", code: "invalid_workflow_graph", message: "comfyuiWorkflow must be a non-empty object of { class_type, inputs } nodes" });
    }
    const external = config.baseUrl !== undefined;
    const managed = config.executable !== undefined || config.cwd !== undefined || config.launchArgs !== undefined;
    if (external && managed) {
      issues.push({ level: "error", code: "conflicting_mode", message: "baseUrl (external) and executable/cwd (managed) are mutually exclusive" });
    }
    if (!external && !config.executable) {
      issues.push({ level: "error", code: "missing_executable", message: "managed ComfyUI requires executable (or set baseUrl for external mode)" });
    }
    if (!external && !config.cwd) {
      issues.push({ level: "error", code: "missing_cwd", message: "managed ComfyUI requires cwd (the ComfyUI checkout folder)" });
    }
    if (config.launchArgs?.some((arg) => arg === "--listen" || arg === "--port" || arg.startsWith("--listen=") || arg.startsWith("--port="))) {
      issues.push({ level: "error", code: "reserved_argument", message: "launchArgs cannot override Fitz-managed --listen/--port arguments" });
    }
    if (external && config.baseUrl !== undefined) {
      const url = new URL(config.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push({ level: "error", code: "invalid_protocol", message: "baseUrl must use http or https" });
      }
      if (url.username || url.password) {
        issues.push({ level: "error", code: "embedded_credentials", message: "Credentials must not be embedded in baseUrl" });
      }
    }
    return issues;
  } catch (error) {
    return [{ level: "error", code: "invalid_configuration", message: errorMessage(error) }];
  }
}

/** Deep-substitutes generation params into a cloned pinned workflow: node-id
 *  overrides first, then `{{placeholder}}` substitution across every string
 *  input value (`{{prompt}}`, `{{negative_prompt}}`, `{{seed}}`, `{{width}}`,
 *  `{{height}}`, `{{fps}}`, `{{duration_seconds}}`, `{{steps}}`, `{{guidance}}`,
 *  `{{sampler}}`). A value that consists solely of a numeric placeholder is
 *  emitted as a number, which is required by ComfyUI's API validator. */
export function substituteWorkflow(
  graph: Readonly<Record<string, unknown>>,
  params: MediaGenerationParams,
  overrides: ComfyUIWorkflowOverrides = {},
): Record<string, unknown> {
  const clone = structuredClone(graph) as Record<string, Record<string, unknown>>;
  const size = parseSize(params.size);
  for (const [nodeId, node] of Object.entries(clone)) {
    if (!isRecord(node) || !isRecord(node.inputs)) continue;
    let inputs = node.inputs;
    if (overrides.promptNodeId === nodeId && typeof inputs.text === "string") {
      inputs = { ...inputs, text: params.prompt };
    }
    if (overrides.negativeNodeId === nodeId && params.negativePrompt !== undefined && typeof inputs.text === "string") {
      inputs = { ...inputs, text: params.negativePrompt };
    }
    if (overrides.seedNodeIds?.includes(nodeId) && params.seed !== undefined) {
      inputs = { ...inputs, seed: params.seed };
    }
    node.inputs = substituteInputs(inputs, params, size);
  }
  return clone;
}

function substituteInputs(
  inputs: Record<string, unknown>,
  params: MediaGenerationParams,
  size: { width: number; height: number } | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = typeof value === "string" ? substitutePlaceholders(value, params, size) : value;
  }
  return out;
}

function substitutePlaceholders(
  value: string,
  params: MediaGenerationParams,
  size: { width: number; height: number } | undefined,
): unknown {
  const exact = exactPlaceholderValue(value, params, size);
  if (exact !== undefined) return exact;
  let result = value;
  result = result.replaceAll("{{prompt}}", params.prompt);
  if (params.negativePrompt !== undefined) result = result.replaceAll("{{negative_prompt}}", params.negativePrompt);
  if (params.seed !== undefined) result = result.replaceAll("{{seed}}", String(params.seed));
  if (size !== undefined) {
    result = result.replaceAll("{{width}}", String(size.width));
    result = result.replaceAll("{{height}}", String(size.height));
  }
  if (params.fps !== undefined) result = result.replaceAll("{{fps}}", String(params.fps));
  if (params.durationSeconds !== undefined) result = result.replaceAll("{{duration_seconds}}", String(params.durationSeconds));
  if (params.steps !== undefined) result = result.replaceAll("{{steps}}", String(params.steps));
  if (params.guidance !== undefined) result = result.replaceAll("{{guidance}}", String(params.guidance));
  if (params.sampler !== undefined) result = result.replaceAll("{{sampler}}", String(params.sampler));
  return result;
}

function exactPlaceholderValue(
  value: string,
  params: MediaGenerationParams,
  size: { width: number; height: number } | undefined,
): string | number | undefined {
  switch (value) {
    case "{{prompt}}": return params.prompt;
    case "{{negative_prompt}}": return params.negativePrompt;
    case "{{seed}}": return params.seed;
    case "{{width}}": return size?.width;
    case "{{height}}": return size?.height;
    case "{{fps}}": return params.fps;
    case "{{duration_seconds}}": return params.durationSeconds;
    case "{{steps}}": return params.steps;
    case "{{guidance}}": return params.guidance;
    case "{{sampler}}": return params.sampler;
    default: return undefined;
  }
}

function applyGenerationDefaults(
  params: MediaGenerationParams,
  defaults: Readonly<Record<string, unknown>> | undefined,
): MediaGenerationParams {
  const size = params.size ?? stringDefault(defaults, "resolution");
  const durationSeconds = params.durationSeconds ?? numberDefault(defaults, "durationSeconds");
  const fps = params.fps ?? numberDefault(defaults, "fps");
  const sampler = params.sampler ?? stringDefault(defaults, "sampler");
  const steps = params.steps ?? numberDefault(defaults, "steps");
  const guidance = params.guidance ?? numberDefault(defaults, "guidance");
  return {
    ...params,
    ...(size !== undefined ? { size } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(sampler !== undefined ? { sampler } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    seed: params.seed ?? randomBytes(6).readUIntBE(0, 6),
  };
}

function stringDefault(defaults: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = defaults?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberDefault(defaults: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = defaults?.[key];
  return typeof value === "number" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickOutputFile(entry: ComfyUIHistoryEntry, modality: MediaModality): ComfyUIFileRef | undefined {
  const image = collectOutputs(entry, "images");
  const video = collectOutputs(entry, "videos");
  const audio = collectOutputs(entry, "audio");
  const preferred = modality === "image" ? image : modality === "video" ? video : audio;
  if (preferred[0]) return preferred[0];
  for (const list of [image, video, audio]) {
    if (list[0]) return list[0];
  }
  return undefined;
}

function collectOutputs(entry: ComfyUIHistoryEntry, key: "images" | "videos" | "audio"): ComfyUIFileRef[] {
  return Object.values(entry.outputs ?? {}).flatMap((output) => output[key] ?? []);
}

const OUTPUT_FORMAT_MIME: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "video/h264-mp4": "video/mp4",
  "video/h265-mp4": "video/mp4",
  "video/mp4": "video/mp4",
  "video/webm": "video/webm",
  "video/ogg": "video/ogg",
  "audio/wav": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/flac": "audio/flac",
  "audio/ogg": "audio/ogg",
};

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
};

function mimeTypeForOutput(file: ComfyUIFileRef): string {
  if (file.format) {
    const mime = OUTPUT_FORMAT_MIME[file.format.toLowerCase()];
    if (mime) return mime;
  }
  const extension = file.filename.split(".").pop()?.toLowerCase();
  if (extension && EXTENSION_MIME[extension]) return EXTENSION_MIME[extension];
  return "application/octet-stream";
}

function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  if (!size) return undefined;
  const match = /^(\d+)[xX](\d+)$/.exec(size.trim());
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseWorkflowValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new TypeError(`comfyuiWorkflow is not valid JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) throw new TypeError("comfyuiWorkflow JSON must be a graph object");
    return parsed;
  }
  if (isRecord(value)) return value;
  throw new TypeError("comfyuiWorkflow must be a workflow graph object or JSON string");
}

function readDefaults(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError("defaults must be an object");
  const out: Record<string, unknown> = {};
  if (value.sampler !== undefined) out.sampler = stringValue(value.sampler, "defaults.sampler");
  if (value.steps !== undefined) out.steps = nonNegativeNumber(value.steps, "defaults.steps");
  if (value.guidance !== undefined) out.guidance = nonNegativeNumber(value.guidance, "defaults.guidance");
  if (value.fps !== undefined) out.fps = nonNegativeNumber(value.fps, "defaults.fps");
  if (value.durationSeconds !== undefined) out.durationSeconds = nonNegativeNumber(value.durationSeconds, "defaults.durationSeconds");
  if (value.resolution !== undefined) out.resolution = resolutionString(value.resolution);
  return out;
}

function readComfyUIOverrides(value: unknown): ComfyUIWorkflowOverrides {
  if (!isRecord(value)) throw new TypeError("comfyuiOverrides must be an object");
  return {
    ...(value.promptNodeId !== undefined ? { promptNodeId: stringValue(value.promptNodeId, "comfyuiOverrides.promptNodeId") } : {}),
    ...(value.negativeNodeId !== undefined ? { negativeNodeId: stringValue(value.negativeNodeId, "comfyuiOverrides.negativeNodeId") } : {}),
    ...(value.seedNodeIds !== undefined ? { seedNodeIds: stringArray(value.seedNodeIds, "comfyuiOverrides.seedNodeIds") } : {}),
  };
}

function isGraph(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every(
    (node) => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePath(path: string, cwd: string | undefined): string {
  return isAbsolute(path) ? path : join(cwd ?? process.cwd(), path);
}

function captureLines(stream: Readable, logs: string[], source: string): void {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      logs.push(`${source}: ${line}`);
      if (logs.length > 500) logs.shift();
    }
  });
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => finish(resolve);
    const failed = (error: Error) => finish(() => reject(error));
    const aborted = () => { child.kill("SIGKILL"); finish(() => reject(abortError())); };
    const finish = (action: () => void) => {
      child.off("spawn", spawned); child.off("error", failed); signal.removeEventListener("abort", aborted); action();
    };
    child.once("spawn", spawned); child.once("error", failed); signal.addEventListener("abort", aborted, { once: true });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const exited = () => finish(true);
    const finish = (value: boolean) => { clearTimeout(timeout); child.off("exit", exited); resolve(value); };
    child.once("exit", exited);
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    const aborted = () => { clearTimeout(timeout); reject(abortError()); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function recentLogs(logs: string[]): string {
  return logs.slice(-10).join(" | ") || "no logs";
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function resolutionString(value: unknown): string {
  if (typeof value !== "string" || !/^\d+[xX]\d+$/.test(value.trim())) {
    throw new TypeError("defaults.resolution must be a \"WxH\" string");
  }
  return value;
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
