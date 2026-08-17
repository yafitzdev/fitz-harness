import { createHost } from "../apps/host/dist/index.js";

const runtime = createHost();

try {
  const address = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const healthResponse = await fetch(`${address}/health`);
  const modelsResponse = await fetch(`${address}/v1/models`);
  const chatResponse = await fetch(`${address}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "default",
      stream: false,
      messages: [{ role: "user", content: "compiled smoke test" }],
    }),
  });

  if (!healthResponse.ok || !modelsResponse.ok || !chatResponse.ok) {
    throw new Error(
      `Smoke request failed: health=${healthResponse.status} models=${modelsResponse.status} chat=${chatResponse.status}`,
    );
  }

  const health = await healthResponse.json();
  const models = await modelsResponse.json();
  const chat = await chatResponse.json();
  const result = {
    health: health.status,
    initialEngineState: health.engine.state,
    models: models.data.map((model) => model.id),
    completionObject: chat.object,
    model: chat.model,
    completion: chat.choices[0].message.content,
  };

  if (
    result.health !== "ok" ||
    result.initialEngineState !== "READY" ||
    !result.models.includes("fake-best-v1") ||
    result.models.includes("default") ||
    !chat.model ||
    chat.model === "default" ||
    !result.completion.includes("compiled smoke test")
  ) {
    throw new Error(`Unexpected smoke result: ${JSON.stringify(result)}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await runtime.app.close();
}
