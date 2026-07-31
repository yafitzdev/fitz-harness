import { NInferEngineAdapter, buildCurrentNInferRecipe } from "../packages/engine-ninfer/dist/index.js";
import { createHost } from "../apps/host/dist/index.js";

if (process.env.FITZ_ALLOW_LIVE_NINFER !== "1") {
  throw new Error("Set FITZ_ALLOW_LIVE_NINFER=1 to run the live NInfer route-switch test");
}

const recipes = [
  configuredRecipe(
    "qwen36-35b-a3b-mtp4-100k",
    "qwen3.6-35b-a3b",
    "/opt/ninfer/models/qwen3_6_35b_a3b.ninfer",
    4,
  ),
  configuredRecipe(
    "qwen36-27b-mtp3-100k",
    "qwen3.6-27b",
    "/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer",
    3,
  ),
];
const routes = [
  {
    id: "default-agent",
    displayName: "Qwen 3.6 35B A3B",
    recipeId: recipes[0].id,
    enabled: true,
    isDefault: true,
  },
  {
    id: "fast",
    displayName: "Qwen 3.6 27B",
    recipeId: recipes[1].id,
    enabled: true,
  },
];

const runtime = createHost({
  adapters: [new NInferEngineAdapter({ pollIntervalMs: 500, stopTimeoutMs: 15_000 })],
  initialRecipes: recipes,
  initialRoutes: routes,
});

try {
  const fastStartedAt = Date.now();
  const fastResponse = await collect(runtime.scheduler.enqueue("fast", request("route-switch-27b")));
  const fastDurationMs = Date.now() - fastStartedAt;

  const bestStartedAt = Date.now();
  const bestResponse = await collect(
    runtime.scheduler.enqueue("default-agent", request("route-switch-35b")),
  );
  const bestDurationMs = Date.now() - bestStartedAt;

  await waitForState(runtime, "UNLOADED", 15_000);
  const stateEvents = runtime.events
    .after(0)
    .filter((event) => event.type === "instance.state.changed")
    .map((event) => `${event.data.previousState}->${event.data.state}:${event.data.recipeId ?? "none"}`);
  const preparingCount = stateEvents.filter((event) => event.startsWith("UNLOADED->PREPARING")).length;
  const unloadedCount = stateEvents.filter((event) => event.includes("EVICTING->UNLOADED")).length;
  if (preparingCount !== 2 || unloadedCount !== 2) {
    throw new Error(`Unexpected route-switch lifecycle: ${JSON.stringify(stateEvents)}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        fast: { model: recipes[1].modelId, durationMs: fastDurationMs, response: fastResponse.trim() },
        best: { model: recipes[0].modelId, durationMs: bestDurationMs, response: bestResponse.trim() },
        finalState: runtime.lifecycle.snapshot().state,
        stateEvents,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await runtime.app.close();
}

function configuredRecipe(id, modelId, artifact, draftTokens) {
  const recipe = buildCurrentNInferRecipe(id, modelId, artifact, draftTokens);
  const configuration = { ...recipe.configuration, readinessTimeoutMs: 180_000 };
  delete configuration.requestLogJsonl;
  recipe.configuration = configuration;
  recipe.lifecycle = {
    ...recipe.lifecycle,
    idleTtlSeconds: 3,
    minimumResidencySeconds: 0,
  };
  return recipe;
}

function request(id) {
  return {
    messages: [{ role: "user", content: `Reply with exactly: ${id}` }],
    maxTokens: 32,
    temperature: 0,
  };
}

async function collect(stream) {
  let content = "";
  for await (const delta of stream) content += delta.text;
  return content;
}

async function waitForState(runtime, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.lifecycle.snapshot().state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${expected}; current state=${runtime.lifecycle.snapshot().state}`,
  );
}
