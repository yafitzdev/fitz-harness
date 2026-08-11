import { access } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
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
  ResourceEstimate,
  ValidationReport,
} from "@fitz/protocol";
import {
  readNInferConfiguration,
  validateNInferConfiguration,
  type NInferRecipeConfiguration,
} from "./config.js";
import { parseSseJson } from "./sse.js";

export interface NInferInstanceHandle extends EngineInstanceHandle {
  modelId: string;
  apiKey: string;
  process: ChildProcessWithoutNullStreams;
  logs: string[];
  readinessTimeoutMs: number;
  guestProcess?: { pid?: number };
}

export interface NInferAdapterOptions {
  fetch?: typeof globalThis.fetch;
  validatePaths?: boolean;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
  readinessTimeoutMs?: number;
  wslDistribution?: string;
  wslUser?: string;
}

export interface NInferProcessLaunch {
  executable: string;
  args: string[];
  stdin?: string;
}

const execFileAsync = promisify(execFile);

export class NInferEngineAdapter implements EngineAdapter<NInferInstanceHandle> {
  readonly id = "ninfer";
  readonly #fetch: typeof globalThis.fetch;
  readonly #validatePaths: boolean;
  readonly #pollIntervalMs: number;
  readonly #stopTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #wslDistribution: string | undefined;
  readonly #wslUser: string;

  constructor(options: NInferAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#validatePaths = options.validatePaths ?? true;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000;
    this.#wslDistribution = options.wslDistribution;
    this.#wslUser = options.wslUser ?? "root";
  }

  async prepare(recipe: Recipe, signal: AbortSignal): Promise<void> {
    const config = readNInferConfiguration(recipe);
    if (!this.#wslDistribution) {
      await access(config.executable);
      await access(config.artifact);
      return;
    }
    await execFileAsync("wsl.exe", [
      "-d", this.#wslDistribution, "-u", this.#wslUser, "--", "test", "-x", config.executable,
    ], { windowsHide: true, signal });
    await execFileAsync("wsl.exe", [
      "-d", this.#wslDistribution, "-u", this.#wslUser, "--", "test", "-r", config.artifact,
    ], { windowsHide: true, signal });
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = validateNInferConfiguration(recipe);
    if (issues.length === 0 && this.#validatePaths) {
      const config = readNInferConfiguration(recipe);
      for (const [code, path] of [
        ["missing_executable", config.executable],
        ["missing_artifact", config.artifact],
      ] as const) {
        try {
          await this.#assertReadable(path);
        } catch {
          issues.push({ level: "error", code, message: `Path is not readable: ${path}` });
        }
      }
    }
    return { valid: issues.every((issue) => issue.level !== "error"), issues };
  }

  async estimateResources(recipe: Recipe): Promise<ResourceEstimate> {
    const expected = readNInferConfiguration(recipe).expectedVramMiB;
    return expected === undefined ? {} : { vramMiB: expected };
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    const config = readNInferConfiguration(recipe);
    const args = [
      config.artifact,
      "--host",
      allocation.host,
      "--port",
      String(allocation.port),
      "--model-id",
      recipe.modelId,
      "--max-context",
      String(config.maxContext),
      "--kv-dtype",
      config.kvDtype,
      "--temperature",
      String(config.temperature),
      "--top-p",
      String(config.topP),
      "--top-k",
      String(config.topK),
    ];
    if (config.speculativeMode !== "none") {
      args.push("--spec", config.speculativeMode, "--draft-tokens", String(config.draftTokens));
    }
    if (config.lmHeadDraft) args.push("--lm-head-draft");
    if (!config.thinking) args.push("--no-thinking");
    if (config.requestLogJsonl) args.push("--request-log-jsonl", config.requestLogJsonl);
    if (config.extraArgs) args.push(...config.extraArgs);
    return {
      executable: config.executable,
      args,
      env: {},
      internalHost: allocation.host,
      internalPort: allocation.port,
    };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<NInferInstanceHandle> {
    if (signal.aborted) throw abortError();
    const config = readNInferConfiguration(recipe);
    const apiKey = randomBytes(32).toString("base64url");
    const launch = buildNInferProcessLaunch(spec, apiKey, this.#wslDistribution, this.#wslUser);
    const guestProcess: { pid?: number } | undefined = this.#wslDistribution ? {} : undefined;
    const child = spawn(launch.executable, launch.args, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: { ...process.env, ...spec.env },
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    if (launch.stdin) child.stdin.end(launch.stdin);
    const logs: string[] = [];
    captureLines(child.stdout, logs, "stdout");
    captureLines(child.stderr, logs, "stderr", (line) => {
      const match = /^__FITZ_GUEST_PID=(\d+)$/.exec(line);
      if (match && guestProcess) guestProcess.pid = Number.parseInt(match[1]!, 10);
    });
    await waitForSpawn(child, signal);
    return {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: `http://${spec.internalHost}:${spec.internalPort}`,
      startedAt: new Date(),
      apiKey,
      process: child,
      logs,
      readinessTimeoutMs: config.readinessTimeoutMs ?? this.#readinessTimeoutMs,
      ...(guestProcess ? { guestProcess } : {}),
    };
  }

  async waitUntilReady(instance: NInferInstanceHandle, signal: AbortSignal): Promise<ReadyInfo> {
    const deadline = Date.now() + instance.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      if (hasExited(instance.process)) {
        const recentLogs = recentInstanceLogs(instance);
        throw new Error(
          `NInfer exited before becoming ready (code ${instance.process.exitCode ?? instance.process.signalCode})${recentLogs ? `. Recent logs: ${recentLogs}` : ""}`,
        );
      }
      const probe = new AbortController();
      const abortProbe = () => probe.abort(signal.reason);
      const probeTimeout = setTimeout(
        () => probe.abort(),
        Math.max(1, Math.min(2_000, deadline - Date.now())),
      );
      signal.addEventListener("abort", abortProbe, { once: true });
      try {
        const response = await this.#fetch(`${instance.baseUrl}/health`, {
          headers: authorization(instance.apiKey),
          signal: probe.signal,
        });
        if (response.ok) return { modelId: instance.modelId, baseUrl: instance.baseUrl };
      } catch (error) {
        if (signal.aborted) throw abortError();
      } finally {
        clearTimeout(probeTimeout);
        signal.removeEventListener("abort", abortProbe);
      }
      if (Date.now() < deadline) {
        await delay(Math.min(this.#pollIntervalMs, deadline - Date.now()), signal);
      }
    }
    const recentLogs = recentInstanceLogs(instance);
    throw new Error(
      `Timed out waiting for NInfer at ${instance.baseUrl}${recentLogs ? `. Recent logs: ${recentLogs}` : ""}`,
    );
  }

  async *streamChat(
    instance: NInferInstanceHandle,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    const response = await this.#fetch(`${instance.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authorization(instance.apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        model: instance.modelId,
        messages: request.messages,
        stream: true,
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { top_p: request.topP } : {}),
        ...(request.stop !== undefined ? { stop: request.stop } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
        ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`NInfer request failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    for await (const chunk of parseSseJson(response.body, signal)) {
      if (chunk.error) throw new Error(chunk.error.message ?? "NInfer stream failed");
      const choice = chunk.choices?.[0];
      const finishReason = normalizeFinishReason(choice?.finish_reason);
      yield {
        text: choice?.delta?.content ?? "",
        ...(choice?.delta?.tool_calls?.length ? { toolCalls: choice.delta.tool_calls } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(chunk.usage?.prompt_tokens !== undefined
          ? { promptTokens: chunk.usage.prompt_tokens }
          : {}),
        ...(chunk.usage?.completion_tokens !== undefined
          ? { completionTokens: chunk.usage.completion_tokens }
          : {}),
      };
    }
  }

  async stop(instance: NInferInstanceHandle, mode: StopMode): Promise<StopReport> {
    if (hasExited(instance.process)) return { stopped: true };
    if (this.#wslDistribution && instance.guestProcess?.pid) {
      await this.#signalGuest(instance.guestProcess.pid, mode === "force" ? "KILL" : "TERM");
    } else {
      instance.process.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
    }
    const exited = await waitForExit(instance.process, this.#stopTimeoutMs);
    if (!exited && mode !== "force") {
      if (this.#wslDistribution && instance.guestProcess?.pid) await this.#signalGuest(instance.guestProcess.pid, "KILL");
      instance.process.kill("SIGKILL");
      await waitForExit(instance.process, Math.min(this.#stopTimeoutMs, 2_000));
    }
    return { stopped: hasExited(instance.process) };
  }

  async inspect(instance: NInferInstanceHandle): Promise<InstanceInspection> {
    if (hasExited(instance.process)) {
      return {
        healthy: false,
        modelId: instance.modelId,
        detail: `exited:${instance.process.exitCode ?? instance.process.signalCode}`,
      };
    }
    try {
      const response = await this.#fetch(`${instance.baseUrl}/health`, {
        headers: authorization(instance.apiKey),
      });
      return { healthy: response.ok, modelId: instance.modelId };
    } catch (error) {
      return { healthy: false, modelId: instance.modelId, detail: errorMessage(error) };
    }
  }

  async #assertReadable(path: string): Promise<void> {
    if (!this.#wslDistribution) { await access(path); return; }
    await execFileAsync("wsl.exe", ["-d", this.#wslDistribution, "-u", this.#wslUser, "--", "test", "-r", path], { timeout: 10_000, windowsHide: true });
  }

  async #signalGuest(pid: number, signal: "TERM" | "KILL"): Promise<void> {
    try {
      await execFileAsync("wsl.exe", ["-d", this.#wslDistribution!, "-u", this.#wslUser, "--", "kill", `-${signal}`, String(pid)], { timeout: 10_000, windowsHide: true });
    } catch {
      // A process that exited between inspection and signaling is already stopped.
    }
  }
}

function recentInstanceLogs(instance: Pick<NInferInstanceHandle, "logs" | "apiKey">): string {
  return instance.logs
    .slice(-6)
    .map((line) => line.replaceAll(instance.apiKey, "[REDACTED]"))
    .join(" | ");
}

export function buildNInferProcessLaunch(spec: LaunchSpec, apiKey: string, wslDistribution?: string, wslUser = "root"): NInferProcessLaunch {
  const engineArgs = [...spec.args, "--api-key", apiKey];
  if (!wslDistribution) return { executable: spec.executable, args: engineArgs };
  return {
    executable: "wsl.exe",
    args: ["-d", wslDistribution, "-u", wslUser, "--", "sh", "-s", "--", spec.executable, ...engineArgs],
    stdin: 'printf "__FITZ_GUEST_PID=%s\\n" "$$" >&2\nexec "$@"\n',
  };
}

export function buildCurrentNInferRecipe(
  id: string,
  modelId: string,
  artifact: string,
  draftTokens: number,
  executable: string,
): Recipe {
  const configuration: NInferRecipeConfiguration = {
    executable,
    artifact,
    maxContext: 100_000,
    kvDtype: "int8",
    speculativeMode: "mtp",
    draftTokens,
    lmHeadDraft: true,
    thinking: false,
    temperature: 0.4,
    topP: 0.9,
    topK: 20,
    requestLogJsonl: "/var/log/ninfer/fitz-requests.jsonl",
  };
  return {
    id,
    playbookId: "ninfer-current-wsl",
    displayName: modelId,
    adapter: "ninfer",
    modelId,
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      toolCalls: true,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 60,
      minimumResidencySeconds: 30,
    },
    configuration: { ...configuration },
  };
}

function authorization(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
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

async function waitForSpawn(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => finish(resolve);
    const failed = (error: Error) => finish(() => reject(error));
    const aborted = () => {
      child.kill("SIGKILL");
      finish(() => reject(abortError()));
    };
    const finish = (action: (() => void) | ((value: void) => void)) => {
      child.off("spawn", spawned);
      child.off("error", failed);
      signal.removeEventListener("abort", aborted);
      action();
    };
    child.once("spawn", spawned);
    child.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const exited = () => finish(true);
    const finish = (value: boolean) => {
      clearTimeout(timeout);
      child.off("exit", exited);
      resolve(value);
    };
    child.once("exit", exited);
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function normalizeFinishReason(value: string | null | undefined): InferenceDelta["finishReason"] {
  if (value === "length") return "length";
  if (value === "tool_calls") return "tool_calls";
  if (value === "stop" || value === "stop_token") return "stop";
  return undefined;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
