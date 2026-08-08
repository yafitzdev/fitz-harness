import { randomUUID } from "node:crypto";
import type { MediaGenerationRequest, MediaGenerationResult, MediaModality } from "@fitz/protocol";
import type { MediaJobHandle, MediaJobPoll } from "@fitz/inference-core";
import {
  openAIEndpoint,
  OpenAICompatibleClient,
  type OpenAICompatibleModel,
} from "@fitz/engine-openai-compatible";
import {
  type MediaProvider,
  type MediaProviderOptions,
  type ProviderConnection,
  type ProviderModel,
  isRecord,
  mimeTypeFor,
  providerHeaders,
  providerApiKey,
  readResponse,
  stringOr,
  stringValue,
} from "./provider.js";

const MODALITY_ORDER: MediaModality[] = ["image", "video", "audio"];

/** Generation-specific capability signals, checked against endpoints,
 *  capability keys, type/task strings, and bare model ids. Chat signals
 *  (e.g. "chat", "text-generation") never match, so chat-only models are
 *  skipped — the host's separate chat discovery path owns them (§5.7). */
const GENERATION_PATTERNS: Record<MediaModality, RegExp[]> = {
  image: [
    /(^|[-\s])image-(?:gen|generation)(?:[-\s]|$)/,
    /text[-_]?to[-_]?image/,
    /image[-_]?to[-_]?image/,
    /images?\/generations/,
  ],
  video: [
    /(^|[-\s])video-(?:gen|generation)(?:[-\s]|$)/,
    /text[-_]?to[-_]?video/,
    /image[-_]?to[-_]?video/,
    /videos?\/generations/,
  ],
  audio: [
    /(^|[-\s])audio-(?:gen|generation)(?:[-\s]|$)/,
    /text[-_]?to[-_]?audio/,
    /audios?\/generations/,
    /(^|[-\s])tts([-\s]|$)/,
  ],
};

/** Classify a `/v1/models` entry as a media generator. Explicit endpoint or
 *  capability signals win; bare catalogs fall back to well-known id families
 *  (DALL·E / Sora / TTS). Returns output modalities in canonical order. */
export function classifyMediaModel(model: OpenAICompatibleModel): MediaModality[] {
  const modalities = new Set<MediaModality>();
  for (const endpoint of model.endpoints ?? []) {
    for (const modality of matchModalities(endpoint)) modalities.add(modality);
  }
  if (modalities.size === 0 && isRecord(model.capabilities)) {
    for (const [key, value] of Object.entries(model.capabilities)) {
      if (value === true) {
        for (const modality of matchModalities(key)) modalities.add(modality);
      }
    }
  }
  if (modalities.size === 0) {
    for (const declared of [model.type, model.task]) {
      if (declared) {
        for (const modality of matchModalities(declared)) modalities.add(modality);
      }
    }
  }
  if (modalities.size === 0) {
    const id = model.id.trim().toLowerCase();
    if (/(^|[-_.:/])(dall[-_.]?e|gpt[-_.]?image)([-_.:/]|$)/.test(id)) modalities.add("image");
    if (/(^|[-_.:/])sora([-_.:/]|$)/.test(id)) modalities.add("video");
    if (/(^|[-_.:/])(whisper|tts)([-_.:/]|$)/.test(id)) modalities.add("audio");
  }
  return MODALITY_ORDER.filter((modality) => modalities.has(modality));
}

function matchModalities(value: string): MediaModality[] {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return MODALITY_ORDER.filter((modality) =>
    GENERATION_PATTERNS[modality].some((pattern) => pattern.test(normalized)),
  );
}

/** Generic OpenAI-compatible media template (§5.7): same bearer transport and
 *  URL building as the chat adapter, hitting `/v1/{modality}s/generations`.
 *  Images (and audio) are synchronous — the result is stashed and the first
 *  poll returns it completed. Videos may be sync or async
 *  (`{ id, status }` → `GET /v1/videos/generations/{id}`, `DELETE` to cancel)
 *  and the template handles both shapes. */
export class OpenAICompatibleMediaProvider implements MediaProvider {
  readonly id = "openai-media";
  readonly #fetch: typeof globalThis.fetch;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  /** Synchronous results awaiting their first (only) poll. */
  readonly #pending = new Map<string, MediaGenerationResult>();

  constructor(options: MediaProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#environment = options.environment ?? process.env;
  }

  async discover(connection: ProviderConnection, signal?: AbortSignal): Promise<ProviderModel[]> {
    const apiKey = providerApiKey(connection, this.#environment);
    const client = new OpenAICompatibleClient({
      fetch: this.#fetch,
      ...(apiKey ? { apiKey } : {}),
    });
    const models = await client.listModels(connection.baseUrl, signal);
    const discovered: ProviderModel[] = [];
    for (const model of models) {
      const modalities = classifyMediaModel(model);
      if (modalities.length === 0) continue;
      if (connection.modelIds?.length && !connection.modelIds.includes(model.id)) continue;
      discovered.push({ modelId: model.id, modalities });
    }
    return discovered;
  }

  async submit(
    connection: ProviderConnection,
    request: MediaGenerationRequest,
    signal?: AbortSignal,
  ): Promise<MediaJobHandle> {
    const modelId = connection.modelIds?.[0];
    if (!modelId) throw new Error(`No model configured for provider connection ${connection.id}`);
    const response = await this.#fetch(openAIEndpoint(connection.baseUrl, `${request.modality}s/generations`), {
      method: "POST",
      headers: { ...providerHeaders(connection, this.#environment, "Bearer"), "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        prompt: request.params.prompt,
        ...(request.params.size ? { size: request.params.size } : {}),
        ...(request.params.durationSeconds !== undefined ? { duration: request.params.durationSeconds } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    const payload = await readResponse(response, `${request.modality} generation`);
    const body = isRecord(payload) ? payload : {};
    if (Array.isArray(body.data) && body.data.length > 0) {
      // Synchronous result (images, most audio): stash it for the first poll.
      const result = mediaResultFromData(body.data, request.modality);
      const id = randomUUID();
      this.#pending.set(id, result);
      return { id, modality: request.modality };
    }
    // Async job envelope: `{ id, status }` → poll GET /v1/{modality}s/generations/{id}.
    const jobId = stringValue(body.id, `${request.modality} job id`);
    return { id: jobId, modality: request.modality };
  }

  async poll(
    connection: ProviderConnection,
    job: MediaJobHandle,
    signal?: AbortSignal,
  ): Promise<MediaJobPoll> {
    const pending = this.#pending.get(job.id);
    if (pending) {
      this.#pending.delete(job.id);
      return { status: "completed", progress: 1, result: pending };
    }
    const response = await this.#fetch(
      openAIEndpoint(connection.baseUrl, `${job.modality}s/generations/${encodeURIComponent(job.id)}`),
      {
        headers: providerHeaders(connection, this.#environment, "Bearer"),
        ...(signal ? { signal } : {}),
      },
    );
    const payload = await readResponse(response, `${job.modality} generation status`);
    const body = isRecord(payload) ? payload : {};
    const status = normalizeJobStatus(body.status);
    if (status === "completed") {
      const data = Array.isArray(body.data) && body.data.length > 0 ? body.data : body.output;
      return { status: "completed", progress: 1, result: mediaResultFromData(data, job.modality) };
    }
    if (status === "failed") return { status: "failed", error: stringOr(body.error, `${job.modality} generation failed`) };
    if (status === "cancelled") return { status: "cancelled" };
    return { status, ...(typeof body.progress === "number" ? { progress: body.progress } : {}) };
  }

  async cancel(
    connection: ProviderConnection,
    job: MediaJobHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#pending.delete(job.id);
    if (job.modality === "video") {
      const response = await this.#fetch(
        openAIEndpoint(connection.baseUrl, `videos/generations/${encodeURIComponent(job.id)}`),
        {
          method: "DELETE",
          headers: providerHeaders(connection, this.#environment, "Bearer"),
          ...(signal ? { signal } : {}),
        },
      );
      await readResponse(response, "Video generation cancel");
    }
  }
}

function normalizeJobStatus(status: unknown): MediaJobPoll["status"] {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "queued":
      return "queued";
    case "processing":
    case "in_progress":
    case "progressing":
      return "progressing";
    case "completed":
    case "succeeded":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "progressing";
  }
}

function mediaResultFromData(data: unknown, modality: MediaModality): MediaGenerationResult {
  const first = Array.isArray(data) ? data.find(isRecord) : undefined;
  if (!first) throw new Error(`${modality} generation returned no data`);
  if (typeof first.b64_json === "string" && first.b64_json) {
    const bytes = new Uint8Array(Buffer.from(first.b64_json, "base64"));
    return { data: bytes, mimeType: mimeTypeFor(modality), byteSize: bytes.byteLength };
  }
  if (typeof first.url === "string" && first.url) {
    return { data: { url: first.url }, mimeType: mimeTypeFor(modality), byteSize: 0 };
  }
  throw new Error(`${modality} generation result had neither b64_json nor url`);
}
