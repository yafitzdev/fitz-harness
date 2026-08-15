import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import type {
  EngineAdapter,
  InstanceInspection,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "@fitz/inference-core";
import type { InferenceDelta, InferenceRequest, LaunchSpec, Recipe, ResourceEstimate, ValidationIssue, ValidationReport } from "@fitz/protocol";
import { OpenAICompatibleClient } from "./openai-compatible-client.js";

export interface ManagedOpenAIConfiguration {
  enginePath: string;
  runtime: "linux-managed";
  runtimeId: string;
  command: string;
  args: string[];
  workingDirectory: string;
  healthPath: string;
  readinessTimeoutMs: number;
  environment: Record<string, string>;
}

export interface ManagedLinuxRuntimeTarget { distribution: string }

const execFileAsync = promisify(execFile);

export interface ManagedOpenAIHandle {
  id: string;
  recipeId: string;
  modelId: string;
  baseUrl: string;
  startedAt: Date;
  process: ChildProcessWithoutNullStreams;
  client: OpenAICompatibleClient;
  logs: string[];
  healthPath: string;
  readinessTimeoutMs: number;
  guestProcess?: { pid?: number; distribution: string };
}

export class ManagedOpenAIEngineAdapter implements EngineAdapter<ManagedOpenAIHandle> {
  readonly id = "openai-managed";
  readonly #fetch: typeof globalThis.fetch;
  readonly #pollIntervalMs: number;
  readonly #stopTimeoutMs: number;
  readonly #linuxRuntimes: ReadonlyMap<string, ManagedLinuxRuntimeTarget>;

  constructor(options: { fetch?: typeof globalThis.fetch; pollIntervalMs?: number; stopTimeoutMs?: number; linuxRuntimes?: ReadonlyMap<string, ManagedLinuxRuntimeTarget> } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.#linuxRuntimes = options.linuxRuntimes ?? new Map();
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = validateManagedOpenAIConfiguration(recipe);
    return { valid: issues.every((issue) => issue.level !== "error"), issues };
  }

  async estimateResources(_recipe: Recipe): Promise<ResourceEstimate> { return {}; }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    const config = readManagedOpenAIConfiguration(recipe);
    const values = { host: allocation.host, port: String(allocation.port), model: recipe.modelId, context: String(recipe.contextTokens) };
    const args = config.args.map((argument) => interpolate(argument, values));
    const workingDirectory = posix.resolve(config.enginePath, config.workingDirectory);
    const target = this.#linuxRuntimes.get(config.runtimeId);
    if (!target) throw new Error(`Managed Linux runtime is unavailable: ${config.runtimeId}`);
    const command = isPathLike(config.command) && !posix.isAbsolute(config.command)
      ? posix.resolve(workingDirectory, config.command)
      : config.command;
    const guestCommand = Object.keys(config.environment).length > 0
      ? ["/usr/bin/env", ...Object.entries(config.environment).map(([key, value]) => `${key}=${value}`), command, ...args]
      : [command, ...args];
    return {
      executable: "wsl.exe",
      args: ["-d", target.distribution, "-u", "root", "--", "sh", "-s", "--", workingDirectory, ...guestCommand],
      env: {}, internalHost: allocation.host, internalPort: allocation.port,
    };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<ManagedOpenAIHandle> {
    if (signal.aborted) throw abortError();
    const config = readManagedOpenAIConfiguration(recipe);
    const child = spawn(spec.executable, spec.args, { ...(spec.cwd ? { cwd: spec.cwd } : {}), env: { ...process.env, ...spec.env }, shell: false, windowsHide: true, stdio: "pipe" });
    const logs: string[] = [];
    const guestProcess: { pid?: number; distribution: string } = { distribution: this.#linuxRuntimes.get(config.runtimeId)!.distribution };
    captureLines(child.stdout, logs, "stdout");
    captureLines(child.stderr, logs, "stderr", (line) => {
      const match = /^__FITZ_GUEST_PID=(\d+)$/.exec(line);
      if (match && guestProcess) guestProcess.pid = Number.parseInt(match[1]!, 10);
    });
    child.stdin.end('cd "$1"\nprintf "__FITZ_GUEST_PID=%s\\n" "$$" >&2\nshift\nexec "$@"\n');
    await waitForSpawn(child, signal);
    return {
      id: randomUUID(), recipeId: recipe.id, modelId: recipe.modelId,
      baseUrl: `http://${spec.internalHost}:${spec.internalPort}`, startedAt: new Date(), process: child,
      client: new OpenAICompatibleClient({ fetch: this.#fetch }), logs, healthPath: config.healthPath, readinessTimeoutMs: config.readinessTimeoutMs,
      guestProcess,
    };
  }

  async waitUntilReady(instance: ManagedOpenAIHandle, signal: AbortSignal): Promise<ReadyInfo> {
    const deadline = Date.now() + instance.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted) throw abortError();
      if (hasExited(instance.process)) throw new Error(`Engine exited before its API became ready: ${recentLogs(instance.logs)}`);
      try { if (await instance.client.healthy(instance.baseUrl, instance.healthPath, signal)) return { modelId: instance.modelId, baseUrl: instance.baseUrl }; }
      catch (error) { if (signal.aborted) throw error; }
      await delay(this.#pollIntervalMs, signal);
    }
    throw new Error(`Timed out waiting for the OpenAI-compatible API at ${instance.baseUrl}`);
  }

  async contextCapacity(instance: ManagedOpenAIHandle, recipe: Recipe): Promise<number> {
    return detectedContextCapacity(instance.logs) ?? recipe.contextTokens;
  }

  streamChat(instance: ManagedOpenAIHandle, request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceDelta> {
    return instance.client.streamChat(instance.baseUrl, instance.modelId, request, signal);
  }

  async stop(instance: ManagedOpenAIHandle, mode: StopMode): Promise<StopReport> {
    if (hasExited(instance.process)) return { stopped: true };
    const guestPid = instance.guestProcess?.pid;
    if (guestPid) await signalGuest({ pid: guestPid, distribution: instance.guestProcess!.distribution }, mode === "force" ? "KILL" : "TERM");
    else instance.process.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
    const exited = await waitForExit(instance.process, this.#stopTimeoutMs);
    if (!exited && mode !== "force") {
      if (guestPid) await signalGuest({ pid: guestPid, distribution: instance.guestProcess!.distribution }, "KILL");
      instance.process.kill("SIGKILL");
      await waitForExit(instance.process, Math.min(this.#stopTimeoutMs, 2_000));
    }
    return { stopped: hasExited(instance.process) };
  }

  async inspect(instance: ManagedOpenAIHandle): Promise<InstanceInspection> {
    if (hasExited(instance.process)) return { healthy: false, modelId: instance.modelId, detail: recentLogs(instance.logs) };
    try { return { healthy: await instance.client.healthy(instance.baseUrl, instance.healthPath), modelId: instance.modelId }; }
    catch (error) { return { healthy: false, modelId: instance.modelId, detail: errorMessage(error) }; }
  }
}

/** Managed servers report their realized shared cache in startup output. This
 * is runtime telemetry, not recipe configuration, and is intentionally parsed
 * behind the adapter boundary. */
function detectedContextCapacity(logs: readonly string[]): number | undefined {
  const patterns = [
    /GPU KV cache size:\s*([0-9][0-9,]*)\s*tokens/i,
    /["']?kv[_ -]?capacity["']?\s*[:=]\s*([0-9][0-9,]*)/i,
    /shared[_ -]?context(?:[_ -]?tokens)?\s*[:=]\s*([0-9][0-9,]*)/i,
  ];
  for (const line of [...logs].reverse()) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const value = Number.parseInt(match[1]!.replaceAll(",", ""), 10);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return undefined;
}

export function readManagedOpenAIConfiguration(recipe: Recipe): ManagedOpenAIConfiguration {
  if (recipe.adapter !== "openai-managed") throw new TypeError("Recipe adapter must be openai-managed");
  const value = recipe.configuration;
  const runtime = value.runtime;
  if (runtime !== "linux-managed") throw new TypeError("runtime must be linux-managed");
  const readinessTimeoutMs = value.readinessTimeoutMs === undefined ? 120_000 : numberValue(value.readinessTimeoutMs, "readinessTimeoutMs");
  return {
    enginePath: stringValue(value.enginePath, "enginePath"), runtime, command: stringValue(value.command, "command"),
    args: stringArray(value.args, "args"), workingDirectory: optionalString(value.workingDirectory, "workingDirectory") ?? ".",
    healthPath: optionalString(value.healthPath, "healthPath") ?? "/v1/models", readinessTimeoutMs,
    environment: optionalStringRecord(value.environment, "environment") ?? {},
    runtimeId: stringValue(value.runtimeId, "runtimeId"),
  };
}

export function validateManagedOpenAIConfiguration(recipe: Recipe): ValidationIssue[] {
  try {
    const config = readManagedOpenAIConfiguration(recipe);
    if (!posix.isAbsolute(config.enginePath)) return [{ level: "error", code: "invalid_engine_path", message: "enginePath must be absolute" }];
    const workingDirectory = posix.resolve(config.enginePath, config.workingDirectory);
    if (!isWithinPosix(config.enginePath, workingDirectory)) return [{ level: "error", code: "invalid_working_directory", message: "workingDirectory must stay inside enginePath" }];
    const commandAbsolute = posix.isAbsolute(config.command);
    const resolvedCommand = posix.resolve(workingDirectory, config.command);
    if (isPathLike(config.command) && !commandAbsolute && !isWithinPosix(config.enginePath, resolvedCommand)) {
      return [{ level: "error", code: "invalid_command_path", message: "Relative command paths must stay inside enginePath" }];
    }
    if (!config.healthPath.startsWith("/") || config.healthPath.startsWith("//")) return [{ level: "error", code: "invalid_health_path", message: "healthPath must be an absolute URL path" }];
    if (config.readinessTimeoutMs < 1) return [{ level: "error", code: "invalid_timeout", message: "readinessTimeoutMs must be positive" }];
    return [];
  } catch (error) { return [{ level: "error", code: "invalid_configuration", message: errorMessage(error) }]; }
}

function interpolate(value: string, replacements: Record<string, string>): string { return value.replace(/\{(host|port|model|context)\}/g, (_match, key: string) => replacements[key] ?? ""); }
function isPathLike(value: string): boolean { return value.startsWith(".") || value.includes("/") || value.includes("\\"); }
function isWithinPosix(parent: string, child: string): boolean { const path = posix.relative(posix.resolve(parent), posix.resolve(child)); return path === "" || (!path.startsWith("..") && !posix.isAbsolute(path)); }
function captureLines(stream: Readable, logs: string[], source: string, onLine?: (line: string) => void): void { stream.setEncoding("utf8"); stream.on("data", (chunk: string) => { for (const line of chunk.split(/\r?\n/).filter(Boolean)) { onLine?.(line); logs.push(`${source}: ${line}`); if (logs.length > 500) logs.shift(); } }); }
async function waitForSpawn(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<void> { await new Promise<void>((resolvePromise, reject) => { const spawned = () => finish(resolvePromise); const failed = (error: Error) => finish(() => reject(error)); const aborted = () => { child.kill("SIGKILL"); finish(() => reject(abortError())); }; const finish = (action: () => void) => { child.off("spawn", spawned); child.off("error", failed); signal.removeEventListener("abort", aborted); action(); }; child.once("spawn", spawned); child.once("error", failed); signal.addEventListener("abort", aborted, { once: true }); }); }
async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> { if (hasExited(child)) return true; return new Promise((resolvePromise) => { const timeout = setTimeout(() => finish(false), timeoutMs); const exited = () => finish(true); const finish = (value: boolean) => { clearTimeout(timeout); child.off("exit", exited); resolvePromise(value); }; child.once("exit", exited); }); }
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> { if (signal.aborted) throw abortError(); await new Promise<void>((resolvePromise, reject) => { const timeout = setTimeout(() => { signal.removeEventListener("abort", aborted); resolvePromise(); }, milliseconds); const aborted = () => { clearTimeout(timeout); reject(abortError()); }; signal.addEventListener("abort", aborted, { once: true }); }); }
function hasExited(child: ChildProcessWithoutNullStreams): boolean { return child.exitCode !== null || child.signalCode !== null; }
function recentLogs(logs: string[]): string { return logs.slice(-10).join(" | ") || "no logs"; }
function stringValue(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`); return value; }
function optionalString(value: unknown, name: string): string | undefined { return value === undefined ? undefined : stringValue(value, name); }
function numberValue(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`); return value; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} must be an array of strings`); return value; }
function optionalStringRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object of strings`);
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string")) {
    throw new TypeError(`${name} must contain valid environment names and string values`);
  }
  return Object.fromEntries(entries);
}
function abortError(): Error { const error = new Error("Operation aborted"); error.name = "AbortError"; return error; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function signalGuest(process: { pid: number; distribution: string }, signal: "TERM" | "KILL"): Promise<void> {
  try { await execFileAsync("wsl.exe", ["-d", process.distribution, "-u", "root", "--", "kill", `-${signal}`, String(process.pid)], { timeout: 10_000, windowsHide: true }); }
  catch { /* A guest that exited between inspection and signaling is already stopped. */ }
}
