import { createServer } from "node:net";
import {
  NInferEngineAdapter,
  buildCurrentNInferRecipe,
} from "../packages/engine-ninfer/dist/index.js";

if (process.env.FITZ_ALLOW_LIVE_NINFER !== "1") {
  throw new Error("Set FITZ_ALLOW_LIVE_NINFER=1 to run the live NInfer smoke test");
}

const profile = process.env.FITZ_NINFER_PROFILE ?? "27b";
const selected =
  profile === "35b"
    ? {
        id: "qwen36-35b-a3b-mtp4-100k",
        modelId: "qwen3.6-35b-a3b",
        artifact: "/opt/ninfer/models/qwen3_6_35b_a3b.ninfer",
        draftTokens: 4,
      }
    : {
        id: "qwen36-27b-mtp3-100k",
        modelId: "qwen3.6-27b",
        artifact: "/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer",
        draftTokens: 3,
      };

const recipe = buildCurrentNInferRecipe(
  selected.id,
  selected.modelId,
  selected.artifact,
  selected.draftTokens,
);
const configuration = { ...recipe.configuration };
delete configuration.requestLogJsonl;
configuration.readinessTimeoutMs = 180_000;
recipe.configuration = configuration;

const port = await availablePort();
const adapter = new NInferEngineAdapter({ pollIntervalMs: 500, stopTimeoutMs: 15_000 });
const controller = new AbortController();
const validation = await adapter.validateRecipe(recipe);
if (!validation.valid) throw new Error(JSON.stringify(validation.issues));

const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port });
const startedAt = Date.now();
const instance = await adapter.start(recipe, spec, controller.signal);
let content = "";

try {
  await adapter.waitUntilReady(instance, controller.signal);
  const readyAfterMs = Date.now() - startedAt;
  for await (const delta of adapter.streamChat(
    instance,
    {
      id: "live-ninfer-smoke",
      routeId: "default-agent",
      messages: [{ role: "user", content: "Reply with exactly: FITZ_LIVE_OK" }],
      maxTokens: 32,
      temperature: 0,
    },
    controller.signal,
  )) {
    content += delta.text;
  }
  const inspection = await adapter.inspect(instance);
  if (!inspection.healthy || content.trim().length === 0) {
    throw new Error(`Live smoke failed: ${JSON.stringify({ inspection, content })}`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        profile,
        modelId: selected.modelId,
        port,
        readyAfterMs,
        response: content.trim(),
        healthy: inspection.healthy,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  const report = await adapter.stop(instance, "graceful");
  if (!report.stopped) throw new Error("NInfer process did not stop cleanly");
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a TCP port");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
