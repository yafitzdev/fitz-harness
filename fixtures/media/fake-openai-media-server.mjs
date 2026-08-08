import { createFixtureServer, mediaFor, parseArguments, readJson, sendJson, sendMedia } from "./lib.mjs";

// OpenAI-compatible media fixture (§5.7): `/v1/models` advertises a chat model
// plus DALL·E / Sora / TTS generation models. Images and audio are synchronous
// (`data[0].url`, or `b64_json` when the prompt contains "b64"); videos are
// async (`{ id, status }` → `GET /v1/videos/generations/{id}`, `DELETE` to
// cancel) with a short status machine (queued → completed). Media bytes come
// from the shared lib so the host's URL-result download path is exercised
// cross-process against the same canonical bytes as `engine-media-fake`.

const options = parseArguments(process.argv.slice(2));

const models = [
  { id: "gpt-4o-mini", object: "model", owned_by: "fixture", endpoints: ["chat"] },
  { id: "dall-e-3", object: "model", owned_by: "fixture", type: "image-generation" },
  { id: "sora-video", object: "model", owned_by: "fixture", task: "video-generation" },
  { id: "tts-1", object: "model", owned_by: "fixture", type: "audio-generation" },
];

/** id -> { polls, cancelled }; completes on the second poll (~2 s at the host's
 *  2000 ms cadence) so e2e tests stay comfortably inside the vitest budget. */
const videoJobs = new Map();
let jobCounter = 0;

createFixtureServer("fake-openai-media", {
  host: options.get("--host"),
  port: options.get("--port"),
  apiKey: options.get("--api-key"),
  unauthenticatedPaths: ["/media"],
  async handle({ request, response, baseUrl }) {
    const path = new URL(request.url, baseUrl).pathname;

    if (request.method === "GET" && path === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && path === "/v1/models") {
      return sendJson(response, 200, { object: "list", data: models });
    }

    const mediaMatch = /^\/media\/(image|video|audio)$/.exec(path);
    if (request.method === "GET" && mediaMatch) {
      const entry = mediaFor(mediaMatch[1]);
      return sendMedia(response, entry.mimeType, entry.bytes);
    }

    // Synchronous generations: images and audio return the artifact URL inline
    // (or base64 when the prompt opts in, exercising the b64_json path).
    if (request.method === "POST" && (path === "/v1/images/generations" || path === "/v1/audio/generations")) {
      const modality = path === "/v1/images/generations" ? "image" : "audio";
      const body = await readJson(request);
      const entry = mediaFor(modality);
      const created = Math.floor(Date.now() / 1000);
      if (String(body.prompt ?? "").includes("b64")) {
        return sendJson(response, 200, { created, data: [{ b64_json: Buffer.from(entry.bytes).toString("base64") }] });
      }
      return sendJson(response, 200, { created, data: [{ url: `${baseUrl}/media/${modality}` }] });
    }

    // Async videos: `{ id, status }` envelope on submit, then GET status.
    if (request.method === "POST" && path === "/v1/videos/generations") {
      jobCounter += 1;
      const id = `video-job-${jobCounter}`;
      videoJobs.set(id, { polls: 0, cancelled: false });
      return sendJson(response, 200, { id, status: "queued" });
    }

    const videoMatch = /^\/v1\/videos\/generations\/([^/]+)$/.exec(path);
    if (videoMatch) {
      const id = decodeURIComponent(videoMatch[1]);
      const job = videoJobs.get(id);
      if (!job) return sendJson(response, 404, { error: { message: "video job not found" } });
      if (request.method === "DELETE") {
        job.cancelled = true;
        return sendJson(response, 200, { id, status: "cancelled" });
      }
      if (request.method === "GET") {
        if (job.cancelled) return sendJson(response, 200, { id, status: "cancelled" });
        job.polls += 1;
        if (job.polls < 2) return sendJson(response, 200, { id, status: "queued" });
        return sendJson(response, 200, { id, status: "completed", data: [{ url: `${baseUrl}/media/video` }] });
      }
    }

    return sendJson(response, 404, { error: { message: "not found" } });
  },
});
