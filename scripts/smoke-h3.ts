import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ComfyUIEngineAdapter } from "../packages/engine-comfyui/src/index.js";
import { createHost } from "../apps/host/src/create-app.js";
import { createComfyUIPlaybook } from "../apps/host/src/comfyui-playbook.js";
import { localComfyUIPaths } from "../apps/host/src/comfyui-reconcile.js";
import { resolveRuntimePaths } from "../apps/host/src/runtime-paths.js";

const outputPath = resolve(process.argv[2] ?? "C:/Users/yanfi/AppData/Local/Fitz Codex/cache/h3-smoke.mp4");
const paths = resolveRuntimePaths();
const local = localComfyUIPaths(paths);
const playbook = createComfyUIPlaybook({
  engineDir: local.engineDir,
  executable: local.executable,
  launchArgs: ["--extra-model-paths-config", local.modelConfigPath, "--output-directory", local.outputDir],
});
const baseRecipe = playbook.recipes[0]!;
const smokeRecipe = {
  ...baseRecipe,
  configuration: {
    ...baseRecipe.configuration,
    defaults: {
      ...(baseRecipe.configuration.defaults as Record<string, unknown>),
      resolution: "768x432",
      durationSeconds: 1,
    },
  },
};
const runtime = createHost({
  adapters: [new ComfyUIEngineAdapter({ pollIntervalMs: 1_000 })],
  initialRecipes: [smokeRecipe],
  initialRoutes: playbook.routes,
  mediaImageTimeoutMs: 15 * 60_000,
});

const startedAt = Date.now();
try {
  const test = await runtime.app.inject({ method: "POST", url: "/api/v1/management/recipes/h3-video/media-test" });
  if (test.statusCode !== 200) throw new Error(`H3 host smoke failed (${test.statusCode}): ${test.body}`);
  const result = test.json().data as { artifactId?: string; jobId: string; modality: string; status: string };
  if (!result.artifactId) throw new Error(`H3 host smoke completed without an artifact: ${test.body}`);

  const artifact = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${result.artifactId}/content` });
  if (artifact.statusCode !== 200) throw new Error(`Could not retrieve H3 artifact (${artifact.statusCode}): ${artifact.body}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, artifact.rawPayload);
  process.stdout.write(`${JSON.stringify({
    outputPath,
    artifactId: result.artifactId,
    mediaJobId: result.jobId,
    mimeType: artifact.headers["content-type"],
    byteSize: artifact.rawPayload.byteLength,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  })}\n`);
} finally {
  await runtime.app.close();
}
