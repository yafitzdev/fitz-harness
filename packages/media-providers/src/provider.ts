import type { MediaGenerationRequest, MediaModality, ModalityCapabilities } from "@fitz/protocol";
import type { MediaJobHandle, MediaJobPoll } from "@fitz/inference-core";

export interface ProviderModel {
  modelId: string;
  /** Output modalities this model can generate. */
  modalities: MediaModality[];
  limits?: ModalityCapabilities["limits"];
}

/** Curated-catalog entry (fal/replicate): models are not self-describing via a
 *  models endpoint, so the template ships a pinned list with modality metadata. */
export interface ProviderCatalogEntry {
  modelId: string;
  modalities: MediaModality[];
  limits?: ModalityCapabilities["limits"];
}

export interface ProviderConnection {
  id: string;
  baseUrl: string;
  apiKeyEnv?: string;
  /** Curated-template filter and submit target: the first entry is the model a
   *  per-recipe handle submits to (the recipe pins one model per connection). */
  modelIds?: string[];
}

/** A provider template (design doc §5.7): the divergence between cloud media
 *  APIs (auth schemes, job shapes, result envelopes) lives here, so the host's
 *  media pipeline only ever sees Fitz DTOs. */
export interface MediaProvider {
  readonly id: string; // "openai-media" | "fal" | "replicate"
  /** Model discovery: probe endpoints (openai-media) or curated catalog (fal/replicate). */
  discover(connection: ProviderConnection, signal?: AbortSignal): Promise<ProviderModel[]>;
  submit(
    connection: ProviderConnection,
    request: MediaGenerationRequest,
    signal?: AbortSignal,
  ): Promise<MediaJobHandle>;
  poll(connection: ProviderConnection, job: MediaJobHandle, signal?: AbortSignal): Promise<MediaJobPoll>;
  cancel(connection: ProviderConnection, job: MediaJobHandle, signal?: AbortSignal): Promise<void>;
}

export class MediaProviderRegistry {
  readonly #providers = new Map<string, MediaProvider>();

  constructor(providers: MediaProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: MediaProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Media provider already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
  }

  get(id: string): MediaProvider {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown media provider: ${id}`);
    return provider;
  }

  list(): MediaProvider[] {
    return [...this.#providers.values()];
  }
}

export interface MediaProviderOptions {
  fetch?: typeof globalThis.fetch;
  environment?: Readonly<Record<string, string | undefined>>;
}

/** Resolve the credential the host stashed in the env var named by the
 *  connection (mirrors `OpenAICompatibleEngineAdapter.start`). */
export function providerApiKey(
  connection: ProviderConnection,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return connection.apiKeyEnv ? environment[connection.apiKeyEnv] : undefined;
}

export function providerHeaders(
  connection: ProviderConnection,
  environment: Readonly<Record<string, string | undefined>>,
  scheme: "Bearer" | "Key",
): Record<string, string> {
  const key = providerApiKey(connection, environment);
  return key ? { authorization: `${scheme} ${key}` } : {};
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\//, "")}`;
}

/** Parse a JSON response; throw a readable error on non-2xx (bodies are small
 *  envelopes — media bytes are fetched host-side from result URLs, §5.11). */
export async function readResponse(response: Response, context: string): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`${context} failed (HTTP ${response.status}): ${text.slice(0, 500)}`);
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export function mimeTypeFor(modality: MediaModality): string {
  return modality === "image" ? "image/png" : modality === "video" ? "video/mp4" : "audio/mpeg";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
