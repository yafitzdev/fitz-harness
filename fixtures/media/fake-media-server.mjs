import http from "node:http";
import { deflateSync } from "node:zlib";

// Standalone HTTP fixture standing in for a provider-hosted media engine.
// Serves deterministic bytes per modality so the host's URL-result download
// path (design doc §5.11) can be exercised against a real, cross-process
// endpoint. `image` and `audio` reproduce the canonical bytes of
// `packages/engine-media-fake` (same builders) so an e2e test can assert a
// fetched artifact equals the fake engine's inline bytes; keep the builders
// in sync if they change. `video` is a small placeholder constant — the
// URL-fetch e2e test asserts against the image endpoint.

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
    response.writeHead(200, {
      "content-type": entry.mimeType,
      "content-length": entry.bytes.length,
    });
    response.end(Buffer.from(entry.bytes));
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

/** Same 1x1 RGBA PNG builder as packages/engine-media-fake/src/media-adapter.ts. */
function png1x1() {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = new Uint8Array(deflateSync(Buffer.from([0, 0, 0, 0, 0])));
  return concat(signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array()));
}

function pngChunk(type, data) {
  const crc = crc32(concat(ascii(type), data));
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc);
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Same minimal WAV builder as packages/engine-media-fake/src/media-adapter.ts. */
function wavMinimal() {
  const samples = new Uint8Array([128, 128, 129, 127, 126, 130, 128, 128]);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set(ascii("RIFF"), 0);
  view.setUint32(4, 36 + samples.length, true);
  header.set(ascii("WAVE"), 8);
  header.set(ascii("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  header.set(ascii("data"), 36);
  view.setUint32(40, samples.length, true);
  return concat(header, samples);
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(0, equals), argument.slice(equals + 1));
    else if (args[index + 1] && !args[index + 1].startsWith("--")) {
      values.set(argument, args[index + 1]);
      index += 1;
    } else values.set(argument, "true");
  }
  return values;
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function ascii(text) {
  return new TextEncoder().encode(text);
}
