import { createFixtureServer, mediaFor, parseArguments, readJson, sendJson, sendMedia } from "./lib.mjs";

// fal.ai fixture (§5.7): `POST /<modelId>` with `Key <key>` returns
// `{ request_id, status: "IN_QUEUE" }`; `GET /requests/{id}` runs a short
// status machine (IN_QUEUE → COMPLETED) with `output.{video|images|audio}`
// URLs; `POST /requests/{id}/cancel` stops a job. Job modality is inferred
// from the model id substring, matching the catalog's naming.

const options = parseArguments(process.argv.slice(2));

/** request_id -> { modality, polls, cancelled } */
const jobs = new Map();
let counter = 0;

function modalityForModelId(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  if (id.includes("video")) return "video";
  if (id.includes("audio")) return "audio";
  return "image";
}

function outputFor(modality, baseUrl) {
  if (modality === "image") return { images: [{ url: `${baseUrl}/media/image` }] };
  if (modality === "video") return { video: { url: `${baseUrl}/media/video` } };
  return { audio: { url: `${baseUrl}/media/audio` } };
}

createFixtureServer("fake-fal", {
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

    const cancelMatch = /^\/requests\/([^/]+)\/cancel$/.exec(path);
    if (request.method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      const job = jobs.get(id);
      if (!job) return sendJson(response, 404, { error: { message: "request not found" } });
      job.cancelled = true;
      return sendJson(response, 200, { request_id: id, status: "CANCELLED" });
    }

    const statusMatch = /^\/requests\/([^/]+)$/.exec(path);
    if (request.method === "GET" && statusMatch) {
      const id = decodeURIComponent(statusMatch[1]);
      const job = jobs.get(id);
      if (!job) return sendJson(response, 404, { error: { message: "request not found" } });
      if (job.cancelled) return sendJson(response, 200, { request_id: id, status: "CANCELLED" });
      job.polls += 1;
      if (job.polls < 2) return sendJson(response, 200, { request_id: id, status: "IN_QUEUE" });
      return sendJson(response, 200, {
        request_id: id,
        status: "COMPLETED",
        output: outputFor(job.modality, baseUrl),
      });
    }

    // Submit: POST /<modelId> (catalog paths never collide with /requests/...).
    if (request.method === "POST" && path.startsWith("/")) {
      await readJson(request);
      counter += 1;
      const id = `fal-req-${counter}`;
      jobs.set(id, { modality: modalityForModelId(path.slice(1)), polls: 0, cancelled: false });
      return sendJson(response, 200, { request_id: id, status: "IN_QUEUE" });
    }

    return sendJson(response, 404, { error: { message: "not found" } });
  },
});
