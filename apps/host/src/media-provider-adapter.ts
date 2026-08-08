import { randomUUID } from "node:crypto";
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
  MediaGenerationRequest,
  MediaModality,
  Recipe,
  ResourceEstimate,
  ValidationIssue,
  ValidationReport,
} from "@fitz/protocol";
import {
  type MediaProvider,
  type ProviderConnection,
  joinUrl,
} from "@fitz/media-providers";

export interface MediaProviderConfiguration {
  baseUrl: string;
  modelId: string;
  healthPath: string;
  apiKeyEnv?: string;
}

export interface MediaProviderHandle extends EngineInstanceHandle {
  modelId: string;
  healthPath: string;
  connection: ProviderConnection;
}

export interface MediaProviderEngineAdapterOptions {
  fetch?: typeof globalThis.fetch;
  environment?: Readonly<Record<string, string | undefined>>;
}

/** Thin `MediaEngineAdapter` over a `MediaProvider` template (design doc §5.7):
 *  `start()` resolves the credential env (mirroring
 *  `OpenAICompatibleEngineAdapter.start`, which throws `Missing API key
 *  environment variable` when set but empty) and returns a handle carrying the
 *  per-recipe `ProviderConnection`; `waitUntilReady()` is a reachability probe
 *  (any HTTP status counts — only network errors mean "not ready"); and
 *  submit/poll/cancel delegate to the provider. The recipe's `adapter` id is
 *  the template id, so media recipes resolve in the same registry as local
 *  media engines — one code path in the scheduler/lifecycle. */
export class MediaProviderEngineAdapter implements MediaEngineAdapter<MediaProviderHandle> {
  readonly id: string;
  readonly modalities: MediaModality[] = ["image", "video", "audio"];
  readonly defaultPollIntervalMs = 2_000;
  readonly #provider: MediaProvider;
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(provider: MediaProvider, options: MediaProviderEngineAdapterOptions = {}) {
    this.id = provider.id;
    this.#provider = provider;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#environment = options.environment ?? process.env;
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    if (recipe.adapter !== this.id) {
      issues.push({
        level: "error",
        code: "adapter_mismatch",
        message: `Recipe adapter must be ${this.id}`,
      });
    }
    try {
      readMediaProviderConfiguration(recipe);
    } catch (error) {
      issues.push({ level: "error", code: "invalid_configuration", message: errorMessage(error) });
    }
    return { valid: issues.every((issue) => issue.level !== "error"), issues };
  }

  async estimateResources(_recipe: Recipe): Promise<ResourceEstimate> {
    return {};
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    const config = readMediaProviderConfiguration(recipe);
    const url = new URL(config.baseUrl);
    return {
      executable: `external-${this.id}-provider`,
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
  ): Promise<MediaProviderHandle> {
    if (signal.aborted) throw abortError();
    const config = readMediaProviderConfiguration(recipe);
    const apiKey = config.apiKeyEnv ? this.#environment[config.apiKeyEnv] : undefined;
    if (config.apiKeyEnv && !apiKey) {
      throw new Error(`Missing API key environment variable: ${config.apiKeyEnv}`);
    }
    return {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: config.baseUrl,
      startedAt: new Date(),
      healthPath: config.healthPath,
      connection: {
        id: recipe.id,
        baseUrl: config.baseUrl,
        modelIds: [config.modelId],
        ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
      },
    };
  }

  async waitUntilReady(instance: MediaProviderHandle, signal: AbortSignal): Promise<ReadyInfo> {
    await this.#fetch(joinUrl(instance.baseUrl, instance.healthPath), {
      ...(signal ? { signal } : {}),
    });
    return { modelId: instance.modelId, baseUrl: instance.baseUrl };
  }

  async submit(
    instance: MediaProviderHandle,
    request: MediaGenerationRequest,
    signal: AbortSignal,
  ): Promise<MediaJobHandle> {
    return this.#provider.submit(instance.connection, request, signal);
  }

  async poll(
    instance: MediaProviderHandle,
    job: MediaJobHandle,
    signal: AbortSignal,
  ): Promise<MediaJobPoll> {
    return this.#provider.poll(instance.connection, job, signal);
  }

  async cancel(instance: MediaProviderHandle, job: MediaJobHandle): Promise<void> {
    await this.#provider.cancel(instance.connection, job);
  }

  async stop(_instance: MediaProviderHandle, _mode: StopMode): Promise<StopReport> {
    return { stopped: true, detail: "External endpoint left running" };
  }

  async inspect(instance: MediaProviderHandle): Promise<InstanceInspection> {
    try {
      await this.#fetch(joinUrl(instance.baseUrl, instance.healthPath));
      return { healthy: true, modelId: instance.modelId };
    } catch (error) {
      return { healthy: false, modelId: instance.modelId, detail: errorMessage(error) };
    }
  }
}

export function readMediaProviderConfiguration(recipe: Recipe): MediaProviderConfiguration {
  const baseUrl = stringValue(recipe.configuration.baseUrl, "baseUrl");
  const modelId = stringValue(recipe.configuration.modelId, "modelId");
  const apiKeyEnv = optionalString(recipe.configuration.apiKeyEnv, "apiKeyEnv");
  const healthPath = optionalString(recipe.configuration.healthPath, "healthPath") ?? "/health";
  return { baseUrl, modelId, healthPath, ...(apiKeyEnv ? { apiKeyEnv } : {}) };
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
