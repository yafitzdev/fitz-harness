import type { Recipe, ValidationIssue } from "@fitz/protocol";

export interface NInferRecipeConfiguration {
  executable: string;
  artifact: string;
  maxContext: number;
  kvDtype: "int8" | "bf16" | "fp16";
  speculativeMode: "mtp" | "none";
  draftTokens: number;
  lmHeadDraft: boolean;
  thinking: boolean;
  temperature: number;
  topP: number;
  topK: number;
  requestLogJsonl?: string;
  expectedVramMiB?: number;
  readinessTimeoutMs?: number;
  extraArgs?: string[];
}

export function readNInferConfiguration(recipe: Recipe): NInferRecipeConfiguration {
  const value = recipe.configuration;
  const executable = stringValue(value.executable, "executable");
  const artifact = stringValue(value.artifact, "artifact");
  const maxContext = integerValue(value.maxContext ?? recipe.contextTokens, "maxContext");
  const kvDtype = enumValue(value.kvDtype ?? "int8", ["int8", "bf16", "fp16"], "kvDtype");
  const speculativeMode = enumValue(
    value.speculativeMode ?? "mtp",
    ["mtp", "none"],
    "speculativeMode",
  );
  const draftTokens = integerValue(value.draftTokens ?? 0, "draftTokens");
  const lmHeadDraft = booleanValue(value.lmHeadDraft ?? true, "lmHeadDraft");
  const thinking = booleanValue(value.thinking ?? false, "thinking");
  const temperature = numberValue(value.temperature ?? 0.4, "temperature");
  const topP = numberValue(value.topP ?? 0.9, "topP");
  const topK = integerValue(value.topK ?? 20, "topK");
  const extraArgs = value.extraArgs === undefined ? undefined : stringArray(value.extraArgs, "extraArgs");

  return {
    executable,
    artifact,
    maxContext,
    kvDtype,
    speculativeMode,
    draftTokens,
    lmHeadDraft,
    thinking,
    temperature,
    topP,
    topK,
    ...(typeof value.requestLogJsonl === "string"
      ? { requestLogJsonl: value.requestLogJsonl }
      : {}),
    ...(typeof value.expectedVramMiB === "number"
      ? { expectedVramMiB: value.expectedVramMiB }
      : {}),
    ...(typeof value.readinessTimeoutMs === "number"
      ? { readinessTimeoutMs: value.readinessTimeoutMs }
      : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function validateNInferConfiguration(recipe: Recipe): ValidationIssue[] {
  try {
    const config = readNInferConfiguration(recipe);
    const issues: ValidationIssue[] = [];
    if (config.maxContext < 2_048 || config.maxContext > 262_144) {
      issues.push({
        level: "error",
        code: "invalid_context",
        message: "NInfer maxContext must be between 2048 and 262144",
      });
    }
    if (config.speculativeMode === "mtp" && config.draftTokens < 1) {
      issues.push({
        level: "error",
        code: "invalid_draft_tokens",
        message: "MTP requires at least one draft token",
      });
    }
    const reservedArguments = [
      "--host",
      "--port",
      "--api-key",
      "--model-id",
      "--max-context",
      "--request-log-jsonl",
    ];
    if (
      config.extraArgs?.some((argument) =>
        reservedArguments.some(
          (reserved) => argument === reserved || argument.startsWith(`${reserved}=`),
        ),
      )
    ) {
      issues.push({
        level: "error",
        code: "reserved_argument",
        message: "extraArgs cannot override Fitz-managed arguments",
      });
    }
    return issues;
  } catch (error) {
    return [
      {
        level: "error",
        code: "invalid_configuration",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a string`);
  return value;
}

function integerValue(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
  return value as number;
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}
