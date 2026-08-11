import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHost } from "./create-app.js";
import { ModelCatalogService } from "./model-catalog.js";
import { TailscaleMonitor, TailscaleServeManager, WindowsStartupManager } from "@fitz/connectivity";
import { SecurityService } from "@fitz/security";
import { ArtifactRepository, LocalBlobStore, SqliteStore, StorageDurabilityService } from "@fitz/storage";
import { FakeEngineAdapter } from "@fitz/engine-fake";

describe("Fitz host", () => {
  it("boots idle and exposes consumer routes instead of recipes", async () => {
    const runtime = createHost();
    const health = await runtime.app.inject({ method: "GET", url: "/health" });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models" });

    expect(health.statusCode).toBe(200);
    expect(health.json().engine.state).toBe("UNLOADED");
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" })).json().hostName).toEqual(expect.any(String));
    expect(models.json().data.map((model: { id: string }) => model.id)).toEqual([
      "default",
      "fast",
      "smart",
    ]);
    expect(models.body).not.toContain("fake-best");
    await runtime.app.close();
  });

  it("exposes durable usage aggregates after a terminal request", async () => {
    const runtime = createHost();
    try {
      const completion = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "default", stream: false, messages: [{ role: "user", content: "usage accounting" }] },
      });
      expect(completion.statusCode, completion.body).toBe(200);
      const usage = await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage?bucket=hour" });
      expect(usage.statusCode, usage.body).toBe(200);
      expect(usage.json().data).toEqual(expect.objectContaining({
        bucket: "hour",
        totals: expect.objectContaining({ requests: 1, successful: 1, failed: 0, tokenReportedRequests: 1 }),
        routes: expect.arrayContaining([expect.objectContaining({ key: "default", requests: 1 })]),
      }));
    } finally { await runtime.app.close(); }
  });

  it("rejects malformed usage report ranges instead of silently changing them", async () => {
    const runtime = createHost();
    try {
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage?from=nope" })).statusCode).toBe(400);
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage?bucket=minute" })).statusCode).toBe(400);
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage?from=2026-08-10T00:00:00.000Z&to=2026-08-09T00:00:00.000Z" })).statusCode).toBe(400);
    } finally { await runtime.app.close(); }
  });

  it("warms a selected route without generating a message", async () => {
    const runtime = createHost();
    try {
      const response = await runtime.app.inject({ method: "POST", url: "/api/v1/inference/warm", payload: { model: "default", connectionId: "hosted--local" } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(expect.objectContaining({ state: "READY", recipeId: "fake-best" }));
      expect(runtime.lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "READY", activeLeases: 0 }));
      expect(runtime.store.listGpuWork()).toEqual([
        expect.objectContaining({
          routeId: "default",
          kind: "warm",
          status: "completed",
          position: 0,
        }),
      ]);
      expect(runtime.store.listInferenceRequests()).toEqual([]);
      const gpuWork = await runtime.app.inject({ method: "GET", url: "/api/v1/management/gpu-work" });
      expect(gpuWork.statusCode, gpuWork.body).toBe(200);
      expect(gpuWork.json().data).toEqual([
        expect.objectContaining({ routeId: "default", kind: "warm", status: "completed" }),
      ]);
    } finally { await runtime.app.close(); }
  });

  it("returns an immediate OpenAI-compatible 429 when the GPU lane is saturated", async () => {
    const runtime = createHost({
      fakeAdapter: new FakeEngineAdapter({ tokenDelayMs: 100 }),
      schedulerOptions: { gpuQueueCapacity: 1 },
    });
    const active = runtime.scheduler.enqueue("default", { messages: [{ role: "user", content: "active" }] });
    const queued = runtime.scheduler.enqueue("default", { messages: [{ role: "user", content: "queued" }] });
    const drain = (async () => { try { for await (const _delta of active) { /* drain */ } } catch { /* cancelled below */ } })();
    const drainQueued = (async () => { try { for await (const _delta of queued) { /* drain */ } } catch { /* cancelled below */ } })();
    try {
      const response = await runtime.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "default", stream: false, messages: [{ role: "user", content: "overflow" }] },
      });
      expect(response.statusCode, response.body).toBe(429);
      expect(response.headers["retry-after"]).toBe("2");
      expect(response.json().error).toEqual(expect.objectContaining({ type: "resource_busy", message: expect.stringContaining("queue is at capacity") }));
    } finally {
      active.cancel();
      queued.cancel();
      await Promise.all([drain, drainQueued]);
      await runtime.app.close();
    }
  });

  it("keeps internal connection routes out of the public model contract", async () => {
    const runtime = createHost();
    try {
      const assigned = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/consumer--default", payload: { displayName: "Default", recipeId: "fake-best", enabled: true, isDefault: true } });
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models" })).json().data.map((item: { id: string }) => item.id)).toEqual(["default", "fast", "smart"]);
      const completion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "consumer--default", stream: false, messages: [{ role: "user", content: "hosted locally" }] } });
      expect(completion.statusCode, completion.body).toBe(200);
      expect(completion.json().choices[0].message.content).toContain("Fake response from fake-best-v1");
    } finally { await runtime.app.close(); }
  });

  it("passes media-command tool choice through without forcing a function override", async () => {
    const adapter = new FakeEngineAdapter();
    const runtime = createHost({
      fakeAdapter: adapter,
      internalAgentToken: "agent-secret",
      resourceMonitor: {
        snapshot: async () => ({
          capturedAt: new Date(0).toISOString(),
          totalRamMiB: 64_000,
          freeRamMiB: 32_000,
          totalVramMiB: 32_000,
          usedVramMiB: 1_000,
          freeVramMiB: 31_000,
          gpuTelemetryAvailable: true,
        }),
      },
    });
    const payload = {
      model: "default",
      stream: false,
      messages: [{ role: "user", content: "/image a tree on fire" }],
      tools: [{ type: "function", function: { name: "generate_image", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
    };
    try {
      const recipe = await runtime.app.inject({
        method: "PUT", url: "/api/v1/management/recipes/fake-best", payload: {
          playbookId: "fake-development",
          displayName: "Fake Best Model",
          adapter: "fake",
          modelId: "fake-best-v1",
          contextTokens: 100_000,
          capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
          lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 1 },
          configuration: {},
        },
      });
      expect(recipe.statusCode, recipe.body).toBe(200);

      // Media runs no longer force a specific function tool_choice (thinking-mode
      // providers reject it); the agent runtime drives determinism via the
      // activeTools allowlist and a rewritten prompt instead.
      const internal = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer agent-secret", "x-fitz-forced-tool": "generate_image" }, payload,
      });
      expect(internal.statusCode, internal.body).toBe(200);
      expect(adapter.requests.at(-1)?.toolChoice).toBe("auto");

      const publicCall = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "x-fitz-forced-tool": "generate_image" }, payload });
      expect(publicCall.statusCode, publicCall.body).toBe(200);
      expect(adapter.requests.at(-1)?.toolChoice).toBe("auto");

      const unsupportedInternalOverride = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer agent-secret", "x-fitz-forced-tool": "bash" }, payload,
      });
      expect(unsupportedInternalOverride.statusCode, unsupportedInternalOverride.body).toBe(200);
      expect(adapter.requests.at(-1)?.toolChoice).toBe("auto");
    } finally { await runtime.app.close(); }
  });

  it("discovers an external API and routes sessions through the global route model", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[{"id":"upstream-model"},{"id":"explicit-chat-model","endpoints":["chat"]},{"id":"embed-v4.0"},{"id":"rerank-v3.5"},{"id":"cohere-transcribe-03-2026"},{"id":"provider-embedding","endpoints":["embed"]}]}'); return; }
      if (request.url === "/v1/chat/completions") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"choices":[{"delta":{"content":"upstream ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return; }
      response.writeHead(404); response.end();
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const runtime = createHost();
    try {
      const saved = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/connections/test-api", payload: { displayName: "Test API", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" } });
      expect(saved.statusCode).toBe(200);
      const consumerModel = saved.json().data.models[0];
      expect(consumerModel).toEqual(expect.objectContaining({ id: "upstream-model", routeId: expect.any(String), recipeId: expect.any(String) }));
      expect(saved.json().data.models.map((model: { id: string }) => model.id)).toEqual(["upstream-model", "explicit-chat-model"]);
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models" })).json().data.map((item: { id: string }) => item.id).sort()).toEqual(["default", "fast", "smart"]);
      const models = await runtime.app.inject({ method: "GET", url: "/v1/models" });
      expect(models.json().data.map((item: { id: string }) => item.id)).toEqual(["default", "fast", "smart"]);
      const recipeTest = await runtime.app.inject({ method: "POST", url: `/api/v1/management/recipes/${consumerModel.recipeId}/test` });
      expect(recipeTest.statusCode, recipeTest.body).toBe(200); expect(recipeTest.json().data.working).toBe(true);
      await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/default", payload: { displayName: "Default", recipeId: consumerModel.recipeId, enabled: true, isDefault: true } });
      const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Connection routing" } });
      const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "External", connectionId: "test-api", routeId: "default" } });
      const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId: session.json().data.id, messages: [{ role: "user", content: "hello" }] } });
      expect(run.statusCode, run.body).toBe(202);
      // A session's connectionId no longer scopes resolution: the run uses the global default class.
      expect(run.json().data.routeId).toBe("default");
      // The public class remains the sole routing contract after connection refresh.
      const scopedCompletion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
      expect(scopedCompletion.statusCode, scopedCompletion.body).toBe(200);
      expect(scopedCompletion.json().choices[0].message.content).toContain("upstream ok");
      await runtime.app.inject({ method: "PUT", url: "/api/v1/management/connections/test-api", payload: { displayName: "Test API", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" } });
      const refreshedStatus = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });
      expect(refreshedStatus.json().routes).toContainEqual(expect.objectContaining({ id: "default", recipeId: consumerModel.recipeId }));
      await runtime.app.inject({ method: "DELETE", url: "/api/v1/management/connections/test-api" });
      // Removing the connection releases the global class it had claimed.
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" })).json().routes).not.toContainEqual(expect.objectContaining({ id: "default", recipeId: consumerModel.recipeId }));
    } finally { await runtime.app.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
  });

  it("reports a descriptive error when a recipe test returns no visible text", async () => {
    const reasoningUpstream = createServer((request, response) => {
      if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[{"id":"reasoning-model"}]}'); return; }
      if (request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"reasoning_content":"Hmm, let me think about a greeting."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'); return;
      }
      response.writeHead(404); response.end();
    });
    reasoningUpstream.listen(0, "127.0.0.1"); await once(reasoningUpstream, "listening");
    const reasoningAddress = reasoningUpstream.address(); if (!reasoningAddress || typeof reasoningAddress === "string") throw new Error("Expected TCP address");
    const runtime = createHost();
    try {
      const saved = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/connections/reasoning-api", payload: { displayName: "Reasoning API", baseUrl: `http://127.0.0.1:${reasoningAddress.port}/v1`, authType: "none" } });
      expect(saved.statusCode).toBe(200);
      const recipeId = saved.json().data.models[0].recipeId;
      const test = await runtime.app.inject({ method: "POST", url: `/api/v1/management/recipes/${recipeId}/test` });
      expect(test.statusCode).toBe(502);
      expect(test.json().error.message).toContain("produced reasoning");
      expect(test.json().error.message).toContain("length");
    } finally { await runtime.app.close(); await new Promise<void>((resolve) => reasoningUpstream.close(() => resolve())); }
  });

  it("persists recipe changes from the management API", async () => {
    const runtime = createHost();
    const response = await runtime.app.inject({
      method: "PUT",
      url: "/api/v1/management/recipes/custom-recipe",
      payload: {
        playbookId: "custom-playbook",
        displayName: "Custom Recipe",
        adapter: "fake",
        modelId: "fake-custom-v1",
        contextTokens: 64_000,
        capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
        lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 300, minimumResidencySeconds: 0 },
        configuration: { temperature: 0.2 },
      },
    });
    const status = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });

    expect(response.statusCode).toBe(200);
    expect(status.json().recipes).toContainEqual(expect.objectContaining({ id: "custom-recipe", playbookId: "custom-playbook" }));
    await runtime.app.close();
  });

  it("tests an exact recipe without changing fixed route assignments", async () => {
    const runtime = createHost();
    await runtime.app.inject({
      method: "PUT",
      url: "/api/v1/management/recipes/probe-recipe",
      payload: {
        playbookId: "probe-playbook",
        displayName: "Probe Recipe",
        adapter: "fake",
        modelId: "probe-model",
        contextTokens: 64_000,
        capabilities: { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
        lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 300, minimumResidencySeconds: 0 },
        configuration: {},
      },
    });
    const routesBefore = runtime.routes.listRoutes();

    const response = await runtime.app.inject({ method: "POST", url: "/api/v1/management/recipes/probe-recipe/test" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(expect.objectContaining({ recipeId: "probe-recipe", working: true, unloaded: true }));
    expect(response.json().data.output).toContain("probe-model");
    expect(runtime.lifecycle.snapshot().state).toBe("UNLOADED");
    expect(runtime.routes.listRoutes()).toEqual(routesBefore);
    await runtime.app.close();
  });

  it("moves a fixed route assignment to one recipe", async () => {
    const runtime = createHost();
    const response = await runtime.app.inject({
      method: "PUT",
      url: "/api/v1/management/routes/fast",
      payload: { displayName: "Fast", description: "Lowest-latency route", recipeId: "fake-best", enabled: true, isDefault: false },
    });
    const status = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });
    const fastRoutes = status.json().routes.filter((route: { id: string }) => route.id === "fast");
    expect(response.statusCode).toBe(200);
    expect(fastRoutes).toEqual([expect.objectContaining({ recipeId: "fake-best" })]);
    await runtime.app.close();
  });

  it("registers an arbitrary engine folder without writing into it", async () => {
    const engineRoot = await mkdtemp(join(tmpdir(), "fitz-engines-"));
    const engineFolder = join(engineRoot, "llama-custom");
    mkdirSync(engineFolder);
    const runtime = createHost({ engineRoot });
    try {
      const discovered = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });
      expect(discovered.json().engineFolders).toContainEqual(expect.objectContaining({ folderName: "llama-custom", registered: false }));
      const response = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/engines/llama-custom",
        payload: {
          displayName: "My llama.cpp fork",
          connectionMode: "managed",
          runtime: "wsl",
          baseUrl: "http://127.0.0.1:18080",
          healthPath: "/v1/models",
          launchCommand: "./build/bin/llama-server",
          launchArguments: ["--port", "{port}"],
          workingDirectory: ".",
          wslDistribution: "Ubuntu",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.rootPath).toBe(engineFolder);
      expect(readdirSync(engineFolder)).toEqual([]);
      const status = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });
      expect(status.json().engineRoot).toBe(engineRoot);
      expect(status.json().engines).toContainEqual(expect.objectContaining({ id: "llama-custom", connectionMode: "managed" }));
      expect(status.json().engineFolders).toContainEqual(expect.objectContaining({ folderName: "llama-custom", registered: true }));
    } finally {
      await runtime.app.close();
      rmSync(engineRoot, { recursive: true, force: true });
    }
  });

  it("updates an engine by its folder identity without duplicating a differently-cased id", async () => {
    const engineRoot = await mkdtemp(join(tmpdir(), "fitz-engines-case-"));
    mkdirSync(join(engineRoot, "ComfyUI"));
    const store = SqliteStore.memory();
    const timestamp = new Date(0).toISOString();
    store.upsertEngine({
      id: "comfyui", folderName: "ComfyUI", displayName: "comfyui", connectionMode: "managed", runtime: "windows",
      baseUrl: "http://127.0.0.1", healthPath: "/system_stats", launchCommand: "python", launchArguments: ["main.py"], workingDirectory: ".",
      createdAt: timestamp, updatedAt: timestamp,
    });
    const runtime = createHost({ engineRoot, store });
    try {
      const response = await runtime.app.inject({
        method: "PUT", url: "/api/v1/management/engines/ComfyUI",
        payload: {
          displayName: "comfyui", connectionMode: "managed", runtime: "windows",
          baseUrl: "http://127.0.0.1", healthPath: "/system_stats", launchCommand: "python", launchArguments: ["main.py"], workingDirectory: ".",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(store.listEngines()).toHaveLength(1);
      expect(store.getEngine("comfyui")).toMatchObject({ id: "comfyui", folderName: "ComfyUI" });
    } finally {
      await runtime.app.close();
      rmSync(engineRoot, { recursive: true, force: true });
    }
  });

  it("serves a non-streaming OpenAI-compatible completion and records lifecycle events", async () => {
    const runtime = createHost();
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "default",
        stream: false,
        messages: [{ role: "user", content: "hello Fitz" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().object).toBe("chat.completion");
    expect(response.json().choices[0].message.content).toContain("hello Fitz");
    expect(runtime.store.listInferenceRequests()).toEqual([
      expect.objectContaining({ status: "completed", routeId: "default" }),
    ]);

    const events = await runtime.app.inject({ method: "GET", url: "/api/v1/events?after=0" });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.length).toBeGreaterThan(0);
    expect(events.json().events.some((event: { type: string }) => event.type === "queue.updated")).toBe(
      true,
    );
    await runtime.app.close();
  });

  it("exposes persisted inference request history to administrators", async () => {
    const runtime = createHost({ adminToken: "test-token" });
    await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        stream: false,
        messages: [{ role: "user", content: "persist me" }],
      },
    });
    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/management/requests",
      headers: { "x-fitz-admin-token": "test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({ routeId: "fast", status: "completed" }),
    ]);
    await runtime.app.close();
  });

  it("streams SSE chunks and terminates with DONE", async () => {
    const runtime = createHost();
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        stream: true,
        messages: [{ role: "user", content: "stream this" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("chat.completion.chunk");
    const content = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: {") && line.includes("chat.completion.chunk"))
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "")
      .join("");
    expect(content).toContain("stream this");
    expect(response.body).toContain("data: [DONE]");
    await runtime.app.close();
  });

  it("guards management endpoints when an admin token is configured", async () => {
    const runtime = createHost({ adminToken: "test-token" });
    const denied = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });
    const allowed = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/management/status",
      headers: { "x-fitz-admin-token": "test-token" },
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    await runtime.app.close();
  });

  it("administers coordinated artifact storage, quota, backups, and staged restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "fitz-storage-admin-"));
    const paths = { dataRoot: root, databasePath: join(root, "fitz.db"), artifactsDir: join(root, "artifacts"), backupsDir: join(root, "backups") };
    const store = new SqliteStore(paths.databasePath);
    const artifacts = new ArtifactRepository(store, new LocalBlobStore(paths.artifactsDir), { quotaBytes: () => store.getSetting<number>("artifactStorageQuotaBytes") });
    await artifacts.initialize();
    store.createSession({ id: "storage-session", title: "Storage", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    await artifacts.create({ id: "storage-artifact", sessionId: "storage-session", name: "proof.txt", mimeType: "text/plain", kind: "text", createdAt: new Date(0).toISOString(), metadata: {} }, Buffer.from("durable"));
    const storageDurability = new StorageDurabilityService(artifacts, paths);
    const runtime = createHost({ store, artifacts, storageDurability, adminToken: "storage-token" });
    const headers = { "x-fitz-admin-token": "storage-token" };
    try {
      const status = await runtime.app.inject({ method: "GET", url: "/api/v1/management/storage", headers });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json().data.report).toEqual(expect.objectContaining({ artifacts: 1, objects: 1, referencedBytes: 7, issues: [] }));
      const quota = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/storage/quota", headers, payload: { quotaBytes: 1024 } });
      expect(quota.statusCode, quota.body).toBe(200);
      expect(store.getSetting("artifactStorageQuotaBytes")).toBe(1024);
      const backup = await runtime.app.inject({ method: "POST", url: "/api/v1/management/backups", headers });
      expect(backup.statusCode, backup.body).toBe(201);
      const backupId = backup.json().data.id as string;
      const validation = await runtime.app.inject({ method: "POST", url: `/api/v1/management/backups/${backupId}/validate`, headers });
      expect(validation.statusCode, validation.body).toBe(200);
      expect(validation.json().data.integrity).toBe("ok");
      const restore = await runtime.app.inject({ method: "POST", url: `/api/v1/management/backups/${backupId}/restore`, headers });
      expect(restore.statusCode, restore.body).toBe(200);
      expect(restore.json().data).toEqual(expect.objectContaining({ backupId, restartRequired: true }));
      expect(existsSync(join(root, "pending-storage-restore.json"))).toBe(true);
    } finally { await runtime.app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a load when the configured VRAM reserve cannot be maintained", async () => {
    const runtime = createHost({
      resourceMonitor: {
        snapshot: async () => ({
          capturedAt: new Date(0).toISOString(),
          totalRamMiB: 64_000,
          freeRamMiB: 32_000,
          totalVramMiB: 32_000,
          usedVramMiB: 31_000,
          freeVramMiB: 1_000,
          gpuTelemetryAvailable: true,
        }),
      },
      resourcePolicy: { reserveVramMiB: 2_048 },
    });
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "default",
        stream: false,
        messages: [{ role: "user", content: "should not load" }],
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("VRAM reserve cannot be maintained");
    expect(runtime.fakeAdapter?.starts).toHaveLength(0);
    await runtime.app.close();
  });

  it("exposes metrics and a redacted diagnostic bundle to administrators", async () => {
    const runtime = createHost({ adminToken: "diagnostic-test-token" });
    await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        stream: false,
        messages: [{ role: "user", content: "observe me" }],
      },
    });
    const headers = { "x-fitz-admin-token": "diagnostic-test-token" };
    const metrics = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/management/metrics",
      headers,
    });
    const diagnostics = await runtime.app.inject({
      method: "GET",
      url: "/api/v1/management/diagnostics",
      headers,
    });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().counters).toEqual(
      expect.objectContaining({
        inference_requests_completed_total: 1,
        model_loads_total: 1,
      }),
    );
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual(
      expect.objectContaining({
        versions: expect.objectContaining({ protocol: "1" }),
        metrics: expect.any(Object),
        recentRequests: [expect.objectContaining({ status: "completed" })],
        recentGpuWork: [expect.objectContaining({ kind: "chat", status: "completed" })],
      }),
    );
    expect(diagnostics.body).not.toContain("diagnostic-test-token");
    await runtime.app.close();
  });

  it("onboards private Tailscale Serve access through administrator endpoints", async () => {
    const calls: string[][] = [];
    const monitor = new TailscaleMonitor(async () => ({ stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "fitz.tail.test.", TailscaleIPs: ["100.64.0.1"] } }) }));
    const serve = new TailscaleServeManager(async (args) => { calls.push([...args]); return { stdout: JSON.stringify({ Web: { "fitz.tail.test:443": {} } }) }; });
    const store = SqliteStore.memory(); const security = new SecurityService(store, "remote-pepper"); const admin = security.createUser("Admin", "administrator"); const token = security.issueDevice(admin.id, "Console").token;
    const runtime = createHost({ store, security, authMode: "required", tailscaleMonitor: monitor, tailscaleServeManager: serve, localPort: 9999 });
    const headers = { authorization: `Bearer ${token}` };
    const status = await runtime.app.inject({ method: "GET", url: "/api/v1/management/connectivity/status", headers });
    const enabled = await runtime.app.inject({ method: "POST", url: "/api/v1/management/connectivity/tailscale-serve", headers, payload: {} });
    const disabled = await runtime.app.inject({ method: "DELETE", url: "/api/v1/management/connectivity/tailscale-serve", headers });
    expect(status.json().data).toEqual(expect.objectContaining({ tailscale: expect.objectContaining({ state: "connected", dnsName: "fitz.tail.test" }), serve: expect.objectContaining({ available: true }) }));
    expect(enabled.statusCode).toBe(200); expect(disabled.statusCode).toBe(204);
    expect(calls).toEqual([
      ["serve", "status", "--json"],
      ["serve", "--https=443", "--bg", "--yes", "http://127.0.0.1:9999"],
      ["serve", "status", "--json"],
      ["serve", "--https=443", "off"],
    ]);
    await runtime.app.close();
  });

  it("refuses to expose a host whose device authentication was explicitly disabled", async () => {
    let invoked = false;
    const serve = new TailscaleServeManager(async () => { invoked = true; return { stdout: "{}" }; });
    const runtime = createHost({ authMode: "disabled", adminToken: "development-token", tailscaleServeManager: serve });
    const response = await runtime.app.inject({ method: "POST", url: "/api/v1/management/connectivity/tailscale-serve", headers: { "x-fitz-admin-token": "development-token" }, payload: {} });
    expect(response.statusCode).toBe(409); expect(invoked).toBe(false);
    await runtime.app.close();
  });

  it("manages per-user Windows host startup without loading inference", async () => {
    let configured = false;
    const startup = new WindowsStartupManager("C:\\Fitz Host\\start-host.ps1", async (args) => {
      if (args[0] === "add") configured = true;
      if (args[0] === "delete") configured = false;
      if (args[0] === "query" && !configured) throw new Error("not found");
      return { stdout: configured ? "FitzCodexHost REG_SZ command" : "" };
    }, "win32", () => true);
    const runtime = createHost({ adminToken: "startup-test-token", startupManager: startup });
    const headers = { "x-fitz-admin-token": "startup-test-token" };
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/startup", headers })).json().data.configured).toBe(false);
    expect((await runtime.app.inject({ method: "POST", url: "/api/v1/management/startup", headers })).json().data.configured).toBe(true);
    expect((await runtime.app.inject({ method: "GET", url: "/health" })).json().engine.state).toBe("UNLOADED");
    expect((await runtime.app.inject({ method: "DELETE", url: "/api/v1/management/startup", headers })).json().data.configured).toBe(false);
    await runtime.app.close();
  });

  it("requires device authentication and filters routes by grants", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const user = security.createUser("Consumer"); security.setRouteGrants(user.id, ["fast"]); const { token } = security.issueDevice(user.id, "Browser");
    const runtime = createHost({ store, security, authMode: "required" });
    const denied = await runtime.app.inject({ method: "GET", url: "/v1/models" });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${token}` } });
    const forbidden = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${token}` }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    expect(denied.statusCode).toBe(401); expect(models.json().data.map((model: { id: string }) => model.id)).toEqual(["fast"]); expect(forbidden.statusCode).toBe(403); await runtime.app.close();
  });

  it("accepts the private Pi credential only on chat completions", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const runtime = createHost({ store, security, authMode: "required", internalAgentToken: "private-pi-token" });
    const denied = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer wrong" }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    const completion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer private-pi-token" }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer private-pi-token" } });
    expect(denied.statusCode).toBe(401); expect(completion.statusCode).toBe(200); expect(models.statusCode).toBe(401); await runtime.app.close();
  });

  it("allows administrators to provision and revoke devices with audit history", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const admin = security.createUser("Admin", "administrator"); const { token } = security.issueDevice(admin.id, "Console"); const runtime = createHost({ store, security, authMode: "required" }); const headers = { authorization: `Bearer ${token}` };
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/management/users", headers, payload: { displayName: "Agent", role: "agent" } });
    const issued = await runtime.app.inject({ method: "POST", url: `/api/v1/management/users/${created.json().data.id}/devices`, headers, payload: { name: "Laptop" } }); const me = await runtime.app.inject({ method: "GET", url: "/api/v1/me", headers }); expect(me.json().data).toEqual(expect.objectContaining({ authMode: "required", user: expect.objectContaining({ role: "administrator" }) })); const access = await runtime.app.inject({ method: "GET", url: `/api/v1/management/users/${created.json().data.id}/access`, headers }); expect(access.json().data).toEqual(expect.objectContaining({ devices: [expect.objectContaining({ id: issued.json().data.device.id })], routeIds: [], quota: expect.objectContaining({ maxRequestsPerMinute: expect.any(Number) }), currentDeviceId: me.json().data.device.id }));
    expect(created.statusCode).toBe(201); expect(issued.statusCode).toBe(201); expect(issued.json().data.token).toMatch(/^fitz_/);
    const revoked = await runtime.app.inject({ method: "DELETE", url: `/api/v1/management/devices/${issued.json().data.device.id}`, headers }); const audit = await runtime.app.inject({ method: "GET", url: "/api/v1/management/audit-events", headers });
    expect(revoked.statusCode).toBe(204); expect(audit.json().data.map((event: { action: string }) => event.action)).toEqual(expect.arrayContaining(["user.created", "device.issued", "device.revoked"])); await runtime.app.close();
  });

  it("persists native agent events and resumes after a sequence", async () => {
    const runtime = createHost();
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", messages: [{ role: "user", content: "native protocol" }], max_tokens: 64 } });
    expect(created.statusCode).toBe(202); const runId = created.json().data.id as string;
    let run = runtime.agentRuns.get(runId); for (let attempt = 0; attempt < 50 && run?.status !== "completed"; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); run = runtime.agentRuns.get(runId); }
    expect(run?.status).toBe("completed");
    const all = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events?after=0` }); const events = all.json().events as { sequence: number; type: string }[];
    expect(events[0]?.type).toBe("run.created"); expect(events.at(-1)?.type).toBe("run.completed");
    const resumed = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events?after=2` }); expect(resumed.json().events.every((event: { sequence: number }) => event.sequence > 2)).toBe(true);
    const sse = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events`, headers: { accept: "text/event-stream", "last-event-id": "2" } }); expect(sse.statusCode).toBe(200); expect(sse.body).toContain("event: run.completed"); expect(sse.body).not.toContain("id: 1\n"); await runtime.app.close();
  });

  it("returns the original run when creation is retried with the same client request identity", async () => {
    const runtime = createHost();
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Idempotent" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Once" } });
    const payload = { model: "fast", sessionId: session.json().data.id, clientRequestId: "desktop:stable-request", messages: [{ role: "user", content: "run once" }] };
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload });
    const retried = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload });
    expect(first.statusCode).toBe(202);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(expect.objectContaining({ idempotentReplay: true, data: expect.objectContaining({ id: first.json().data.id }) }));
    expect(runtime.agentRuns.list().filter((run) => run.id === first.json().data.id)).toHaveLength(1);
    expect(runtime.store.transcriptAfter(session.json().data.id, 0).filter((entry) => entry.role === "user" && entry.content.text === "run once")).toHaveLength(1);
    await runtime.app.close();
  });

  it("continues a failed run exactly once from its durable checkpoint", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "resume-project", name: "Resume", createdAt: now, updatedAt: now });
    store.createSession({ id: "resume-session", projectId: "resume-project", title: "Resume", status: "active", createdAt: now, updatedAt: now });
    store.createAgentRun({ id: "failed-run", routeId: "fast", sessionId: "resume-session", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, { model: "fast", sessionId: "resume-session", accessMode: "full", messages: [{ role: "user", content: "finish the task" }] });
    store.appendAgentEvent({ protocolVersion: "1", runId: "failed-run", sequence: 1, timestamp: now, type: "run.started", data: {} });
    store.appendAgentEvent({ protocolVersion: "1", runId: "failed-run", sequence: 2, timestamp: now, type: "tool.started", data: { toolCallId: "read-1", toolName: "read", input: { path: "README.md" } } });
    store.appendAgentEvent({ protocolVersion: "1", runId: "failed-run", sequence: 3, timestamp: now, type: "tool.completed", data: { toolCallId: "read-1", toolName: "read", result: "ok", isError: false } });
    store.updateAgentRun("failed-run", "failed", "connection_lost");
    store.appendAgentEvent({ protocolVersion: "1", runId: "failed-run", sequence: 4, timestamp: now, type: "run.failed", data: { error: "connection_lost" } });
    const seen: string[] = [];
    const runtime = createHost({ store, agentRuntime: { id: "resume-agent", run: (request) => { seen.push(String(request.messages.at(-1)?.content ?? "")); const events = (async function* () { yield { type: "assistant.delta" as const, text: "Recovered." }; })(); return Object.assign(events, { cancel: () => undefined }); } } });
    try {
      const state = await runtime.app.inject({ method: "GET", url: "/api/v1/sessions/resume-session/agent-run-state" });
      expect(state.json().data).toEqual(expect.objectContaining({ id: "failed-run", resumable: true, checkpoint: expect.objectContaining({ resumeSafety: "safe" }) }));
      const resumed = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs/failed-run/resume", payload: {} });
      expect(resumed.statusCode, resumed.body).toBe(202); expect(resumed.json().data.resumeOfRunId).toBe("failed-run");
      for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(resumed.json().data.id)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(seen.at(-1)).toContain("do not blindly repeat mutations");
      const replayedResume = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs/failed-run/resume", payload: {} });
      expect(replayedResume.statusCode).toBe(200);
      expect(replayedResume.json()).toEqual(expect.objectContaining({ idempotentReplay: true, data: expect.objectContaining({ id: resumed.json().data.id }) }));
    } finally { await runtime.app.close(); }
  });

  it("requires explicit review before continuing a run with an in-flight tool", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "unsafe-project", name: "Unsafe", createdAt: now, updatedAt: now });
    store.createSession({ id: "unsafe-session", projectId: "unsafe-project", title: "Unsafe", status: "active", createdAt: now, updatedAt: now });
    store.createAgentRun({ id: "unsafe-run", routeId: "fast", sessionId: "unsafe-session", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, { model: "fast", sessionId: "unsafe-session", accessMode: "full", messages: [{ role: "user", content: "publish the result" }] });
    store.appendAgentEvent({ protocolVersion: "1", runId: "unsafe-run", sequence: 1, timestamp: now, type: "run.started", data: {} });
    store.appendAgentEvent({ protocolVersion: "1", runId: "unsafe-run", sequence: 2, timestamp: now, type: "tool.started", data: { toolCallId: "publish-1", toolName: "publish", input: { target: "remote" } } });
    store.updateAgentRun("unsafe-run", "failed", "connection_lost");
    store.appendAgentEvent({ protocolVersion: "1", runId: "unsafe-run", sequence: 3, timestamp: now, type: "run.failed", data: { error: "connection_lost" } });
    const runtime = createHost({ store, agentRuntime: { id: "review-agent", run: () => { const events = (async function* () { yield { type: "assistant.delta" as const, text: "Verified and continued." }; })(); return Object.assign(events, { cancel: () => undefined }); } } });
    try {
      const state = await runtime.app.inject({ method: "GET", url: "/api/v1/sessions/unsafe-session/agent-run-state" });
      expect(state.json().data).toEqual(expect.objectContaining({ checkpoint: expect.objectContaining({ resumeSafety: "review-required", inFlightTools: [expect.objectContaining({ toolCallId: "publish-1" })] }) }));
      const rejected = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs/unsafe-run/resume", payload: {} });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toEqual(expect.objectContaining({ requiresConfirmation: true }));
      expect(store.agentRunResumedFrom("unsafe-run")).toBeUndefined();
      const confirmed = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs/unsafe-run/resume", payload: { confirmUnsafe: true } });
      expect(confirmed.statusCode, confirmed.body).toBe(202);
      expect(confirmed.json().data.resumeOfRunId).toBe("unsafe-run");
    } finally { await runtime.app.close(); }
  });

  it("routes native runs through a configured agent runtime", async () => {
    const runtime = createHost({ agentRuntime: { id: "test-agent", run: () => { const events = (async function* () { yield { type: "assistant.delta" as const, text: "I will inspect it." }; yield { type: "tool.started" as const, toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } }; yield { type: "tool.completed" as const, toolCallId: "tool-1", toolName: "read", result: "ok", isError: false }; yield { type: "assistant.delta" as const, text: "Inspection complete." }; })(); return Object.assign(events, { cancel: () => undefined }); } } });
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Agent" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Activity" } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId: session.json().data.id, messages: [{ role: "user", content: "use agent" }] } }); const runId = created.json().data.id;
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events` });
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual(["run.created", "run.queue.updated", "run.queue.updated", "run.started", "assistant.delta", "tool.started", "tool.completed", "assistant.delta", "run.completed"]);
    expect(replay.json().events.find((event: { type: string }) => event.type === "tool.started").data.input).toEqual({ path: "README.md" });
    const transcript = runtime.store.transcriptAfter(session.json().data.id, 0);
    expect(transcript.map((entry) => [entry.kind, entry.content.phase ?? entry.content.toolName])).toEqual([
      ["message", undefined], ["message", "commentary"], ["tool-call", "read"], ["tool-result", "read"], ["message", "final"],
    ]);
    expect(transcript.find((entry) => entry.kind === "tool-call")?.content.input).toEqual({ path: "README.md" });
    expect(transcript.find((entry) => entry.kind === "tool-result")?.content.result).toBe("ok");
    await runtime.app.close();
  });

  it("streams reasoning as its own event stream and persists it under its own transcript kind", async () => {
    const runtime = createHost({ agentRuntime: { id: "thinking-agent", run: () => { const events = (async function* () {
      yield { type: "reasoning.delta" as const, text: "Let me " };
      yield { type: "reasoning.delta" as const, text: "inspect it." };
      yield { type: "reasoning.completed" as const };
      yield { type: "assistant.delta" as const, text: "I will inspect it." };
      yield { type: "tool.started" as const, toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } };
      yield { type: "tool.completed" as const, toolCallId: "tool-1", toolName: "read", result: "ok", isError: false };
      yield { type: "assistant.delta" as const, text: "Inspection complete." };
    })(); return Object.assign(events, { cancel: () => undefined }); } } });
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Thinking" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Reasoning" } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId: session.json().data.id, messages: [{ role: "user", content: "think then act" }] } }); const runId = created.json().data.id;
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events` });
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual(["run.created", "run.queue.updated", "run.queue.updated", "run.started", "reasoning.delta", "reasoning.delta", "reasoning.completed", "assistant.delta", "tool.started", "tool.completed", "assistant.delta", "run.completed"]);
    const transcript = runtime.store.transcriptAfter(session.json().data.id, 0);
    expect(transcript.map((entry) => [entry.kind, entry.role])).toEqual([
      ["message", "user"], ["reasoning", "assistant"], ["message", "assistant"], ["tool-call", "tool"], ["tool-result", "tool"], ["message", "assistant"],
    ]);
    expect(transcript.find((entry) => entry.kind === "reasoning")?.content.text).toBe("Let me inspect it.");
    expect(transcript.filter((entry) => entry.kind === "message").some((entry) => entry.content.text?.includes("Let me inspect it."))).toBe(false);
    await runtime.app.close();
  });

  it("inserts a steering message into the running conversation and records it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const steered: string[] = [];
    const runtime = createHost({ agentRuntime: { id: "steerable-agent", run: () => {
      const events = (async function* () {
        yield { type: "assistant.delta" as const, text: "working on it" };
        await gate;
        yield { type: "user.steer" as const, text: "focus on tests" };
        yield { type: "assistant.delta" as const, text: "done" };
      })();
      return Object.assign(events, { cancel: () => undefined, steer: (text: string) => { steered.push(text); } });
    } } });
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Steer" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Steering" } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId: session.json().data.id, messages: [{ role: "user", content: "begin" }] } });
    const runId = created.json().data.id as string;
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const steeredResponse = await runtime.app.inject({ method: "POST", url: `/api/v1/agent/runs/${runId}/steer`, payload: { text: "focus on tests" } });
    expect(steeredResponse.statusCode, steeredResponse.body).toBe(200);
    expect(steeredResponse.json().data).toEqual({ id: runId, steered: true });
    expect(steered).toEqual(["focus on tests"]);
    release();
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.agentRuns.get(runId)?.status).toBe("completed");
    const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events` });
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["user.steer"]));
    expect(replay.json().events.find((event: { type: string }) => event.type === "user.steer").data.text).toBe("focus on tests");
    const transcript = runtime.store.transcriptAfter(session.json().data.id, 0);
    expect(transcript.some((entry) => entry.role === "user" && entry.content.text === "focus on tests")).toBe(true);
    await runtime.app.close();
  });

  it("rejects steering a queued run, an unknown run, or an empty message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createHost({ agentRuntime: { id: "steerable-agent", run: () => {
      const events = (async function* () { await gate; yield { type: "assistant.delta" as const, text: "done" }; })();
      return Object.assign(events, { cancel: () => undefined, steer: () => undefined });
    } } });
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", messages: [{ role: "user", content: "first" }] } });
    const second = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "smart", messages: [{ role: "user", content: "second" }] } });
    const firstId = first.json().data.id as string; const secondId = second.json().data.id as string;
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(firstId)?.status !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = await runtime.app.inject({ method: "POST", url: `/api/v1/agent/runs/${secondId}/steer`, payload: { text: "nope" } });
    expect(queued.statusCode).toBe(409);
    const unknown = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs/missing/steer", payload: { text: "nope" } });
    expect(unknown.statusCode).toBe(404);
    const empty = await runtime.app.inject({ method: "POST", url: `/api/v1/agent/runs/${firstId}/steer`, payload: { text: "   " } });
    expect(empty.statusCode).toBe(400);
    release();
    for (let attempt = 0; attempt < 50 && (runtime.agentRuns.get(firstId)?.status !== "completed" || runtime.agentRuns.get(secondId)?.status !== "completed"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.app.close();
  });

  it("serializes whole native agent tasks and exposes cancellable queue positions", async () => {
    const releases = new Map<string, () => void>(); const started: string[] = [];
    const runtime = createHost({ agentRuntime: { id: "queued-agent", run: (request) => {
      const label = request.messages.at(-1)?.content ?? "unknown"; started.push(label); let release = () => undefined; const gate = new Promise<void>((resolve) => { release = resolve; }); releases.set(label, release);
      const events = (async function* () { await gate; yield { type: "assistant.delta" as const, text: `done ${label}` }; })(); return Object.assign(events, { cancel: release });
    } } });
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", messages: [{ role: "user", content: "first" }] } });
    const second = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "smart", messages: [{ role: "user", content: "second" }] } });
    expect(started).toEqual(["first"]);
    const initial = await runtime.app.inject({ method: "GET", url: "/api/v1/work/queue" });
    expect(initial.json().data).toEqual([
      expect.objectContaining({ id: first.json().data.id, kind: "agent", lane: "gpu", status: "running", position: 0, depth: 2 }),
      expect.objectContaining({ id: second.json().data.id, kind: "agent", lane: "gpu", status: "queued", position: 1, depth: 2 }),
    ]);
    const cancelled = await runtime.app.inject({ method: "DELETE", url: `/api/v1/agent/runs/${second.json().data.id}` }); expect(cancelled.statusCode).toBe(202); expect(runtime.agentRuns.get(second.json().data.id)?.status).toBe("cancelled"); expect(started).toEqual(["first"]);
    const third = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "third" }] } });
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/work/queue" })).json().data.at(-1)).toEqual(expect.objectContaining({ id: third.json().data.id, status: "queued", position: 1 }));
    releases.get("first")?.(); for (let attempt = 0; attempt < 50 && !started.includes("third"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(started).toEqual(["first", "third"]);
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/work/queue" })).json().data).toEqual([expect.objectContaining({ id: third.json().data.id, status: "running", position: 0, depth: 1 })]);
    releases.get("third")?.(); for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(third.json().data.id)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); await runtime.app.close();
  });

  it("rejects excess agent turns with bounded backpressure before creating durable state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createHost({
      agentQueueCapacity: 2,
      agentRuntime: {
        id: "bounded-agent",
        run: () => {
          const events = (async function* () { await gate; yield { type: "assistant.delta" as const, text: "done" }; })();
          return Object.assign(events, { cancel: () => release() });
        },
      },
    });
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", messages: [{ role: "user", content: "first" }] } });
    const second = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "smart", messages: [{ role: "user", content: "second" }] } });
    const overflow = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "overflow" }] } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(overflow.statusCode).toBe(429);
    expect(overflow.headers["retry-after"]).toBe("2");
    expect(overflow.json().error).toMatchObject({ code: "resource_busy", retryable: true });
    expect(overflow.json().error.message).toContain("capacity");
    expect(runtime.agentRuns.list()).toHaveLength(2);
    release();
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.list().some((run) => run.status === "queued" || run.status === "running"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.app.close();
  });

  it("creates projects and sessions and records a canonical run transcript", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Fitz", rootPath: "C:\\work\\fitz" } }); const projectId = project.json().data.id; expect(project.json().data.rootPath).toBe("C:\\work\\fitz");
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Infrastructure" } }); const sessionId = session.json().data.id;
    const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId, messages: [{ role: "user", content: "persist this turn" }] } }); const runId = run.json().data.id; for (let attempt = 0; attempt < 400 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.agentRuns.get(runId)?.status).toBe("completed");
    const transcript = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript` }); expect(transcript.json().data).toEqual([expect.objectContaining({ sequence: 1, role: "user", content: expect.objectContaining({ text: "persist this turn" }) }), expect.objectContaining({ sequence: 2, role: "assistant", content: expect.objectContaining({ runId }) })]); await runtime.app.close();
  });

  it("opens long conversations at the latest page and pages backward in sequence order", async () => {
    const runtime = createHost();
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Long transcript" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Long" } });
    const sessionId = session.json().data.id as string;
    for (let index = 1; index <= 620; index += 1) runtime.store.appendTranscriptEntry({ id: `page-${index}`, sessionId, kind: "message", role: index % 2 ? "user" : "assistant", content: { text: `message-${index}` }, createdAt: new Date(index).toISOString() });
    const latest = (await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript?limit=250` })).json();
    expect(latest.data).toHaveLength(250);
    expect(latest.data.at(0).sequence).toBe(371);
    expect(latest.data.at(-1).sequence).toBe(620);
    expect(latest.page).toEqual(expect.objectContaining({ hasEarlier: true, oldestSequence: 371, newestSequence: 620 }));
    const earlier = (await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript?before=371&limit=250` })).json();
    expect(earlier.data.at(0).sequence).toBe(121);
    expect(earlier.data.at(-1).sequence).toBe(370);
    expect(earlier.page.hasEarlier).toBe(true);
    await runtime.app.close();
  });

  it("creates and lists standalone chats with no project attached", async () => {
    const runtime = createHost();
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Wrapped" } }); const projectId = project.json().data.id;
    await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Wrapped chat" } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Standalone" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toEqual(expect.objectContaining({ title: "Standalone", status: "active", routeId: "default" }));
    expect(created.json().data.projectId).toBeUndefined();
    const listed = await runtime.app.inject({ method: "GET", url: "/api/v1/chats" });
    expect(listed.json().data).toEqual([expect.objectContaining({ id: created.json().data.id, title: "Standalone" })]);
    const projectSessions = await runtime.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/sessions` });
    expect(projectSessions.json().data).toEqual([expect.objectContaining({ title: "Wrapped chat" })]);
    await runtime.app.close();
  });

  it("removes a project without touching its source folder", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Disposable", rootPath: "C:\\work\\disposable" } }); const projectId = project.json().data.id; await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Temporary" } }); const removed = await runtime.app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` }); expect(removed.statusCode).toBe(204); expect((await runtime.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}` })).statusCode).toBe(404); await runtime.app.close(); });

  it("permanently removes an idle chat and its artifact metadata", async () => { const runtime = createHost(); const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Disposable" } }); const sessionId = session.json().data.id as string; const artifact = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("temporary").toString("base64") } }); const artifactId = artifact.json().data.id as string; const removed = await runtime.app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}` }); expect(removed.statusCode).toBe(204); expect((await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` })).statusCode).toBe(404); expect(runtime.store.getArtifact(artifactId)).toBeUndefined(); await runtime.app.close(); });

  it("refuses to remove a chat while its request is active", async () => { const runtime = createHost(); const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Busy" } }); const sessionId = session.json().data.id as string; const now = Date.now(); runtime.store.createAgentRun({ id: "busy-run", routeId: "default", sessionId, status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, { model: "default", sessionId, accessMode: "full", messages: [{ role: "user", content: "keep working" }] }); const removed = await runtime.app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}` }); expect(removed.statusCode).toBe(409); expect((await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` })).statusCode).toBe(200); await runtime.app.close(); });

  it("applies tool policy before creating a durable approval decision", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Tools" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Approval" } }); const sessionId = session.json().data.id;
    await runtime.app.inject({ method: "PUT", url: "/api/v1/management/tool-policies/role/consumer/bash", payload: { decision: "deny" } });
    const pending = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/tool-approvals`, payload: { toolCallId: "read-1", toolName: "read", request: { path: "README.md" } } }); expect(pending.json().data.status).toBe("pending");
    const decided = await runtime.app.inject({ method: "POST", url: `/api/v1/tool-approvals/${pending.json().data.id}/decision`, payload: { decision: "approved" } }); expect(decided.json().data.status).toBe("approved"); await runtime.app.close();
  });

  it("validates editable media approval fields while preserving host-owned routing", async () => {
    const runtime = createHost();
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Media approvals" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Video" } });
    const pending = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${session.json().data.id}/tool-approvals`, payload: { toolCallId: "video-1", toolName: "generate_video", request: { prompt: "draft", duration_seconds: 8, route_id: "video" } } });
    const decided = await runtime.app.inject({ method: "POST", url: `/api/v1/tool-approvals/${pending.json().data.id}/decision`, payload: { decision: "approved", request: { prompt: "revised", duration_seconds: 4, resolution: "1344x768", fps: 24, route_id: "attacker-route" } } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().data.request).toEqual({ prompt: "revised", duration_seconds: 4, resolution: "1344x768", fps: 24, route_id: "video" });
    await runtime.app.close();
  });

  it("isolates projects between authenticated users", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const first = security.createUser("First"); const second = security.createUser("Second"); const firstToken = security.issueDevice(first.id, "One").token; const secondToken = security.issueDevice(second.id, "Two").token; const runtime = createHost({ store, security, authMode: "required" });
    await runtime.app.inject({ method: "POST", url: "/api/v1/projects", headers: { authorization: `Bearer ${firstToken}` }, payload: { name: "Private" } }); const visible = await runtime.app.inject({ method: "GET", url: "/api/v1/projects", headers: { authorization: `Bearer ${secondToken}` } }); expect(visible.json().data).toEqual([]); await runtime.app.close();
  });

  it("compacts oversized canonical session history before a native run", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "context-project", name: "Context", createdAt: now, updatedAt: now }); store.createSession({ id: "context-session", projectId: "context-project", title: "Long", status: "active", createdAt: now, updatedAt: now }); store.appendTranscriptEntry({ id: "old", sessionId: "context-session", kind: "message", role: "user", content: { text: "x".repeat(400_000) }, createdAt: now }); const runtime = createHost({ store });
    const response = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId: "context-session", messages: [{ role: "user", content: "continue" }] } }); expect(response.statusCode).toBe(202); expect(response.json().context.compacted).toBe(true); const transcript = store.transcriptAfter("context-session", 0); expect(transcript.some((entry) => entry.kind === "compaction")).toBe(true); expect(transcript.some((entry) => entry.role === "user" && entry.content.text === "continue")).toBe(true); await runtime.app.close();
  });

  it("manually compacts a session into a reusable context checkpoint", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Context" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Long" } }); const sessionId = session.json().data.id;
    runtime.store.appendTranscriptEntry({ id: "manual-context", sessionId, kind: "message", role: "user", content: { text: "preserve this context" }, createdAt: new Date().toISOString() }); const compacted = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact`, payload: { model: "default" } });
    expect(compacted.statusCode).toBe(200); expect(compacted.json().data).toEqual(expect.objectContaining({ originalMessageCount: 1, estimatedContextTokens: expect.any(Number) })); expect(runtime.store.transcriptAfter(sessionId, 0).at(-1)).toEqual(expect.objectContaining({ kind: "compaction", content: expect.objectContaining({ manual: true, throughSequence: 1 }) })); await runtime.app.close();
  });

  it("issues and redeems one-time pairing codes without pre-authentication", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pairing-pepper"); const admin = security.createUser("Admin", "administrator"); const adminToken = security.issueDevice(admin.id, "Console").token; const runtime = createHost({ store, security, authMode: "required" }); const headers = { authorization: `Bearer ${adminToken}` };
    const issued = await runtime.app.inject({ method: "POST", url: "/api/v1/management/pairing-codes", headers, payload: { intendedRole: "consumer", ttlSeconds: 60 } }); expect(issued.statusCode).toBe(201); const code = issued.json().data.code;
    const redeemed = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/redeem", payload: { code, displayName: "Remote", deviceName: "Phone" } }); expect(redeemed.statusCode).toBe(201); const token = redeemed.json().data.token; const authenticated = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${token}` } }); expect(authenticated.statusCode).toBe(200); expect(authenticated.json().data.map((model: { id: string }) => model.id).sort()).toEqual(["default", "fast", "smart"]);
    const replay = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/redeem", payload: { code, displayName: "Replay", deviceName: "Other" } }); expect(replay.statusCode).toBe(403); await runtime.app.close();
  });

  it("bootstraps the first administrator only from a direct loopback request", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "bootstrap-pepper"); const runtime = createHost({ store, security, authMode: "required" });
    const proxied = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/bootstrap", headers: { "x-forwarded-for": "100.64.0.2" } });
    expect(proxied.statusCode).toBe(403); expect(store.listUsers()).toEqual([]);
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/bootstrap" });
    expect(created.statusCode).toBe(201); expect(created.json().data.token).toMatch(/^fitz_/); expect(created.json().data.user.role).toBe("administrator");
    const authenticated = await runtime.app.inject({ method: "GET", url: "/api/v1/me", headers: { authorization: `Bearer ${created.json().data.token}` } });
    expect(authenticated.statusCode).toBe(200); expect(authenticated.json().data.user.role).toBe("administrator");
    const replay = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/bootstrap" });
    expect(replay.statusCode).toBe(409);
    await runtime.app.close();
  });

  it("stores bounded artifacts and serves content with defensive headers", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Artifacts" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Preview" } }); const sessionId = session.json().data.id;
    const created = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("hello").toString("base64") } }); expect(created.statusCode).toBe(201); expect(created.json().data).toEqual(expect.objectContaining({ kind: "text", byteSize: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })); const content = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${created.json().data.id}/content` }); expect(content.body).toBe("hello"); expect(content.headers["x-content-type-options"]).toBe("nosniff"); expect(content.headers["content-disposition"]).toContain("attachment"); const removed = await runtime.app.inject({ method: "DELETE", url: `/api/v1/artifacts/${created.json().data.id}` }); expect(removed.statusCode).toBe(204); expect((await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/artifacts` })).json().data).toEqual([]); await runtime.app.close(); });

  it("accepts artifacts up to the 5 MB bound and rejects larger ones", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Limits" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Limits" } }); const sessionId = session.json().data.id;
    const accepted = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "medium.pdf", mimeType: "application/pdf", contentBase64: Buffer.alloc(2_000_000, 1).toString("base64") } }); expect(accepted.statusCode).toBe(201); expect(accepted.json().data).toEqual(expect.objectContaining({ kind: "pdf", byteSize: 2_000_000 }));
    const rejected = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "big.pdf", mimeType: "application/pdf", contentBase64: Buffer.alloc(5_000_001, 1).toString("base64") } }); expect(rejected.statusCode).toBe(400); expect(String(rejected.json().error.message)).toContain("byte limit"); await runtime.app.close(); });

  it("serves artifact content with single-range byte support", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Range" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Range" } }); const body = "0123456789abcdef"; const created = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${session.json().data.id}/artifacts`, payload: { name: "range.bin", mimeType: "application/octet-stream", contentBase64: Buffer.from(body).toString("base64") } }); const artifactId = created.json().data.id as string; const url = `/api/v1/artifacts/${artifactId}/content`;
    const full = await runtime.app.inject({ method: "GET", url }); expect(full.statusCode).toBe(200); expect(full.body).toBe(body); expect(full.headers["accept-ranges"]).toBe("bytes"); expect(full.headers["x-content-type-options"]).toBe("nosniff"); expect(full.headers["content-disposition"]).toContain("attachment");
    const head = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=0-4" } }); expect(head.statusCode).toBe(206); expect(head.body).toBe("01234"); expect(head.headers["content-range"]).toBe("bytes 0-4/16"); expect(head.headers["accept-ranges"]).toBe("bytes"); expect(head.headers["x-content-type-options"]).toBe("nosniff");
    const tail = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=-4" } }); expect(tail.statusCode).toBe(206); expect(tail.body).toBe("cdef"); expect(tail.headers["content-range"]).toBe("bytes 12-15/16");
    const openEnded = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=6-" } }); expect(openEnded.statusCode).toBe(206); expect(openEnded.body).toBe("6789abcdef");
    const clamped = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=14-99" } }); expect(clamped.statusCode).toBe(206); expect(clamped.body).toBe("ef"); expect(clamped.headers["content-range"]).toBe("bytes 14-15/16");
    const single = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=0-0" } }); expect(single.statusCode).toBe(206); expect(single.body).toBe("0"); expect(single.headers["content-range"]).toBe("bytes 0-0/16");
    const unsatisfiable = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=99-" } }); expect(unsatisfiable.statusCode).toBe(416); expect(unsatisfiable.headers["content-range"]).toBe("bytes */16");
    const inverted = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=5-2" } }); expect(inverted.statusCode).toBe(416);
    // Multi-range sets and malformed/star ranges are ignored per RFC 7233 §3.1 → full body.
    const multi = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=0-1,4-5" } }); expect(multi.statusCode).toBe(200); expect(multi.body).toBe(body);
    const star = await runtime.app.inject({ method: "GET", url, headers: { range: "bytes=*" } }); expect(star.statusCode).toBe(200); expect(star.body).toBe(body);
    await runtime.app.close(); });

  it("rejects range requests against empty artifact content", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Empty" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Empty" } }); const sessionId = session.json().data.id;
    await runtime.artifacts.create({ id: "empty-artifact", sessionId, name: "empty.bin", mimeType: "application/octet-stream", kind: "binary", createdAt: new Date().toISOString(), metadata: {} }, new Uint8Array(0));
    const ranged = await runtime.app.inject({ method: "GET", url: "/api/v1/artifacts/empty-artifact/content", headers: { range: "bytes=0-0" } }); expect(ranged.statusCode).toBe(416); expect(ranged.headers["content-range"]).toBe("bytes */0");
    const full = await runtime.app.inject({ method: "GET", url: "/api/v1/artifacts/empty-artifact/content" }); expect(full.statusCode).toBe(200); expect(full.body).toBe(""); await runtime.app.close(); });

  it("exposes the Hugging Face model catalog to administrators", async () => {
    const modelRoot = await mkdtemp(join(tmpdir(), "fitz-models-"));
    const requested: string[] = [];
    const runtime = createHost({
      adminToken: "model-test-token",
      modelCatalog: new ModelCatalogService({
        modelRoot,
        fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return new Response(JSON.stringify({ count: 1, items: [{ id: "Qwen/Qwen2.5-7B-Instruct-GGUF", downloads: 10, likes: 2, pipeline_tag: "text-generation", createdAt: new Date().toISOString() }] }), { status: 200 }); },
      }),
    });
    try {
      const denied = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog" });
      expect(denied.statusCode).toBe(403);
      const headers = { "x-fitz-admin-token": "model-test-token" };
      const response = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?query=qwen&pipeline=feature-extraction", headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual({ total: 1, models: [expect.objectContaining({ id: "Qwen/Qwen2.5-7B-Instruct-GGUF" })] });
      expect(requested.some((url) => url.includes("pipeline_tag=feature-extraction"))).toBe(true);
      // The shared sort/direction params pass through to the upstream fetch.
      const sorted = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?sort=updated&direction=asc", headers });
      expect(sorted.statusCode, sorted.body).toBe(200);
      expect(requested.some((url) => url.includes("sort=lastModified") && url.includes("direction=1"))).toBe(true);
      // Unknown sort keys fall back to the store default rather than erroring.
      const unknownSort = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?sort=bogus", headers });
      expect(unknownSort.statusCode, unknownSort.body).toBe(200);
      // Minimum likes/downloads drop models below the thresholds before they reach the client.
      const filtered = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?min_likes=5&min_downloads=100", headers });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().data).toEqual({ total: 0, models: [] });
      const kept = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?min_likes=1&min_downloads=10", headers });
      expect(kept.statusCode, kept.body).toBe(200);
      expect(kept.json().data.models.map((model: { id: string }) => model.id)).toEqual(["Qwen/Qwen2.5-7B-Instruct-GGUF"]);
      // Models released more than N weeks ago (or dateless) are dropped too.
      const recent = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?released_within_weeks=4", headers });
      expect(recent.statusCode, recent.body).toBe(200);
      expect(recent.json().data.models.map((model: { id: string }) => model.id)).toEqual(["Qwen/Qwen2.5-7B-Instruct-GGUF"]);
    } finally {
      await runtime.app.close();
      rmSync(modelRoot, { recursive: true, force: true });
    }
  });

  it("downloads a Hugging Face model through the management API", async () => {
    const modelRoot = await mkdtemp(join(tmpdir(), "fitz-models-"));
    const runtime = createHost({
      adminToken: "model-test-token",
      modelCatalog: new ModelCatalogService({
        modelRoot,
        fetch: async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/resolve/")) {
            const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("hello world")); controller.close(); } });
            return new Response(stream, { status: 200, headers: { "content-length": "11" } });
          }
          if (url.includes("/api/models/")) return new Response(JSON.stringify({ siblings: [{ rfilename: "model-q4_k_m.gguf", size: 11 }] }), { status: 200 });
          return new Response("{}", { status: 404 });
        },
      }),
    });
    try {
      const headers = { "x-fitz-admin-token": "model-test-token" };
      const started = await runtime.app.inject({ method: "POST", url: "/api/v1/management/models/download", headers, payload: { repo: "Qwen/Qwen2.5-7B-Instruct-GGUF" } });
      expect(started.statusCode, started.body).toBe(202);
      const id = started.json().data.id as string;
      let record = started.json().data as { status: string };
      for (let i = 0; i < 100 && record.status === "active"; i++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        record = (await runtime.app.inject({ method: "GET", url: `/api/v1/management/models/downloads/${id}`, headers })).json().data as { status: string };
      }
      expect(record.status).toBe("done");
      const modelPath = join(modelRoot, "Qwen", "Qwen2.5-7B-Instruct-GGUF", "model-q4_k_m.gguf");
      expect(existsSync(modelPath)).toBe(true);
      expect(readFileSync(modelPath, "utf8")).toBe("hello world");
      const downloaded = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/downloaded", headers });
      expect(downloaded.json().data).toEqual([expect.objectContaining({ repoId: "Qwen/Qwen2.5-7B-Instruct-GGUF", fileName: "model-q4_k_m.gguf", size: 11 })]);
    } finally {
      await runtime.app.close();
      rmSync(modelRoot, { recursive: true, force: true });
    }
  });
});
