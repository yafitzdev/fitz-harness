import { NInferEngineAdapter } from "../packages/engine-ninfer/dist/index.js";
import { createHost, createNInferPlaybook } from "../apps/host/dist/index.js";

if (process.env.FITZ_ALLOW_LIVE_NINFER !== "1") {
  throw new Error("Set FITZ_ALLOW_LIVE_NINFER=1 to run the live NInfer route-switch test");
}

const playbook = createNInferPlaybook();
const recipes = playbook.recipes.map(configuredRecipe);
const routes = playbook.routes;

const runtime = createHost({
  adapters: [new NInferEngineAdapter({ pollIntervalMs: 500, stopTimeoutMs: 15_000, ...(process.platform === "win32" ? { wslDistribution: process.env.FITZ_NINFER_WSL_DISTRIBUTION ?? "Ubuntu", wslUser: process.env.FITZ_NINFER_WSL_USER ?? "root" } : {}) })],
  initialRecipes: recipes,
  initialRoutes: routes,
});

try {
  const fastStartedAt = Date.now();
  const fastResponse = await collect(runtime.scheduler.enqueue("fast", request("route-switch-27b")));
  const fastDurationMs = Date.now() - fastStartedAt;

  const bestStartedAt = Date.now();
  const bestResponse = await collect(
    runtime.scheduler.enqueue("smart", request("route-switch-35b")),
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

function configuredRecipe(source) {
  const recipe = structuredClone(source);
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
