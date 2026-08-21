import { access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  ValidationReport,
} from "@fitz/protocol";
import { ComfyUIClient, ComfyUIProgressListener, type ComfyUIFileRef, type ComfyUIHistoryEntry, type ComfyUIWebSocketFactory } from "./comfyui-client.js";
import {
  applyGenerationDefaults,
  bindReferenceInputs,
  isComfyUIWorkflowGraph,
  readComfyUIConfiguration,
  substituteWorkflow,
  validateComfyUIConfiguration,
  type ComfyUIConfiguration,
  type ComfyUIUploadedReference,
} from "./comfyui-workflow.js";

export { bindReferenceInputs, readComfyUIConfiguration, substituteWorkflow, validateComfyUIConfiguration } from "./comfyui-workflow.js";
export type { ComfyUIConfiguration, ComfyUIReferenceBindings, ComfyUIUploadedReference, ComfyUIWorkflowOverrides } from "./comfyui-workflow.js";

export interface ComfyUIHandle extends EngineInstanceHandle {
  modelId: string;
  config: ComfyUIConfiguration;
  client: ComfyUIClient;
  /** Managed-mode checkout folder; external-mode handles omit it. */
  cwd?: string;
  readinessTimeoutMs: number;
  /** Managed-mode child process; external-mode handles omit it. */
  process?: ChildProcessWithoutNullStreams;
  guestProcess?: { pid?: number; distribution: string };
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
  linuxRuntimes?: ReadonlyMap<string, { distribution: string }>;
}

const execFileAsync = promisify(execFile);

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
  readonly #linuxRuntimes: ReadonlyMap<string, { distribution: string }>;

  constructor(options: ComfyUIAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#createWebSocket = options.createWebSocket;
    this.#validatePaths = options.validatePaths ?? true;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? 1_000;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.#linuxRuntimes = options.linuxRuntimes ?? new Map();
  }

  resolveParams(recipe: Recipe, params: MediaGenerationParams): MediaGenerationParams {
    return applyGenerationDefaults(params, readComfyUIConfiguration(recipe).defaults);
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
          if (!isComfyUIWorkflowGraph(parsed)) throw new Error("workflow file does not contain a graph");
        } catch (error) {
          issues.push({ level: "error", code: "invalid_workflow_file", message: `Workflow file is not readable JSON: ${resolved}: ${errorMessage(error)}` });
        }
      }
      if (config.executable && !config.baseUrl && config.runtime !== "linux-managed") {
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
    const args = [
      config.entrypoint ?? "main.py",
      "--listen", allocation.host,
      "--port", String(allocation.port),
      "--disable-auto-launch",
      ...(config.launchArgs ?? []),
    ];
    if (config.runtime === "linux-managed") {
      const target = this.#linuxRuntimes.get(config.runtimeId!);
      if (!target) throw new Error(`Managed Linux runtime is unavailable: ${config.runtimeId}`);
      return {
        executable: "wsl.exe",
        args: ["-d", target.distribution, "-u", "root", "--", "sh", "-s", "--", config.cwd!, config.executable!, ...args],
        env: {}, internalHost: allocation.host, internalPort: allocation.port,
      };
    }
    return { executable: config.executable ?? "python", args, ...(config.cwd ? { cwd: config.cwd } : {}), env: {}, internalHost: allocation.host, internalPort: allocation.port };
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
    const guestProcess = config.runtime === "linux-managed"
      ? { distribution: this.#linuxRuntimes.get(config.runtimeId!)!.distribution } as { pid?: number; distribution: string }
      : undefined;
    captureLines(child.stdout, logs, "stdout");
    captureLines(child.stderr, logs, "stderr", (line) => {
      const match = /^__FITZ_GUEST_PID=(\d+)$/.exec(line);
      if (match && guestProcess) guestProcess.pid = Number.parseInt(match[1]!, 10);
    });
    if (guestProcess) child.stdin.end('cd "$1"\nprintf "__FITZ_GUEST_PID=%s\\n" "$$" >&2\nshift\nexec "$@"\n');
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
      ...(guestProcess ? { guestProcess } : {}),
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
    if (request.params.operation === "edit" && !instance.config.comfyuiEditWorkflow) {
      throw new Error(`ComfyUI recipe ${instance.recipeId} does not configure an image edit workflow`);
    }
    if (request.params.operation === "animate" && !instance.config.comfyuiAnimateWorkflow) {
      throw new Error(`ComfyUI recipe ${instance.recipeId} does not configure an image animation workflow`);
    }
    if (request.params.operation === "reference" && !instance.config.comfyuiReferenceWorkflow) {
      throw new Error(`ComfyUI recipe ${instance.recipeId} does not configure a reference generation workflow`);
    }
    const graph = request.params.operation === "edit"
      ? instance.config.comfyuiEditWorkflow!
      : request.params.operation === "animate"
        ? instance.config.comfyuiAnimateWorkflow!
        : request.params.operation === "reference"
          ? instance.config.comfyuiReferenceWorkflow!
          : await this.#loadWorkflow(instance, signal);
    const overrides = instance.config.comfyuiOverrides;
    const params = applyGenerationDefaults(request.params, instance.config.defaults);
    const references = await this.#uploadReferences(instance, params, signal);
    const bound = request.params.operation === "reference"
      ? bindReferenceInputs(graph, references, instance.config.comfyuiReferenceBindings!)
      : graph;
    const substituted = substituteWorkflow(bound, params, overrides, references.map((reference) => reference.name));
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

  async #uploadReferences(instance: ComfyUIHandle, params: MediaGenerationParams, signal: AbortSignal): Promise<ComfyUIUploadedReference[]> {
    const refs = params.refs ?? [];
    const uploaded: ComfyUIUploadedReference[] = [];
    for (const [index, ref] of refs.entries()) {
      if (!("url" in ref)) throw new Error("ComfyUI received an unresolved Fitz artifact reference");
      const response = await this.#fetch(ref.url, { signal });
      if (!response.ok) throw new Error(`Reference media download failed (HTTP ${response.status})`);
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "image/png";
      const modality = mediaModalityForMimeType(mimeType);
      if (!modality) throw new Error(`Reference ${index + 1} is not image, video, or audio media (${mimeType})`);
      if (ref.modality && ref.modality !== modality) {
        throw new Error(`Reference ${index + 1} declares ${ref.modality} but contains ${mimeType}`);
      }
      const extension = mediaExtension(mimeType, modality);
      const result = await instance.client.uploadInput(
        instance.baseUrl,
        new Uint8Array(await response.arrayBuffer()),
        `fitz-reference-${randomUUID()}.${extension}`,
        mimeType,
        signal,
      );
      uploaded.push({
        name: result.subfolder ? `${result.subfolder}/${result.name}` : result.name,
        modality,
      });
    }
    return uploaded;
  }

  async poll(instance: ComfyUIHandle, job: MediaJobHandle, signal: AbortSignal): Promise<MediaJobPoll> {
    if (signal.aborted) throw abortError();
    const history = await instance.client.history(instance.baseUrl, job.id, signal);
    const entry = history[job.id];
    if (entry) {
      if (entry.status?.status_str === "error") {
        this.#closeListener(instance, job.id);
        return { status: "failed", error: comfyUIExecutionError(entry) };
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
    if (instance.guestProcess?.pid) await signalGuest({ pid: instance.guestProcess.pid, distribution: instance.guestProcess.distribution }, mode === "force" ? "KILL" : "TERM");
    else instance.process.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
    const exited = await waitForExit(instance.process, this.#stopTimeoutMs);
    if (!exited && mode !== "force") {
      if (instance.guestProcess?.pid) await signalGuest({ pid: instance.guestProcess.pid, distribution: instance.guestProcess.distribution }, "KILL");
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
      if (!isComfyUIWorkflowGraph(graph)) throw new Error(`Workflow file is not a graph: ${resolved}`);
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

function mediaModalityForMimeType(mimeType: string): MediaModality | undefined {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return undefined;
}

function mediaExtension(mimeType: string, modality: MediaModality): string {
  const extension = Object.entries(EXTENSION_MIME).find(([, candidate]) => candidate === mimeType)?.[0];
  if (extension) return extension;
  return modality === "image" ? "png" : modality === "video" ? "mp4" : "wav";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ComfyUI records the actionable exception inside status.messages. Keep the
 * adapter boundary compact, but do not replace a real node error with the
 * useless generic "workflow execution failed" message. */
function comfyUIExecutionError(entry: ComfyUIHistoryEntry): string {
  for (const message of [...(entry.status?.messages ?? [])].reverse()) {
    if (!Array.isArray(message) || message[0] !== "execution_error" || !isRecord(message[1])) continue;
    const payload = message[1];
    const detail = typeof payload.exception_message === "string"
      ? payload.exception_message.trim().replace(/\s+/g, " ").slice(0, 600)
      : "workflow execution failed";
    const nodeType = typeof payload.node_type === "string" ? payload.node_type : undefined;
    const nodeId = typeof payload.node_id === "string" ? payload.node_id : undefined;
    const node = nodeType ? ` ${nodeType}${nodeId ? ` (node ${nodeId})` : ""}` : " workflow";
    return `ComfyUI${node} failed: ${detail}`;
  }
  return "ComfyUI workflow execution failed";
}

function resolvePath(path: string, cwd: string | undefined): string {
  return isAbsolute(path) ? path : join(cwd ?? process.cwd(), path);
}

function captureLines(stream: Readable, logs: string[], source: string, onLine?: (line: string) => void): void {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      onLine?.(line);
      logs.push(`${source}: ${line}`);
      if (logs.length > 500) logs.shift();
    }
  });
}

async function signalGuest(process: { pid: number; distribution: string }, signal: "TERM" | "KILL"): Promise<void> {
  try { await execFileAsync("wsl.exe", ["-d", process.distribution, "-u", "root", "--", "kill", `-${signal}`, String(process.pid)], { timeout: 10_000, windowsHide: true }); }
  catch { /* A guest that exited between inspection and signaling is already stopped. */ }
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

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
