import { describe, expect, it } from "vitest";
import type { MediaProvider } from "./provider.js";
import {
  MediaProviderRegistry,
  joinUrl,
  mimeTypeFor,
  providerApiKey,
  providerHeaders,
  readResponse,
} from "./provider.js";
import { classifyMediaModel, OpenAICompatibleMediaProvider } from "./openai-media.js";
import { FAL_CATALOG, FalProvider } from "./fal.js";
import { REPLICATE_CATALOG, ReplicateProvider } from "./replicate.js";

describe("MediaProviderRegistry", () => {
  it("registers, lists, and resolves providers by id", () => {
    const registry = new MediaProviderRegistry();
    const provider: MediaProvider = {
      id: "probe",
      discover: async () => [],
      submit: async () => ({ id: "j-1", modality: "image" }),
      poll: async () => ({ status: "queued" }),
      cancel: async () => undefined,
    };
    registry.register(provider);
    expect(registry.get("probe")).toBe(provider);
    expect(registry.list()).toEqual([provider]);
    expect(() => registry.register(provider)).toThrow(/already registered/);
    expect(() => registry.get("missing")).toThrow(/Unknown media provider/);
  });

  it("seeds from a constructor list", () => {
    const registry = new MediaProviderRegistry([{ id: "a" } as MediaProvider]);
    expect(registry.get("a")).toBeDefined();
  });
});

describe("classifyMediaModel", () => {
  it("recognizes generation models by declared type/task", () => {
    expect(classifyMediaModel({ id: "dall-e-3", type: "image-generation" })).toEqual(["image"]);
    expect(classifyMediaModel({ id: "sora-video", task: "video-generation" })).toEqual(["video"]);
    expect(classifyMediaModel({ id: "tts-1", type: "audio-generation" })).toEqual(["audio"]);
  });

  it("recognizes generation models by endpoints and capability keys", () => {
    expect(classifyMediaModel({ id: "custom-gen", endpoints: ["images/generations"] })).toEqual(["image"]);
    expect(classifyMediaModel({ id: "custom", endpoints: ["video/generations"] })).toEqual(["video"]);
    expect(classifyMediaModel({ id: "custom", capabilities: { image_generation: true } })).toEqual(["image"]);
    expect(classifyMediaModel({ id: "custom", task: "text-to-video" })).toEqual(["video"]);
  });

  it("falls back to well-known bare id families (DALL·E / Sora / TTS)", () => {
    expect(classifyMediaModel({ id: "gpt-image-1" })).toEqual(["image"]);
    expect(classifyMediaModel({ id: "sora-2" })).toEqual(["video"]);
    expect(classifyMediaModel({ id: "whisper-1" })).toEqual(["audio"]);
    expect(classifyMediaModel({ id: "tts-1-hd" })).toEqual(["audio"]);
  });

  it("skips chat-only models and canonicalizes modality order", () => {
    expect(classifyMediaModel({ id: "gpt-4o-mini", endpoints: ["chat"] })).toEqual([]);
    expect(classifyMediaModel({ id: "deepseek-v4-pro" })).toEqual([]);
    expect(classifyMediaModel({ id: "multi", type: "image-generation", task: "text-to-video" })).toEqual(["image", "video"]);
  });
});

describe("provider helpers", () => {
  it("resolves credentials and auth headers per scheme", () => {
    expect(providerApiKey({ id: "c", baseUrl: "http://x", apiKeyEnv: "KEY" }, { KEY: "v" })).toBe("v");
    expect(providerApiKey({ id: "c", baseUrl: "http://x" }, { KEY: "v" })).toBeUndefined();
    expect(providerHeaders({ id: "c", baseUrl: "http://x", apiKeyEnv: "KEY" }, { KEY: "v" }, "Key")).toEqual({ authorization: "Key v" });
    expect(providerHeaders({ id: "c", baseUrl: "http://x", apiKeyEnv: "KEY" }, { KEY: "v" }, "Bearer")).toEqual({ authorization: "Bearer v" });
    expect(providerHeaders({ id: "c", baseUrl: "http://x" }, {}, "Bearer")).toEqual({});
  });

  it("joins URLs and maps mime types", () => {
    expect(joinUrl("https://a.com/", "/v1/predictions")).toBe("https://a.com/v1/predictions");
    expect(joinUrl("https://a.com", "fal-ai/minimax-video")).toBe("https://a.com/fal-ai/minimax-video");
    expect(mimeTypeFor("image")).toBe("image/png");
    expect(mimeTypeFor("video")).toBe("video/mp4");
    expect(mimeTypeFor("audio")).toBe("audio/mpeg");
  });

  it("throws a readable error on non-2xx responses", async () => {
    await expect(readResponse(new Response("nope", { status: 401 }), "probe")).rejects.toThrow(/probe failed \(HTTP 401\)/);
  });
});

/** Route a fetch mock by URL path; returns the recorded calls for assertions. */
function routeFetch(routes: Record<string, (init?: RequestInit) => Response>): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = String(url);
    calls.push({ url: text, init });
    const path = new URL(text).pathname;
    const handler = routes[path];
    if (!handler) return new Response(JSON.stringify({ error: { message: `no route for ${path}` } }), { status: 404 });
    return handler(init);
  };
  return { fetch: fetchMock as typeof fetch, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("OpenAICompatibleMediaProvider", () => {
  const connection = { id: "c-1", baseUrl: "https://api.test", modelIds: ["dall-e-3"] };
  const request = { id: "req-1", routeId: "image", modality: "image", params: { prompt: "a cat" } };

  it("discovers media models and skips chat-only entries", async () => {
    const { fetch } = routeFetch({
      "/v1/models": () => jsonResponse({ data: [
        { id: "gpt-4o-mini", endpoints: ["chat"] },
        { id: "dall-e-3", type: "image-generation" },
        { id: "sora-video", task: "video-generation" },
        { id: "tts-1", type: "audio-generation" },
      ] }),
    });
    const provider = new OpenAICompatibleMediaProvider({ fetch });
    await expect(provider.discover({ id: "c-1", baseUrl: "https://api.test" })).resolves.toEqual([
      { modelId: "dall-e-3", modalities: ["image"] },
      { modelId: "sora-video", modalities: ["video"] },
      { modelId: "tts-1", modalities: ["audio"] },
    ]);
    await expect(
      provider.discover({ id: "c-1", baseUrl: "https://api.test", modelIds: ["sora-video"] }),
    ).resolves.toEqual([{ modelId: "sora-video", modalities: ["video"] }]);
  });

  it("stashes synchronous URL results for the first poll", async () => {
    const { fetch, calls } = routeFetch({
      "/v1/images/generations": () => jsonResponse({ created: 1, data: [{ url: "https://cdn.test/img.png" }] }),
    });
    const provider = new OpenAICompatibleMediaProvider({ fetch });
    const handle = await provider.submit(connection, request);
    expect(handle).toMatchObject({ modality: "image" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: "dall-e-3", prompt: "a cat" });

    const first = await provider.poll(connection, handle);
    expect(first).toEqual({
      status: "completed",
      progress: 1,
      result: { data: { url: "https://cdn.test/img.png" }, mimeType: "image/png", byteSize: 0 },
    });
    // Synchronous results are single-use: a second poll would hit the provider.
    await expect(provider.poll(connection, handle)).rejects.toThrow();
  });

  it("decodes b64_json inline results", async () => {
    const b64 = Buffer.from("abc").toString("base64");
    const { fetch } = routeFetch({
      "/v1/images/generations": () => jsonResponse({ created: 1, data: [{ b64_json: b64 }] }),
    });
    const provider = new OpenAICompatibleMediaProvider({ fetch });
    const handle = await provider.submit(connection, request);
    const poll = await provider.poll(connection, handle);
    expect(poll).toEqual({
      status: "completed",
      progress: 1,
      result: { data: new Uint8Array(Buffer.from("abc")), mimeType: "image/png", byteSize: 3 },
    });
  });

  it("polls async video jobs through queued → progressing → completed", async () => {
    let polls = 0;
    const { fetch, calls } = routeFetch({
      "/v1/videos/generations": () => jsonResponse({ id: "vid-1", status: "queued" }),
      "/v1/videos/generations/vid-1": () => {
        polls += 1;
        if (polls === 1) return jsonResponse({ id: "vid-1", status: "queued" });
        if (polls === 2) return jsonResponse({ id: "vid-1", status: "processing" });
        return jsonResponse({ id: "vid-1", status: "completed", data: [{ url: "https://cdn.test/v.mp4" }] });
      },
      "/v1/videos/generations/vid-1/DELETE": () => jsonResponse({ id: "vid-1", status: "cancelled" }),
    });
    const provider = new OpenAICompatibleMediaProvider({ fetch });
    const videoConnection = { id: "c-2", baseUrl: "https://api.test", modelIds: ["sora-video"] };
    const videoRequest = { id: "req-2", routeId: "video", modality: "video", params: { prompt: "a boat" } };

    const handle = await provider.submit(videoConnection, videoRequest);
    expect(handle).toEqual({ id: "vid-1", modality: "video" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: "sora-video", prompt: "a boat" });

    await expect(provider.poll(videoConnection, handle)).resolves.toEqual({ status: "queued" });
    await expect(provider.poll(videoConnection, handle)).resolves.toEqual({ status: "progressing" });
    await expect(provider.poll(videoConnection, handle)).resolves.toEqual({
      status: "completed",
      progress: 1,
      result: { data: { url: "https://cdn.test/v.mp4" }, mimeType: "video/mp4", byteSize: 0 },
    });
  });

  it("cancels async video jobs with a DELETE", async () => {
    const { fetch, calls } = routeFetch({
      "/v1/videos/generations": () => jsonResponse({ id: "vid-9", status: "queued" }),
      "/v1/videos/generations/vid-9": () => jsonResponse({ id: "vid-9", status: "cancelled" }),
    });
    const provider = new OpenAICompatibleMediaProvider({ fetch });
    const videoConnection = { id: "c-3", baseUrl: "https://api.test", modelIds: ["sora-video"] };
    const handle = await provider.submit(videoConnection, { id: "req-3", routeId: "video", modality: "video", params: { prompt: "x" } });
    await expect(provider.cancel(videoConnection, handle)).resolves.toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: "https://api.test/v1/videos/generations/vid-9", init: { method: "DELETE" } });
  });
});

describe("FalProvider", () => {
  const connection = { id: "c-1", baseUrl: "https://queue.test", modelIds: ["fal-ai/minimax-video"] };
  const request = { id: "req-1", routeId: "video", modality: "video", params: { prompt: "a cat" } };

  it("discovers the curated catalog with optional modelIds filtering", async () => {
    const provider = new FalProvider();
    await expect(provider.discover({ id: "c", baseUrl: "https://queue.test" })).resolves.toHaveLength(FAL_CATALOG.length);
    await expect(provider.discover({ id: "c", baseUrl: "https://queue.test", modelIds: ["fal-ai/flux/dev"] })).resolves.toEqual([
      { modelId: "fal-ai/flux/dev", modalities: ["image"], limits: { maxResolution: "1440x1440" } },
    ]);
  });

  it("submits with Key auth and polls the request status machine", async () => {
    let polls = 0;
    const { fetch, calls } = routeFetch({
      "/fal-ai/minimax-video": () => jsonResponse({ request_id: "r-1", status: "IN_QUEUE" }),
      "/requests/r-1": () => {
        polls += 1;
        if (polls === 1) return jsonResponse({ request_id: "r-1", status: "IN_PROGRESS" });
        return jsonResponse({ request_id: "r-1", status: "COMPLETED", output: { video: { url: "https://cdn.test/v.mp4" } } });
      },
      "/requests/r-1/cancel": () => jsonResponse({ request_id: "r-1", status: "CANCELLED" }),
    });
    const provider = new FalProvider({ fetch, environment: { FAL_KEY: "secret" } });
    const keyed = { ...connection, apiKeyEnv: "FAL_KEY" };

    const handle = await provider.submit(keyed, request);
    expect(handle).toEqual({ id: "r-1", modality: "video" });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Key secret" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prompt: "a cat" });

    await expect(provider.poll(keyed, handle)).resolves.toEqual({ status: "progressing" });
    await expect(provider.poll(keyed, handle)).resolves.toEqual({
      status: "completed",
      progress: 1,
      result: { data: { url: "https://cdn.test/v.mp4" }, mimeType: "video/mp4", byteSize: 0 },
    });

    await expect(provider.cancel(keyed, handle)).resolves.toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: "https://queue.test/requests/r-1/cancel", init: { method: "POST" } });
  });

  it("maps image and audio outputs to their envelope shapes", async () => {
    const { fetch } = routeFetch({
      "/fal-ai/flux/dev": () => jsonResponse({ request_id: "r-img", status: "IN_QUEUE" }),
      "/requests/r-img": () => jsonResponse({ request_id: "r-img", status: "COMPLETED", output: { images: [{ url: "https://cdn.test/i.png" }] } }),
      "/fal-ai/minimax-audio": () => jsonResponse({ request_id: "r-aud", status: "IN_QUEUE" }),
      "/requests/r-aud": () => jsonResponse({ request_id: "r-aud", status: "COMPLETED", output: { audio: { url: "https://cdn.test/a.mp3" } } }),
    });
    const provider = new FalProvider({ fetch });
    const image = await provider.submit({ ...connection, modelIds: ["fal-ai/flux/dev"] }, { id: "r2", routeId: "image", modality: "image", params: { prompt: "x" } });
    await expect(provider.poll({ ...connection, modelIds: ["fal-ai/flux/dev"] }, image)).resolves.toMatchObject({
      result: { data: { url: "https://cdn.test/i.png" }, mimeType: "image/png" },
    });
    const audio = await provider.submit({ ...connection, modelIds: ["fal-ai/minimax-audio"] }, { id: "r3", routeId: "audio", modality: "audio", params: { prompt: "x" } });
    await expect(provider.poll({ ...connection, modelIds: ["fal-ai/minimax-audio"] }, audio)).resolves.toMatchObject({
      result: { data: { url: "https://cdn.test/a.mp3" }, mimeType: "audio/mpeg" },
    });
  });
});

describe("ReplicateProvider", () => {
  const connection = { id: "c-1", baseUrl: "https://replicate.test", modelIds: ["stability-ai/sdxl"] };
  const request = { id: "req-1", routeId: "image", modality: "image", params: { prompt: "a cat" } };

  it("discovers the curated catalog with optional modelIds filtering", async () => {
    const provider = new ReplicateProvider();
    await expect(provider.discover({ id: "c", baseUrl: "https://replicate.test" })).resolves.toHaveLength(REPLICATE_CATALOG.length);
    await expect(provider.discover({ id: "c", baseUrl: "https://replicate.test", modelIds: ["meta/musicgen"] })).resolves.toEqual([
      { modelId: "meta/musicgen", modalities: ["audio"], limits: { maxDurationSeconds: 30 } },
    ]);
  });

  it("submits with Bearer auth and polls predictions to succeeded", async () => {
    let polls = 0;
    const { fetch, calls } = routeFetch({
      "/v1/predictions": () => jsonResponse({ id: "p-1", status: "starting" }, 201),
      "/v1/predictions/p-1": () => {
        polls += 1;
        if (polls === 1) return jsonResponse({ id: "p-1", status: "processing" });
        return jsonResponse({ id: "p-1", status: "succeeded", output: ["https://cdn.test/i.png"] });
      },
      "/v1/predictions/p-1/cancel": () => jsonResponse({ id: "p-1", status: "canceled" }),
    });
    const provider = new ReplicateProvider({ fetch, environment: { REPLICATE_API_TOKEN: "secret" } });
    const keyed = { ...connection, apiKeyEnv: "REPLICATE_API_TOKEN" };

    const handle = await provider.submit(keyed, request);
    expect(handle).toEqual({ id: "p-1", modality: "image" });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ model: "stability-ai/sdxl", input: { prompt: "a cat" } });

    await expect(provider.poll(keyed, handle)).resolves.toEqual({ status: "progressing" });
    await expect(provider.poll(keyed, handle)).resolves.toEqual({
      status: "completed",
      progress: 1,
      result: { data: { url: "https://cdn.test/i.png" }, mimeType: "image/png", byteSize: 0 },
    });

    await expect(provider.cancel(keyed, handle)).resolves.toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ url: "https://replicate.test/v1/predictions/p-1/cancel", init: { method: "POST" } });
  });

  it("treats string outputs (video) as a single result URL", async () => {
    const { fetch } = routeFetch({
      "/v1/predictions": () => jsonResponse({ id: "p-2", status: "starting" }, 201),
      "/v1/predictions/p-2": () => jsonResponse({ id: "p-2", status: "succeeded", output: "https://cdn.test/v.mp4" }),
    });
    const provider = new ReplicateProvider({ fetch });
    const videoConnection = { ...connection, modelIds: ["minimax/video-01"] };
    const handle = await provider.submit(videoConnection, { id: "r2", routeId: "video", modality: "video", params: { prompt: "x" } });
    await expect(provider.poll(videoConnection, handle)).resolves.toMatchObject({
      result: { data: { url: "https://cdn.test/v.mp4" }, mimeType: "video/mp4" },
    });
  });
});
