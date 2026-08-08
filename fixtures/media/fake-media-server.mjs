import http from "node:http";
import { parseArguments, png1x1, sendJson, sendMedia, wavMinimal } from "./lib.mjs";

// Standalone HTTP fixture standing in for a provider-hosted media engine.
// Serves deterministic bytes per modality so the host's URL-result download
// path (design doc §5.11) can be exercised against a real, cross-process
// endpoint. `image` and `audio` reproduce the canonical bytes of
// `packages/engine-media-fake` (same builders in lib.mjs) so an e2e test can
// assert a fetched artifact equals the fake engine's inline bytes; `video` is
// a small placeholder constant — the URL-fetch e2e test asserts against the
// image endpoint.

const options = parseArguments(process.argv.slice(2));
const host = options.get("--host") ?? "127.0.0.1";
const port = Number.parseInt(options.get("--port") ?? "0", 10);
const apiKey = options.get("--api-key") ?? "";

if (!Number.isInteger(port) || port < 0) {
  process.stderr.write("invalid port\n");
  process.exit(2);
}

const media = {
  image: { mimeType: "image/png", bytes: png1x1() },
  video: { mimeType: "video/mp4", bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]) },
  audio: { mimeType: "audio/wav", bytes: wavMinimal() },
};

const server = http.createServer(async (request, response) => {
  if (apiKey && request.headers.authorization !== `Bearer ${apiKey}`) {
    sendJson(response, 401, { error: { message: "unauthorized" } });
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  const match = /^\/media\/(image|video|audio)$/.exec(request.url ?? "");
  if (request.method === "GET" && match) {
    const entry = media[match[1]];
    sendMedia(response, entry.mimeType, entry.bytes);
    return;
  }

  sendJson(response, 404, { error: { message: "not found" } });
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  process.stdout.write(`fake-media ready on ${host}:${actualPort}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
