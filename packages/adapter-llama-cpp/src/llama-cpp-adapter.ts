import { access, open } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { OpenAICompatibleClient } from "@fitz/adapter-openai-compatible";
import type {
  EngineAdapter,
  EngineInstanceHandle,
  InstanceInspection,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "@fitz/inference-core";
import type {
  InferenceDelta,
  InferenceRequest,
  LaunchSpec,
  Recipe,
  RecipeSpeculativeDecoding,
  ResourceEstimate,
  ValidationIssue,
  ValidationReport,
} from "@fitz/protocol";

export interface LlamaCppConfiguration {
  executable: string;
  modelPath: string;
  contextTokens: number;
  gpuLayers?: number;
  threads?: number;
  expectedVramMiB?: number;
  readinessTimeoutMs?: number;
  prefixArgs?: string[];
  extraArgs?: string[];
}

export interface LlamaCppHandle extends EngineInstanceHandle {
  modelId: string;
  apiKey: string;
  process: ChildProcessWithoutNullStreams;
  client: OpenAICompatibleClient;
  logs: string[];
  readinessTimeoutMs: number;
}

export interface LlamaCppAdapterOptions {
  fetch?: typeof globalThis.fetch;
  validatePaths?: boolean;
  pollIntervalMs?: number;
  readinessTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export class LlamaCppEngineAdapter implements EngineAdapter<LlamaCppHandle> {
  readonly id = "llama-cpp";
  readonly #fetch: typeof globalThis.fetch;
  readonly #validatePaths: boolean;
  readonly #pollIntervalMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #stopTimeoutMs: number;

  constructor(options: LlamaCppAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#validatePaths = options.validatePaths ?? true;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  }

  async prepare(recipe: Recipe, signal: AbortSignal): Promise<void> {
    const config = readLlamaCppConfiguration(recipe);
    await access(config.executable);
    await warmFileCache(config.modelPath, signal);
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = validateLlamaCppConfiguration(recipe);
    if (issues.length === 0 && this.#validatePaths) {
      const config = readLlamaCppConfiguration(recipe);
      for (const [code, path] of [["missing_executable", config.executable], ["missing_model", config.modelPath]] as const) {
        try {
          await access(path);
        } catch {
          issues.push({ level: "error", code, message: `Path is not readable: ${path}` });
        }
      }
    }
    return { valid: issues.every((issue) => issue.level !== "error"), issues };
  }

  async estimateResources(recipe: Recipe): Promise<ResourceEstimate> {
    const expected = readLlamaCppConfiguration(recipe).expectedVramMiB;
    return expected === undefined ? {} : { vramMiB: expected };
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    const config = readLlamaCppConfiguration(recipe);
    const args = [
      ...(config.prefixArgs ?? []),
      "--model", config.modelPath,
      "--host", allocation.host,
      "--port", String(allocation.port),
      "--ctx-size", String(config.contextTokens),
    ];
    if (config.gpuLayers !== undefined) args.push("--gpu-layers", String(config.gpuLayers));
    if (config.threads !== undefined) args.push("--threads", String(config.threads));
    if (recipe.speculativeDecoding) args.push(...llamaSpeculativeArgs(recipe.speculativeDecoding));
    if (config.extraArgs) args.push(...(recipe.speculativeDecoding ? stripLlamaSpeculativeArgs(config.extraArgs) : config.extraArgs));
    return { executable: config.executable, args, env: {}, internalHost: allocation.host, internalPort: allocation.port };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<LlamaCppHandle> {
    if (signal.aborted) throw abortError();
    const config = readLlamaCppConfiguration(recipe);
    const apiKey = randomBytes(32).toString("base64url");
    const child = spawn(spec.executable, [...spec.args, "--api-key", apiKey], {
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
      apiKey,
      process: child,
      client: new OpenAICompatibleClient({ fetch: this.#fetch, apiKey }),
      logs,
      readinessTimeoutMs: config.readinessTimeoutMs ?? this.#readinessTimeoutMs,
    };
  }

  async waitUntilReady(instance: LlamaCppHandle, signal: AbortSignal): Promise<ReadyInfo> {
    const deadline = Date.now() + instance.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      if (hasExited(instance.process)) throw new Error(`llama.cpp exited before ready: ${recentLogs(instance.logs)}`);
      try {
        if (await instance.client.healthy(instance.baseUrl, "/health", signal)) {
          return { modelId: instance.modelId, baseUrl: instance.baseUrl };
        }
      } catch (error) {
        if (signal.aborted) throw error;
      }
      await delay(this.#pollIntervalMs, signal);
    }
    throw new Error(`Timed out waiting for llama.cpp at ${instance.baseUrl}`);
  }

  async contextCapacity(_instance: LlamaCppHandle, recipe: Recipe): Promise<number> {
    return readLlamaCppConfiguration(recipe).contextTokens;
  }

  streamChat(instance: LlamaCppHandle, request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceDelta> {
    return instance.client.streamChat(instance.baseUrl, instance.modelId, request, signal);
  }

  async stop(instance: LlamaCppHandle, mode: StopMode): Promise<StopReport> {
    if (hasExited(instance.process)) return { stopped: true };
    instance.process.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
    const exited = await waitForExit(instance.process, this.#stopTimeoutMs);
    if (!exited && mode !== "force") {
      instance.process.kill("SIGKILL");
      await waitForExit(instance.process, Math.min(this.#stopTimeoutMs, 2_000));
    }
    return { stopped: hasExited(instance.process) };
  }

  async inspect(instance: LlamaCppHandle): Promise<InstanceInspection> {
    if (hasExited(instance.process)) return { healthy: false, modelId: instance.modelId, detail: recentLogs(instance.logs) };
    try {
      return { healthy: await instance.client.healthy(instance.baseUrl, "/health"), modelId: instance.modelId };
    } catch (error) {
      return { healthy: false, modelId: instance.modelId, detail: errorMessage(error) };
    }
  }
}

async function warmFileCache(path: string, signal: AbortSignal): Promise<void> {
  const file = await open(path, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let position = 0;
    while (true) {
      if (signal.aborted) throw abortError();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return;
      position += bytesRead;
    }
  } finally { await file.close(); }
}

export function readLlamaCppConfiguration(recipe: Recipe): LlamaCppConfiguration {
  if (recipe.adapter !== "llama-cpp") throw new TypeError("Recipe adapter must be llama-cpp");
  const value = recipe.configuration;
  const gpuLayers = optionalInteger(value.gpuLayers, "gpuLayers");
  const threads = optionalInteger(value.threads, "threads");
  const expectedVramMiB = optionalNumber(value.expectedVramMiB, "expectedVramMiB");
  const readinessTimeoutMs = optionalNumber(value.readinessTimeoutMs, "readinessTimeoutMs");
  return {
    executable: stringValue(value.executable, "executable"),
    modelPath: stringValue(value.modelPath, "modelPath"),
    contextTokens: integerValue(value.contextTokens ?? recipe.contextTokens, "contextTokens"),
    ...(gpuLayers !== undefined ? { gpuLayers } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(expectedVramMiB !== undefined ? { expectedVramMiB } : {}),
    ...(readinessTimeoutMs !== undefined ? { readinessTimeoutMs } : {}),
    ...(value.prefixArgs !== undefined ? { prefixArgs: stringArray(value.prefixArgs, "prefixArgs") } : {}),
    ...(value.extraArgs !== undefined ? { extraArgs: stringArray(value.extraArgs, "extraArgs") } : {}),
  };
}

export function validateLlamaCppConfiguration(recipe: Recipe): ValidationIssue[] {
  try {
    const config = readLlamaCppConfiguration(recipe);
    const issues: ValidationIssue[] = [];
    if (config.contextTokens < 512) issues.push({ level: "error", code: "invalid_context", message: "contextTokens must be at least 512" });
    if (config.gpuLayers !== undefined && config.gpuLayers < 0) issues.push({ level: "error", code: "invalid_gpu_layers", message: "gpuLayers cannot be negative" });
    const reserved = ["--model", "-m", "--host", "--port", "--api-key", "--ctx-size", "--model-draft", "--spec-type", "--spec-draft-ngl", "--spec-draft-n-max"];
    if (config.extraArgs?.some((arg) => reserved.some((item) => arg === item || arg.startsWith(`${item}=`)))) {
      issues.push({ level: "error", code: "reserved_argument", message: "extraArgs cannot override Fitz-managed arguments" });
    }
    if (recipe.speculativeDecoding && !isSpeculativeDecoding(recipe.speculativeDecoding)) {
      issues.push({ level: "error", code: "invalid_speculative_decoding", message: "speculativeDecoding must contain a drafter path, strategy, and positive maxDraftTokens" });
    }
    return issues;
  } catch (error) {
    return [{ level: "error", code: "invalid_configuration", message: errorMessage(error) }];
  }
}

function isSpeculativeDecoding(value: RecipeSpeculativeDecoding): boolean {
  const baseValid = (value.strategy === "draft-model" || value.strategy === "draft-dflash" || value.strategy === "draft-mtp")
    && Number.isInteger(value.maxDraftTokens) && value.maxDraftTokens > 0
    && (value.gpuLayers === undefined || value.gpuLayers === "all" || value.gpuLayers === "auto" || (Number.isInteger(value.gpuLayers) && value.gpuLayers >= 0));
  if (!baseValid || value.strategy === "draft-mtp") return baseValid;
  return typeof value.drafter?.id === "string" && value.drafter.id.length > 0
    && typeof value.drafter.modelId === "string" && value.drafter.modelId.length > 0
    && typeof value.drafter.path === "string" && value.drafter.path.length > 0;
}

function llamaSpeculativeArgs(value: RecipeSpeculativeDecoding): string[] {
  if (value.strategy === "draft-mtp") {
    return [
      "--spec-type", value.strategy,
      "--spec-draft-ngl", value.gpuLayers === "all" || value.gpuLayers === "auto" || value.gpuLayers === undefined ? "999" : String(value.gpuLayers),
      "--spec-draft-n-max", String(value.maxDraftTokens),
    ];
  }
  return [
    "--model-draft", value.drafter.path,
    "--spec-type", value.strategy,
    "--spec-draft-ngl", value.gpuLayers === "all" || value.gpuLayers === "auto" || value.gpuLayers === undefined ? "999" : String(value.gpuLayers),
    "--spec-draft-n-max", String(value.maxDraftTokens),
  ];
}

function stripLlamaSpeculativeArgs(args: string[]): string[] {
  const options = new Set(["--model-draft", "--spec-type", "--spec-draft-ngl", "--spec-draft-n-max"]);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    const option = item.split("=", 1)[0] ?? "";
    if (!options.has(option)) { result.push(item); continue; }
    if (!item.includes("=") && index + 1 < args.length) index += 1;
  }
  return result;
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

function hasExited(child: ChildProcessWithoutNullStreams): boolean { return child.exitCode !== null || child.signalCode !== null; }
function recentLogs(logs: string[]): string { return logs.slice(-10).join(" | ") || "no logs"; }
function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`); return value; }
function integerValue(value: unknown, name: string): number { if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`); return value as number; }
function optionalInteger(value: unknown, name: string): number | undefined { return value === undefined ? undefined : integerValue(value, name); }
function optionalNumber(value: unknown, name: string): number | undefined { if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`); return value; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new TypeError(`${name} must be an array of strings`); return value; }
function abortError(): Error { const error = new Error("Operation aborted"); error.name = "AbortError"; return error; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
