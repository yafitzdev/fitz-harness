import { createFixtureServer, mediaFor, parseArguments, readJson, sendJson, sendMedia } from "./lib.mjs";

// Replicate fixture (§5.7): `POST /v1/predictions` with `{ model, input }`
// returns `{ id, status: "starting" }`; `GET /v1/predictions/{id}` runs a
// short status machine (starting → succeeded) with `output` as a URL string
// (video/audio) or a URL array (image); `POST /v1/predictions/{id}/cancel`
// stops a job. Job modality is inferred from the model id substring.

const options = parseArguments(process.argv.slice(2));

/** id -> { modality, polls, cancelled } */
const predictions = new Map();
let counter = 0;

function modalityForModelId(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("video")) return "video";
  if (id.includes("musicgen") || id.includes("audio")) return "audio";
  return "image";
}

function outputFor(modality, baseUrl) {
  if (modality === "image") return [`${baseUrl}/media/image`];
  return `${baseUrl}/media/${modality}`; // video/audio output is a single URL
}

createFixtureServer("fake-replicate", {
  host: options.get("--host"),
  port: options.get("--port"),
  apiKey: options.get("--api-key"),
  unauthenticatedPaths: ["/media"],
  async handle({ request, response, baseUrl }) {
    const path = new URL(request.url, baseUrl).pathname;

    if (request.method === "GET" && path === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }

    const mediaMatch = /^\/media\/(image|video|audio)$/.exec(path);
    if (request.method === "GET" && mediaMatch) {
      const entry = mediaFor(mediaMatch[1]);
      return sendMedia(response, entry.mimeType, entry.bytes);
    }

    if (request.method === "POST" && path === "/v1/predictions") {
      const body = await readJson(request);
      counter += 1;
      const id = `rep-pred-${counter}`;
      predictions.set(id, { modality: modalityForModelId(body.model), polls: 0, cancelled: false });
      return sendJson(response, 201, { id, status: "starting" });
    }

    const cancelMatch = /^\/v1\/predictions\/([^/]+)\/cancel$/.exec(path);
    if (request.method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      const prediction = predictions.get(id);
      if (!prediction) return sendJson(response, 404, { error: { message: "prediction not found" } });
      prediction.cancelled = true;
      return sendJson(response, 200, { id, status: "canceled" });
    }

    const statusMatch = /^\/v1\/predictions\/([^/]+)$/.exec(path);
    if (request.method === "GET" && statusMatch) {
      const id = decodeURIComponent(statusMatch[1]);
      const prediction = predictions.get(id);
      if (!prediction) return sendJson(response, 404, { error: { message: "prediction not found" } });
      if (prediction.cancelled) return sendJson(response, 200, { id, status: "canceled" });
      prediction.polls += 1;
      if (prediction.polls < 2) return sendJson(response, 200, { id, status: "starting" });
      return sendJson(response, 200, {
        id,
        status: "succeeded",
        output: outputFor(prediction.modality, baseUrl),
      });
    }

    return sendJson(response, 404, { error: { message: "not found" } });
  },
});
