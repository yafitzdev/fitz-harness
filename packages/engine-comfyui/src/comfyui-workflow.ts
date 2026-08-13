import { randomBytes } from "node:crypto";
import type { MediaGenerationParams, Recipe, ValidationIssue } from "@fitz/protocol";

/** Node-id → inputs overrides for injecting generation params into a pinned
 * workflow without requiring placeholder strings in the graph. */
export interface ComfyUIWorkflowOverrides {
  promptNodeId?: string;
  negativeNodeId?: string;
  seedNodeIds?: string[];
}

/** Typed recipe configuration consumed by the ComfyUI engine adapter. */
export interface ComfyUIConfiguration {
  executable?: string;
  cwd?: string;
  entrypoint?: string;
  launchArgs?: string[];
  runtime?: "linux-managed";
  runtimeId?: string;
  baseUrl?: string;
  expectedVramMiB?: number;
  readinessTimeoutMs?: number;
  comfyuiWorkflow?: Readonly<Record<string, unknown>>;
  comfyuiEditWorkflow?: Readonly<Record<string, unknown>>;
  comfyuiAnimateWorkflow?: Readonly<Record<string, unknown>>;
  comfyuiWorkflowPath?: string;
  outputFormats?: string[];
  defaults?: Readonly<Record<string, unknown>>;
  comfyuiOverrides?: ComfyUIWorkflowOverrides;
}

/** Reads the ComfyUI-specific recipe configuration into its typed form. */
export function readComfyUIConfiguration(recipe: Recipe): ComfyUIConfiguration {
  if (recipe.adapter !== "comfyui") throw new TypeError("Recipe adapter must be comfyui");
  const value = recipe.configuration;
  return {
    ...(value.executable !== undefined ? { executable: stringValue(value.executable, "executable") } : {}),
    ...(value.cwd !== undefined ? { cwd: stringValue(value.cwd, "cwd") } : {}),
    ...(value.entrypoint !== undefined ? { entrypoint: stringValue(value.entrypoint, "entrypoint") } : {}),
    ...(value.launchArgs !== undefined ? { launchArgs: stringArray(value.launchArgs, "launchArgs") } : {}),
    ...(value.runtime !== undefined ? { runtime: linuxRuntimeValue(value.runtime) } : {}),
    ...(value.runtimeId !== undefined ? { runtimeId: stringValue(value.runtimeId, "runtimeId") } : {}),
    ...(value.baseUrl !== undefined ? { baseUrl: stringValue(value.baseUrl, "baseUrl") } : {}),
    ...(value.expectedVramMiB !== undefined ? { expectedVramMiB: nonNegativeNumber(value.expectedVramMiB, "expectedVramMiB") } : {}),
    ...(value.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: nonNegativeNumber(value.readinessTimeoutMs, "readinessTimeoutMs") } : {}),
    ...(value.comfyuiWorkflow !== undefined ? { comfyuiWorkflow: parseWorkflowValue(value.comfyuiWorkflow) } : {}),
    ...(value.comfyuiEditWorkflow !== undefined ? { comfyuiEditWorkflow: parseWorkflowValue(value.comfyuiEditWorkflow) } : {}),
    ...(value.comfyuiAnimateWorkflow !== undefined ? { comfyuiAnimateWorkflow: parseWorkflowValue(value.comfyuiAnimateWorkflow) } : {}),
    ...(value.comfyuiWorkflowPath !== undefined ? { comfyuiWorkflowPath: stringValue(value.comfyuiWorkflowPath, "comfyuiWorkflowPath") } : {}),
    ...(value.outputFormats !== undefined ? { outputFormats: stringArray(value.outputFormats, "outputFormats") } : {}),
    ...(value.defaults !== undefined ? { defaults: readDefaults(value.defaults) } : {}),
    ...(value.comfyuiOverrides !== undefined ? { comfyuiOverrides: readComfyUIOverrides(value.comfyuiOverrides) } : {}),
  };
}

/** Validates workflow pinning, managed/external mode exclusivity, and media defaults. */
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
    if (config.comfyuiWorkflow !== undefined && !isComfyUIWorkflowGraph(config.comfyuiWorkflow)) {
      issues.push({ level: "error", code: "invalid_workflow_graph", message: "comfyuiWorkflow must be a non-empty object of { class_type, inputs } nodes" });
    }
    if (config.comfyuiEditWorkflow !== undefined && !isComfyUIWorkflowGraph(config.comfyuiEditWorkflow)) {
      issues.push({ level: "error", code: "invalid_edit_workflow_graph", message: "comfyuiEditWorkflow must be a non-empty object of { class_type, inputs } nodes" });
    }
    if (config.comfyuiAnimateWorkflow !== undefined && !isComfyUIWorkflowGraph(config.comfyuiAnimateWorkflow)) {
      issues.push({ level: "error", code: "invalid_animate_workflow_graph", message: "comfyuiAnimateWorkflow must be a non-empty object of { class_type, inputs } nodes" });
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
    if (config.runtime === "linux-managed" && !config.runtimeId) {
      issues.push({ level: "error", code: "missing_runtime_id", message: "managed Linux ComfyUI requires runtimeId" });
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

/** Applies recipe defaults once so submission and durable retry use identical parameters. */
export function applyGenerationDefaults(
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
    negativePrompt: params.negativePrompt ?? "",
    ...(size !== undefined ? { size } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(sampler !== undefined ? { sampler } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    seed: params.seed ?? randomBytes(6).readUIntBE(0, 6),
  };
}

/** Compiles generation params into a cloned pinned ComfyUI workflow graph. */
export function substituteWorkflow(
  graph: Readonly<Record<string, unknown>>,
  params: MediaGenerationParams,
  overrides: ComfyUIWorkflowOverrides = {},
  referenceNames: readonly string[] = [],
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
    node.inputs = substituteInputs(inputs, params, size, referenceNames);
  }
  return clone;
}

function substituteInputs(
  inputs: Record<string, unknown>,
  params: MediaGenerationParams,
  size: { width: number; height: number } | undefined,
  referenceNames: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = typeof value === "string" ? substitutePlaceholders(value, params, size, referenceNames) : value;
  }
  return out;
}

function substitutePlaceholders(
  value: string,
  params: MediaGenerationParams,
  size: { width: number; height: number } | undefined,
  referenceNames: readonly string[],
): unknown {
  const referenceMatch = /^\{\{ref_(\d+)\}\}$/.exec(value);
  if (referenceMatch) return referenceNames[Number(referenceMatch[1])];
  const exact = exactPlaceholderValue(value, params, size);
  if (exact !== undefined) return exact;
  let result = value;
  result = result.replaceAll("{{prompt}}", params.prompt);
  result = result.replaceAll("{{negative_prompt}}", params.negativePrompt ?? "");
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
    case "{{negative_prompt}}": return params.negativePrompt ?? "";
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

export function isComfyUIWorkflowGraph(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every(
    (node) => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringDefault(defaults: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = defaults?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberDefault(defaults: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const value = defaults?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function linuxRuntimeValue(value: unknown): "linux-managed" {
  if (value !== "linux-managed") throw new TypeError("runtime must be linux-managed");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
