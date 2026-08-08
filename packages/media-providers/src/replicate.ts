import type { MediaGenerationRequest, MediaGenerationResult, MediaModality } from "@fitz/protocol";
import type { MediaJobHandle, MediaJobPoll } from "@fitz/inference-core";
import {
  type MediaProvider,
  type MediaProviderOptions,
  type ProviderCatalogEntry,
  type ProviderConnection,
  type ProviderModel,
  isRecord,
  joinUrl,
  mimeTypeFor,
  providerHeaders,
  readResponse,
  stringOr,
  stringValue,
} from "./provider.js";

/** Curated Replicate catalog: `POST https://api.replicate.com/v1/predictions`
 *  with `{ model, input }`; poll `GET /v1/predictions/{id}` until `succeeded`
 *  with `output` URL(s). Hosts H3 (video) → the 2K cloud path. */
export const REPLICATE_CATALOG: ProviderCatalogEntry[] = [
  { modelId: "minimax/video-01", modalities: ["video"], limits: { maxDurationSeconds: 6, maxResolution: "1280x720" } },
  { modelId: "black-forest-labs/flux-dev", modalities: ["image"], limits: { maxResolution: "1440x1440" } },
  { modelId: "stability-ai/sdxl", modalities: ["image"], limits: { maxResolution: "1280x1280" } },
  { modelId: "bytedance/sdxl-lightning-4step", modalities: ["image"] },
  { modelId: "lucataco/ssd-1b", modalities: ["image"] },
  { modelId: "meta/musicgen", modalities: ["audio"], limits: { maxDurationSeconds: 30 } },
];

export const REPLICATE_DEFAULT_BASE_URL = "https://api.replicate.com";

export class ReplicateProvider implements MediaProvider {
  readonly id = "replicate";
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options: MediaProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#environment = options.environment ?? process.env;
  }

  async discover(connection: ProviderConnection, _signal?: AbortSignal): Promise<ProviderModel[]> {
    const entries = REPLICATE_CATALOG.filter(
      (entry) => !connection.modelIds?.length || connection.modelIds.includes(entry.modelId),
    );
    return entries.map((entry) => ({
      modelId: entry.modelId,
      modalities: entry.modalities,
      ...(entry.limits ? { limits: entry.limits } : {}),
    }));
  }

  async submit(
    connection: ProviderConnection,
    request: MediaGenerationRequest,
    signal?: AbortSignal,
  ): Promise<MediaJobHandle> {
    const modelId = connection.modelIds?.[0];
    if (!modelId) throw new Error(`No model configured for provider connection ${connection.id}`);
    const response = await this.#fetch(joinUrl(connection.baseUrl, "v1/predictions"), {
      method: "POST",
      headers: { ...providerHeaders(connection, this.#environment, "Bearer"), "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, input: replicateInputFor(request) }),
      ...(signal ? { signal } : {}),
    });
    const payload = await readResponse(response, "replicate prediction");
    const body = isRecord(payload) ? payload : {};
    const id = stringValue(body.id, "prediction id");
    return { id, modality: request.modality };
  }

  async poll(
    connection: ProviderConnection,
    job: MediaJobHandle,
    signal?: AbortSignal,
  ): Promise<MediaJobPoll> {
    const response = await this.#fetch(joinUrl(connection.baseUrl, `v1/predictions/${encodeURIComponent(job.id)}`), {
      headers: providerHeaders(connection, this.#environment, "Bearer"),
      ...(signal ? { signal } : {}),
    });
    const payload = await readResponse(response, "replicate prediction status");
    const body = isRecord(payload) ? payload : {};
    const status = replicateStatus(body.status);
    if (status === "completed") {
      return { status: "completed", progress: 1, result: replicateResultFor(job.modality, body.output) };
    }
    if (status === "failed") {
      return { status: "failed", error: stringOr(body.error, "replicate generation failed") };
    }
    if (status === "cancelled") return { status: "cancelled" };
    return { status };
  }

  async cancel(
    connection: ProviderConnection,
    job: MediaJobHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetch(
      joinUrl(connection.baseUrl, `v1/predictions/${encodeURIComponent(job.id)}/cancel`),
      {
        method: "POST",
        headers: providerHeaders(connection, this.#environment, "Bearer"),
        ...(signal ? { signal } : {}),
      },
    );
    await readResponse(response, "replicate prediction cancel");
  }
}

function replicateStatus(status: unknown): MediaJobPoll["status"] {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "starting":
    case "queued":
      return "queued";
    case "processing":
      return "progressing";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "progressing";
  }
}

/** Replicate `output` is a URL string or a URL array depending on the model. */
function replicateResultFor(modality: MediaModality, output: unknown): MediaGenerationResult {
  const url =
    typeof output === "string" && output
      ? output
      : Array.isArray(output)
        ? output.find((item): item is string => typeof item === "string" && item.length > 0)
        : undefined;
  if (!url) throw new Error("replicate result had no output URL");
  return { data: { url }, mimeType: mimeTypeFor(modality), byteSize: 0 };
}

function replicateInputFor(request: MediaGenerationRequest): Record<string, unknown> {
  return {
    prompt: request.params.prompt,
    ...(request.params.negativePrompt ? { negative_prompt: request.params.negativePrompt } : {}),
    ...(request.params.size ? { size: request.params.size } : {}),
    ...(request.params.durationSeconds !== undefined ? { duration: request.params.durationSeconds } : {}),
  };
}
