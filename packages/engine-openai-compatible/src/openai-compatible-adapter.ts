import { randomUUID } from "node:crypto";
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
  ValidationIssue,
  ValidationReport,
} from "@fitz/protocol";
import { OpenAICompatibleClient } from "./openai-compatible-client.js";

export interface OpenAICompatibleConfiguration {
  baseUrl: string;
  apiKeyEnv?: string;
  healthPath: string;
  allowInsecureRemote: boolean;
}

export interface OpenAICompatibleHandle extends EngineInstanceHandle {
  modelId: string;
  healthPath: string;
  client: OpenAICompatibleClient;
}

export interface OpenAICompatibleAdapterOptions {
  fetch?: typeof globalThis.fetch;
  environment?: Readonly<Record<string, string | undefined>>;
}

export class OpenAICompatibleEngineAdapter implements EngineAdapter<OpenAICompatibleHandle> {
  readonly id = "openai-compatible";
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#environment = options.environment ?? process.env;
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = validateConfiguration(recipe);
    return { valid: issues.every((issue) => issue.level !== "error"), issues };
  }

  async estimateResources(_recipe: Recipe): Promise<ResourceEstimate> {
    return {};
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    const config = readConfiguration(recipe);
    const url = new URL(config.baseUrl);
    return {
      executable: "external-openai-compatible-server",
      args: [],
      env: {},
      internalHost: url.hostname || allocation.host,
      internalPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  }

  async start(
    recipe: Recipe,
    _spec: LaunchSpec,
    signal: AbortSignal,
  ): Promise<OpenAICompatibleHandle> {
    if (signal.aborted) throw abortError();
    const config = readConfiguration(recipe);
    const apiKey = config.apiKeyEnv ? this.#environment[config.apiKeyEnv] : undefined;
    if (config.apiKeyEnv && !apiKey) throw new Error(`Missing API key environment variable: ${config.apiKeyEnv}`);
    return {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      startedAt: new Date(),
      healthPath: config.healthPath,
      client: new OpenAICompatibleClient({ fetch: this.#fetch, ...(apiKey ? { apiKey } : {}) }),
    };
  }

  async waitUntilReady(instance: OpenAICompatibleHandle, signal: AbortSignal): Promise<ReadyInfo> {
    if (!(await instance.client.healthy(instance.baseUrl, instance.healthPath, signal))) {
      throw new Error(`OpenAI-compatible endpoint is not ready: ${instance.baseUrl}`);
    }
    return { modelId: instance.modelId, baseUrl: instance.baseUrl };
  }

  streamChat(
    instance: OpenAICompatibleHandle,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    return instance.client.streamChat(instance.baseUrl, instance.modelId, request, signal);
  }

  async stop(_instance: OpenAICompatibleHandle, _mode: StopMode): Promise<StopReport> {
    return { stopped: true, detail: "External endpoint left running" };
  }

  async inspect(instance: OpenAICompatibleHandle): Promise<InstanceInspection> {
    try {
      return {
        healthy: await instance.client.healthy(instance.baseUrl, instance.healthPath),
        modelId: instance.modelId,
      };
    } catch (error) {
      return { healthy: false, modelId: instance.modelId, detail: errorMessage(error) };
    }
  }
}

export function readConfiguration(recipe: Recipe): OpenAICompatibleConfiguration {
  if (recipe.adapter !== "openai-compatible") throw new TypeError("Recipe adapter must be openai-compatible");
  const baseUrl = stringValue(recipe.configuration.baseUrl, "baseUrl");
  const apiKeyEnv = optionalString(recipe.configuration.apiKeyEnv, "apiKeyEnv");
  const healthPath = optionalString(recipe.configuration.healthPath, "healthPath") ?? (/\/v1\/?$/i.test(baseUrl) ? "/models" : "/v1/models");
  const allowInsecureRemote = recipe.configuration.allowInsecureRemote === true;
  return { baseUrl, healthPath, allowInsecureRemote, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
}

export function validateConfiguration(recipe: Recipe): ValidationIssue[] {
  try {
    const config = readConfiguration(recipe);
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return [{ level: "error", code: "invalid_protocol", message: "baseUrl must use http or https" }];
    }
    if (url.username || url.password) {
      return [{ level: "error", code: "embedded_credentials", message: "Credentials must not be embedded in baseUrl" }];
    }
    if (url.protocol === "http:" && !isLoopback(url.hostname) && !config.allowInsecureRemote) {
      return [{
        level: "error",
        code: "insecure_remote_endpoint",
        message: "Remote HTTP endpoints require allowInsecureRemote: true",
      }];
    }
    if (!config.healthPath.startsWith("/") || config.healthPath.startsWith("//")) {
      return [{ level: "error", code: "invalid_health_path", message: "healthPath must be an absolute path" }];
    }
    return [];
  } catch (error) {
    return [{ level: "error", code: "invalid_configuration", message: errorMessage(error) }];
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name);
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
