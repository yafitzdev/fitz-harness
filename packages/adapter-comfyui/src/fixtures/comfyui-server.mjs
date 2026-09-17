// Simulated ComfyUI server for adapter-comfyui tests.
// Implements the API surface the adapter drives: GET /system_stats,
// POST /prompt, GET /progress, GET /history/{promptId}, GET /view, POST /queue,
// plus a WebSocket endpoint at /ws that streams {"type":"progress",...} frames
// like the real server's ProgressBar hook (modern ComfyUI builds have no HTTP
// /progress route — progress is WebSocket-only).
//
// Progress advances per tick (progressPerPoll, default 0.25); a job lands in
// /history once it reaches 1. The output modality is derived from the submitted
// graph's class_type values (contains "Audio" -> audio, "Image" -> image,
// otherwise video). A prompt containing --fail-on moves to history with an
// error status instead of outputs.
//
// Flags:
//   --no-progress-endpoint  GET /progress returns 404 (realistic for current
//                           ComfyUI builds; exercises the WebSocket path)
//   --ws-tick-ms <n>        interval between WS progress frames (default 25)

import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const host = valueAfter("--listen") ?? "127.0.0.1";
const port = Number(valueAfter("--port"));
const progressPerPoll = Number(valueAfter("--progress-per-poll") ?? 0.25);
const wsTickMs = Number(valueAfter("--ws-tick-ms") ?? 25);
const noProgressEndpoint = process.argv.includes("--no-progress-endpoint");
const failOn = valueAfter("--fail-on");
// Optional: when set, every submitted prompt graph is appended as one JSON line.
const graphFile = valueAfter("--graph-file");

const VIDEO_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x66, 0x69, 0x74, 0x7a]);
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const AUDIO_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);

const running = new Map(); // prompt_id -> { progress, prompt, modality }
const history = new Map(); // prompt_id -> { entry }
const clientIdByPromptId = new Map(); // prompt_id -> client_id (POST /prompt body)

function advanceJobs() {
  for (const [promptId, job] of running) {
    job.progress = Math.min(1, job.progress + progressPerPoll);
    if (job.progress >= 1) {
      running.delete(promptId);
      history.set(promptId, makeHistoryEntry(promptId, job));
    }
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/system_stats") {
      json(response, { system: { comfyui_version: "0.3.99-fixture" } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/prompt") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || !body.prompt || typeof body.prompt !== "object") {
        json(response, { error: "invalid prompt graph" }, 400);
        return;
      }
      const promptId = randomUUID();
      const modality = modalityOf(body.prompt);
      running.set(promptId, { progress: 0, prompt: promptOf(body.prompt), modality });
      if (typeof body.client_id === "string" && body.client_id) {
        clientIdByPromptId.set(promptId, body.client_id);
      }
      if (graphFile) appendFileSync(graphFile, JSON.stringify(body.prompt) + "\n", "utf8");
      json(response, { prompt_id: promptId, number: running.size, node_errors: {} });
      return;
    }
    if (request.method === "GET" && url.pathname === "/progress") {
      if (noProgressEndpoint) {
        json(response, { error: "not found" }, 404);
        return;
      }
      advanceJobs();
      const progress = Object.fromEntries(
        [...running].map(([promptId, job]) => [promptId, { progress: Math.round(job.progress * 100), eta: 10 }]),
      );
      json(response, { running: progress, completed: {}, queue_remaining: running.size });
      return;
    }
    const historyMatch = /^\/history\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && historyMatch) {
      const entry = history.get(decodeURIComponent(historyMatch[1]));
      json(response, entry ? { [decodeURIComponent(historyMatch[1])]: entry } : {});
      return;
    }
    if (request.method === "GET" && url.pathname === "/view") {
      const filename = url.searchParams.get("filename") ?? "";
      const bytes = filename.includes(".png") ? IMAGE_BYTES : filename.includes(".wav") || filename.includes(".mp3") ? AUDIO_BYTES : VIDEO_BYTES;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    if (request.method === "POST" && url.pathname === "/queue") {
      const body = await readJson(request);
      if (body?.clear) {
        running.clear();
        history.clear();
      }
      for (const promptId of body?.delete ?? []) {
        running.delete(promptId);
        history.delete(promptId);
      }
      json(response, {});
      return;
    }
    json(response, { error: `not found: ${request.method} ${url.pathname}` }, 404);
  } catch (error) {
    json(response, { error: String(error) }, 500);
  }
});

// Minimal RFC6455 server: answers the upgrade with the accept key, then pushes
// one progress frame per tick for jobs submitted with this connection's
// clientId. Client frames (masked) are ignored except ping/close replies.
server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const clientId = url.searchParams.get("clientId") ?? "";
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const interval = setInterval(() => {
    advanceJobs();
    for (const [promptId, job] of running) {
      if (clientIdByPromptId.get(promptId) === clientId) {
        writeFrame(socket, JSON.stringify({
          type: "progress",
          data: { value: Math.round(job.progress * 100), max: 100, prompt_id: promptId, node: "sampler" },
        }));
      }
    }
  }, wsTickMs);
  socket.on("data", (chunk) => {
    const opcode = chunk[0] & 0x0f;
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x00])); // ping -> pong
    } else if (opcode === 0x8) {
      socket.write(Buffer.from([0x88, 0x00])); // close -> ack
      socket.end();
    }
  });
  socket.on("close", () => clearInterval(interval));
  socket.on("error", () => clearInterval(interval));
});

server.listen(port, host);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

function writeFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > 125) return; // progress payloads are small; skip oversize
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}

function modalityOf(graph) {
  const classTypes = Object.values(graph).map((node) => String(node?.class_type ?? ""));
  // Video workflows commonly contain audio decode/mux nodes. Classify by the
  // final output container before considering intermediate modality nodes.
  if (classTypes.some((name) => name.toLowerCase().includes("video"))) return "video";
  if (classTypes.some((name) => name.toLowerCase().includes("audio"))) return "audio";
  if (classTypes.some((name) => name.toLowerCase().includes("image"))) return "image";
  return "video";
}

function promptOf(graph) {
  for (const node of Object.values(graph)) {
    const prompt = node?.inputs?.prompt;
    if (typeof prompt === "string" && prompt) return prompt;
  }
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node?.inputs ?? {})) {
      if (typeof value === "string" && value && !value.includes("{{")) return value;
    }
  }
  return "";
}

function makeHistoryEntry(promptId, job) {
  const failed = failOn && job.prompt.includes(failOn);
  const outputs = failed ? {} : { "9": outputFor(job.modality) };
  return {
    prompt: [3, promptId],
    outputs,
    status: { status_str: failed ? "error" : "success", completed: true },
  };
}

function outputFor(modality) {
  if (modality === "audio") return { audio: [{ filename: "h3-output.wav", subfolder: "audio", type: "output", format: "audio/wav" }] };
  if (modality === "image") return { images: [{ filename: "h3-output.png", subfolder: "", type: "output", format: "image/png" }] };
  return { videos: [{ filename: "h3-output.mp4", subfolder: "video", type: "output", format: "video/h264-mp4" }] };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
