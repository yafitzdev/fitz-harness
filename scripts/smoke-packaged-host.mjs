import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const stage = resolve("release/host");
const executable = resolve(stage, "runtime/node.exe");
const server = resolve(stage, "dist/server.js");
const npmCli = resolve(stage, "node_modules/npm/bin/npm-cli.js");
const piRuntime = resolve(stage, "node_modules/@fitz/agent-pi");
const port = await freePort();
const dataRoot = resolve(tmpdir(), `fitz-packaged-smoke-${randomUUID()}`);
const baseUrl = `http://127.0.0.1:${port}`;

for (const required of [executable, server, npmCli, piRuntime]) {
  if (!existsSync(required)) throw new Error(`Packaged host is missing ${required}`);
}

const child = spawn(executable, [server], {
  cwd: stage,
  windowsHide: true,
  stdio: "pipe",
  env: {
    ...process.env,
    FITZ_PORT: String(port),
    FITZ_DATA_ROOT: dataRoot,
    FITZ_ENGINE_MODE: "fake",
    FITZ_AUTH_MODE: "disabled",
    FITZ_AGENT_RUNTIME: "disabled",
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  const health = await waitForHealth(baseUrl);
  if (health?.status !== "ok") throw new Error(`Packaged host did not become healthy: ${stderr}`);

  const recipeId = "packaged-smoke-image";
  await expectJson(`${baseUrl}/api/v1/management/recipes/${recipeId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mediaRecipe(recipeId)),
  }, 200);
  await expectJson(`${baseUrl}/api/v1/management/routes/image`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Image generation", recipeId, enabled: true, kind: "image" }),
  }, 200);

  const generation = await expectJson(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "image", prompt: "packaged media smoke" }),
  }, 200);
  const artifactUrl = generation?.data?.[0]?.url;
  if (typeof artifactUrl !== "string") throw new Error(`Media response has no artifact URL: ${JSON.stringify(generation)}`);

  const content = await fetch(artifactUrl);
  if (!content.ok || content.headers.get("content-type") !== "image/png") {
    throw new Error(`Packaged media artifact failed: ${content.status} ${content.headers.get("content-type")}`);
  }
  const bytes = new Uint8Array(await content.arrayBuffer());
  if (bytes.byteLength < 8 || ![137, 80, 78, 71].every((byte, index) => bytes[index] === byte)) {
    throw new Error("Packaged media artifact is not a PNG");
  }

  const ranged = await fetch(artifactUrl, { headers: { range: "bytes=0-3" } });
  if (ranged.status !== 206 || ranged.headers.get("content-range") !== `bytes 0-3/${bytes.byteLength}`) {
    throw new Error(`Packaged media range failed: ${ranged.status} ${ranged.headers.get("content-range")}`);
  }
  const rangeBytes = new Uint8Array(await ranged.arrayBuffer());
  if (rangeBytes.byteLength !== 4 || !rangeBytes.every((byte, index) => byte === bytes[index])) {
    throw new Error("Packaged media range returned the wrong bytes");
  }

  process.stdout.write("FITZ_PACKAGED_HOST_MEDIA_SMOKE_OK\n");
} finally {
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
}

function mediaRecipe(id) {
  return {
    id,
    playbookId: "packaged-smoke",
    displayName: "Packaged smoke image",
    adapter: "media-fake",
    modelId: "packaged-smoke-image-v1",
    contextTokens: 1_024,
    capabilities: {
      chatCompletions: false,
      streaming: true,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
      modalities: { input: ["text"], output: ["image"] },
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "immediate",
      idleTtlSeconds: 0,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return response.json();
    } catch {
      // Host startup races the first few probes.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return undefined;
}

async function expectJson(url, options, status) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (response.status !== status) throw new Error(`${options.method} ${url} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate smoke port"));
      socket.close(() => resolvePort(address.port));
    });
  });
}
