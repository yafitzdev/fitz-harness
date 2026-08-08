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

/** Curated fal catalog: `POST https://queue.fal.run/<modelId>` with
 *  `Authorization: Key <key>`; results arrive as `output.{video|images|audio}`
 *  URLs in `GET .../requests/{id}`. Hosts H3 (video) → the 2K cloud path. */
export const FAL_CATALOG: ProviderCatalogEntry[] = [
  { modelId: "fal-ai/minimax-video", modalities: ["video"], limits: { maxDurationSeconds: 6, maxResolution: "1280x720" } },
  { modelId: "fal-ai/runway-gen3/turbo/image-to-video", modalities: ["video"], limits: { maxDurationSeconds: 10 } },
  { modelId: "fal-ai/flux/dev", modalities: ["image"], limits: { maxResolution: "1440x1440" } },
  { modelId: "fal-ai/flux/schnell", modalities: ["image"], limits: { maxResolution: "1440x1440" } },
  { modelId: "fal-ai/stable-diffusion-v35-large", modalities: ["image"], limits: { maxResolution: "1280x1280" } },
  { modelId: "fal-ai/minimax-audio", modalities: ["audio"], limits: { maxDurationSeconds: 60 } },
];

export const FAL_DEFAULT_BASE_URL = "https://queue.fal.run";

export class FalProvider implements MediaProvider {
  readonly id = "fal";
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options: MediaProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#environment = options.environment ?? process.env;
  }

  async discover(connection: ProviderConnection, _signal?: AbortSignal): Promise<ProviderModel[]> {
    const entries = FAL_CATALOG.filter(
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
    const response = await this.#fetch(joinUrl(connection.baseUrl, modelId), {
      method: "POST",
      headers: { ...providerHeaders(connection, this.#environment, "Key"), "content-type": "application/json" },
      body: JSON.stringify(falInputFor(request)),
      ...(signal ? { signal } : {}),
    });
    const payload = await readResponse(response, "fal generation submit");
    const body = isRecord(payload) ? payload : {};
    const requestId = stringValue(body.request_id, "request_id");
    return { id: requestId, modality: request.modality };
  }

  async poll(
    connection: ProviderConnection,
    job: MediaJobHandle,
    signal?: AbortSignal,
  ): Promise<MediaJobPoll> {
    const response = await this.#fetch(joinUrl(connection.baseUrl, `requests/${encodeURIComponent(job.id)}`), {
      headers: providerHeaders(connection, this.#environment, "Key"),
      ...(signal ? { signal } : {}),
    });
    const payload = await readResponse(response, "fal generation status");
    const body = isRecord(payload) ? payload : {};
    const status = falStatus(body.status);
    if (status === "completed") {
      const output = isRecord(body.output) ? body.output : {};
      return { status: "completed", progress: 1, result: falResultFor(job.modality, output) };
    }
    if (status === "failed") return { status: "failed", error: stringOr(body.error, "fal generation failed") };
    if (status === "cancelled") return { status: "cancelled" };
    return { status };
  }

  async cancel(
    connection: ProviderConnection,
    job: MediaJobHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetch(
      joinUrl(connection.baseUrl, `requests/${encodeURIComponent(job.id)}/cancel`),
      {
        method: "POST",
        headers: providerHeaders(connection, this.#environment, "Key"),
        ...(signal ? { signal } : {}),
      },
    );
    await readResponse(response, "fal generation cancel");
  }
}

function falStatus(status: unknown): MediaJobPoll["status"] {
  switch (String(status ?? "").trim().toUpperCase()) {
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
      return "progressing";
    case "COMPLETED":
    case "SUCCEEDED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    default:
      return "progressing";
  }
}

function falResultFor(modality: MediaModality, output: Record<string, unknown>): MediaGenerationResult {
  if (modality === "image") {
    const images = Array.isArray(output.images) ? output.images.filter(isRecord) : [];
    const url = stringOr(images[0]?.url, "");
    if (!url) throw new Error("fal image result had no output.images[0].url");
    return { data: { url }, mimeType: mimeTypeFor(modality), byteSize: 0 };
  }
  if (modality === "video") {
    const video = isRecord(output.video) ? output.video : {};
    const url = stringOr(video.url, "");
    if (!url) throw new Error("fal video result had no output.video.url");
    return { data: { url }, mimeType: mimeTypeFor(modality), byteSize: 0 };
  }
  const audio = isRecord(output.audio) ? output.audio : {};
  const url = stringOr(audio.url, "");
  if (!url) throw new Error("fal audio result had no output.audio.url");
  return { data: { url }, mimeType: mimeTypeFor(modality), byteSize: 0 };
}

function falInputFor(request: MediaGenerationRequest): Record<string, unknown> {
  return {
    prompt: request.params.prompt,
    ...(request.params.negativePrompt ? { negative_prompt: request.params.negativePrompt } : {}),
    ...(request.params.size ? { image_size: request.params.size } : {}),
    ...(request.params.durationSeconds !== undefined ? { duration: request.params.durationSeconds } : {}),
    ...(request.params.seed !== undefined ? { seed: request.params.seed } : {}),
  };
}
