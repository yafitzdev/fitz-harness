import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHost as createHostRuntime, type CreateHostOptions } from "./create-app.js";
import { ModelCatalogService } from "./model-catalog.js";
import { SecurityService } from "@fitz/security";
import { ArtifactRepository, LocalBlobStore, SqliteStore, StorageDurabilityService } from "@fitz/storage";
import { FakeEngineAdapter } from "@fitz/inference-core/testing";

// Unit/integration tests must not depend on whatever model the developer is
// currently running on the physical GPU. Individual resource-policy tests
// override this deterministic monitor explicitly.
function createHost(options: CreateHostOptions = {}) {
  return createHostRuntime({
    resourceMonitor: { snapshot: async () => ({ capturedAt: new Date().toISOString(), totalRamMiB: 64_000, freeRamMiB: 48_000, totalVramMiB: 48_000, usedVramMiB: 0, freeVramMiB: 48_000, gpuTelemetryAvailable: true }) },
    ...options,
  });
}

describe("Fitz host", () => {
  it("loads the host-owned Default model at startup and exposes only configured chat choices", async () => {
    const runtime = createHost();
    for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const health = await runtime.app.inject({ method: "GET", url: "/health" });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models" });

    expect(health.statusCode).toBe(200);
    expect(health.json().engine.state).toBe("READY");
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" })).json().hostName).toEqual(expect.any(String));
    expect(models.json().data.map((model: { id: string }) => model.id)).toEqual(["fake-best-v1"]);
    expect(models.body).not.toContain('"fake-best"');
    await runtime.app.close();
  });

  it("exposes the recipe model ID while keeping the internal Default route as a legacy alias", async () => {
    const runtime = createHost();
    try {
      const catalog = await runtime.app.inject({ method: "GET", url: "/v1/models" });
      expect(catalog.headers["cache-control"]).toBe("no-store");
      expect(catalog.headers.vary).toBe("authorization");
      expect(catalog.json().data).toEqual([
        expect.objectContaining({ id: "fake-best-v1", display_name: "fake-best-v1" }),
      ]);

      for (const model of ["fake-best-v1", "default"]) {
        const completion = await runtime.app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: { model, stream: false, messages: [{ role: "user", content: "identify yourself" }] },
        });
        expect(completion.statusCode, completion.body).toBe(200);
        expect(completion.json().model).toBe("fake-best-v1");
      }
    } finally {
      await runtime.app.close();
    }
  });

  it("repairs an invalid cloud-backed Default to the local host seed", async () => {
    const store = SqliteStore.memory();
    store.upsertRecipe({
      id: "old-cloud-default",
      playbookId: "old-cloud",
      displayName: "Old cloud default",
      adapter: "openai-compatible",
      modelId: "cloud-model",
      contextTokens: 128_000,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 8 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: { baseUrl: "https://example.invalid/v1" },
    });
    store.upsertRoute({ id: "default", displayName: "Default", recipeId: "old-cloud-default", enabled: true, isDefault: true });
    const runtime = createHost({ store });
    try {
      expect(runtime.routes.resolve("default").recipe).toMatchObject({ id: "fake-best", adapter: "fake" });
      expect(runtime.routes.resolve("default").route.displayName).toBe("Local");
      expect(runtime.lifecycle.pinnedRecipe()).toMatchObject({ id: "fake-best" });
    } finally { await runtime.app.close(); }
  });

  it("repairs a persisted Default whose adapter is unavailable in the active engine mode", async () => {
    const store = SqliteStore.memory();
    store.upsertRecipe({
      id: "persisted-ninfer-default",
      playbookId: "ninfer",
      displayName: "Persisted NInfer model",
      adapter: "ninfer",
      modelId: "persisted-model",
      contextTokens: 100_000,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: true, maxConcurrentGenerations: 1 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: {},
    });
    store.upsertRoute({ id: "default", displayName: "Local", recipeId: "persisted-ninfer-default", enabled: true, isDefault: true });

    const runtime = createHost({ store });
    try {
      expect(runtime.routes.resolve("default").recipe).toMatchObject({ id: "fake-best", adapter: "fake" });
      expect(runtime.lifecycle.pinnedRecipe()).toMatchObject({ id: "fake-best", adapter: "fake" });
    } finally { await runtime.app.close(); }
  });

  it("exposes durable usage aggregates after a terminal request", async () => {
    const store = SqliteStore.memory();
    const security = new SecurityService(store, "usage-pepper");
    const administrator = security.createUser("Usage administrator", "administrator");
    const { token } = security.issueDevice(administrator.id, "Usage API key");
    const headers = { authorization: `Bearer ${token}` };
    const runtime = createHost({ store, security, authMode: "required" });
    try {
      const completion = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers,
        payload: { model: "default", stream: false, messages: [{ role: "user", content: "usage accounting" }] },
      });
      expect(completion.statusCode, completion.body).toBe(200);
      const usage = await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage?bucket=hour", headers });
      expect(usage.statusCode, usage.body).toBe(200);
      expect(usage.json().data).toEqual(expect.objectContaining({
        bucket: "hour",
        totals: expect.objectContaining({ requests: 1, successful: 1, failed: 0, tokenReportedRequests: 1 }),
        routes: expect.arrayContaining([expect.objectContaining({ key: "default", requests: 1 })]),
      }));
    } finally { await runtime.app.close(); }
  });

  it("preserves normalized reasoning through the shared OpenAI route for every engine adapter", async () => {
    class ReasoningAdapter extends FakeEngineAdapter {
      override async *streamChat(..._args: Parameters<FakeEngineAdapter["streamChat"]>) {
        yield { text: "", reasoning: "Inspecting the request." };
        yield { text: "Done.", finishReason: "stop" as const };
      }
    }
    const runtime = createHost({ fakeAdapter: new ReasoningAdapter() });
    try {
      const nonStreaming = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "default", stream: false, messages: [{ role: "user", content: "work" }] },
      });
      expect(nonStreaming.statusCode, nonStreaming.body).toBe(200);
      expect(nonStreaming.json().choices[0].message).toEqual(expect.objectContaining({
        reasoning_content: "Inspecting the request.", content: "Done.",
      }));

      const streaming = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        payload: { model: "default", stream: true, messages: [{ role: "user", content: "work" }] },
      });
      expect(streaming.statusCode, streaming.body).toBe(200);
      expect(streaming.body).toContain('"reasoning_content":"Inspecting the request."');
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
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json().data).toEqual(expect.objectContaining({ requestId: expect.any(String), routeId: "default", status: "queued" }));
      for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(runtime.lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "READY", activeLeases: 0 }));
      expect(runtime.store.listGpuWork()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          routeId: "default",
          kind: "warm",
          status: "completed",
          position: 0,
        }),
      ]));
      expect(runtime.store.listInferenceRequests()).toEqual([]);
      const gpuWork = await runtime.app.inject({ method: "GET", url: "/api/v1/management/gpu-work" });
      expect(gpuWork.statusCode, gpuWork.body).toBe(200);
      expect(gpuWork.json().data).toEqual(expect.arrayContaining([
        expect.objectContaining({ routeId: "default", kind: "warm", status: "completed" }),
      ]));
    } finally { await runtime.app.close(); }
  });

  it("acknowledges a warm-up before a cold model finishes loading", async () => {
    let releaseLoad = () => {};
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    class BlockingStartAdapter extends FakeEngineAdapter {
      override async start(...args: Parameters<FakeEngineAdapter["start"]>) {
        await loadGate;
        return super.start(...args);
      }
    }
    const runtime = createHost({ fakeAdapter: new BlockingStartAdapter() });
    try {
      const response = await runtime.app.inject({ method: "POST", url: "/api/v1/inference/warm", payload: { model: "default" } });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json().data).toEqual(expect.objectContaining({ requestId: expect.any(String), status: "queued" }));
      expect(runtime.lifecycle.snapshot().state).not.toBe("READY");
      releaseLoad();
      for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(runtime.lifecycle.snapshot().state).toBe("READY");
    } finally {
      releaseLoad();
      await runtime.app.close();
    }
  });

  it("force-unloads the resident model when the desktop closes", async () => {
    const adapter = new FakeEngineAdapter();
    const releaseLocalRuntime = vi.fn(async () => undefined);
    const runtime = createHost({ fakeAdapter: adapter, releaseLocalRuntime });
    try {
      const warm = await runtime.app.inject({ method: "POST", url: "/api/v1/inference/warm", payload: { model: "default" } });
      expect(warm.statusCode, warm.body).toBe(202);
      for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(runtime.lifecycle.snapshot().state).toBe("READY");

      const stopped = await runtime.app.inject({
        method: "POST",
        url: "/api/v1/management/instances/stop",
        payload: { mode: "force", reason: "desktop-quit" },
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(stopped.json().engine.state).toBe("UNLOADED");
      expect(adapter.stops).toEqual([expect.objectContaining({ mode: "force" })]);
      expect(releaseLocalRuntime).toHaveBeenCalledWith("desktop-quit");

      const invalid = await runtime.app.inject({ method: "POST", url: "/api/v1/management/instances/stop", payload: { mode: "eventually" } });
      expect(invalid.statusCode).toBe(400);
    } finally { await runtime.app.close(); }
  });

  it("returns an immediate OpenAI-compatible 429 when the GPU lane is saturated", async () => {
    const runtime = createHost({
      fakeAdapter: new FakeEngineAdapter({ tokenDelayMs: 100 }),
      schedulerOptions: { gpuConcurrency: 1, gpuQueueCapacity: 1 },
    });
    for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
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

  it("saves a Default change immediately even when its background warm cannot enter the full queue", async () => {
    const runtime = createHost({
      fakeAdapter: new FakeEngineAdapter({ tokenDelayMs: 100 }),
      schedulerOptions: { gpuConcurrency: 1, gpuQueueCapacity: 1 },
    });
    for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const active = runtime.scheduler.enqueue("default", { messages: [{ role: "user", content: "active" }] });
    const queued = runtime.scheduler.enqueue("default", { messages: [{ role: "user", content: "queued" }] });
    const drains = [active, queued].map(async (stream) => { try { for await (const _delta of stream) { /* drain */ } } catch { /* cancelled below */ } });
    try {
      const response = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/routes/default",
        payload: { displayName: "Default", description: "Pinned local model", recipeId: "fake-fast", enabled: true, isDefault: true },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(runtime.routes.resolve("default").recipe.id).toBe("fake-fast");
      expect(runtime.lifecycle.pinnedRecipe()?.id).toBe("fake-fast");
    } finally {
      active.cancel();
      queued.cancel();
      await Promise.all(drains);
      await runtime.app.close();
    }
  });

  it("serializes local generations even when an engine advertises more concurrency", async () => {
    class CountingAdapter extends FakeEngineAdapter {
      active = 0;
      maximumActive = 0;
      override async *streamChat(...args: Parameters<FakeEngineAdapter["streamChat"]>) {
        this.active += 1;
        this.maximumActive = Math.max(this.maximumActive, this.active);
        try { yield* super.streamChat(...args); }
        finally { this.active -= 1; }
      }
    }
    const adapter = new CountingAdapter({ tokenDelayMs: 10 });
    const runtime = createHost({ fakeAdapter: adapter, schedulerOptions: { gpuConcurrency: 8 } });
    try {
      for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const complete = (content: string) => runtime.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "default", stream: false, messages: [{ role: "user", content }] },
      });

      const responses = await Promise.all([complete("one"), complete("two"), complete("three")]);

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
      expect(adapter.maximumActive).toBe(1);
      expect(adapter.starts).toHaveLength(1);
    } finally { await runtime.app.close(); }
  });

  it("admits three local generations when the selected recipe opts into C3", async () => {
    class CountingAdapter extends FakeEngineAdapter {
      active = 0;
      maximumActive = 0;
      override async *streamChat(...args: Parameters<FakeEngineAdapter["streamChat"]>) {
        this.active += 1;
        this.maximumActive = Math.max(this.maximumActive, this.active);
        try { yield* super.streamChat(...args); }
        finally { this.active -= 1; }
      }
    }
    const store = SqliteStore.memory();
    store.upsertRecipe({
      id: "fake-c3",
      playbookId: "test",
      displayName: "Fake C3",
      adapter: "fake",
      modelId: "fake-c3",
      contextTokens: 128_000,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: {},
    });
    store.upsertRoute({ id: "default", displayName: "Local", recipeId: "fake-c3", enabled: true, isDefault: true });
    const adapter = new CountingAdapter({ tokenDelayMs: 10 });
    const runtime = createHost({
      store,
      fakeAdapter: adapter,
      resourceMonitor: {
        snapshot: async () => ({
          capturedAt: new Date(0).toISOString(),
          totalRamMiB: 64_000,
          freeRamMiB: 32_000,
          totalVramMiB: 32_000,
          usedVramMiB: 0,
          freeVramMiB: 32_000,
          gpuTelemetryAvailable: true,
        }),
      },
    });
    try {
      for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const complete = (content: string) => runtime.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "default", stream: false, messages: [{ role: "user", content }] },
      });

      const responses = await Promise.all([complete("one"), complete("two"), complete("three")]);

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
      expect(adapter.maximumActive).toBe(3);
      expect(adapter.starts).toHaveLength(1);
    } finally { await runtime.app.close(); }
  });

  it("rejects arbitrary host text routes and keeps them out of the public model contract", async () => {
    const runtime = createHost();
    try {
      const assigned = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/consumer--default", payload: { displayName: "Default", recipeId: "fake-best", enabled: true, isDefault: true } });
      expect(assigned.statusCode, assigned.body).toBe(400);
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models" })).json().data.map((item: { id: string }) => item.id)).toEqual(["fake-best-v1"]);
      const completion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "consumer--default", stream: false, messages: [{ role: "user", content: "hosted locally" }] } });
      expect(completion.statusCode, completion.body).toBe(404);
    } finally { await runtime.app.close(); }
  });

  it("passes ordinary OpenAI-compatible tool choice through unchanged", async () => {
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

      const internal = await runtime.app.inject({
        method: "POST", url: "/v1/chat/completions",
        headers: { authorization: "Bearer agent-secret" }, payload,
      });
      expect(internal.statusCode, internal.body).toBe(200);
      expect(adapter.requests.at(-1)?.toolChoice).toBe("auto");
    } finally { await runtime.app.close(); }
  });

  it("discovers an external API and exposes the user's Smart and Fast routes", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[{"id":"upstream-model"},{"id":"explicit-chat-model","endpoints":["chat"]},{"id":"embed-v4.0"},{"id":"rerank-v3.5"},{"id":"cohere-transcribe-03-2026"},{"id":"provider-embedding","endpoints":["embed"]}]}'); return; }
      if (request.url === "/v1/chat/completions") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"choices":[{"delta":{"content":"upstream ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return; }
      response.writeHead(404); response.end();
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const runtime = createHost();
    try {
      const saved = await runtime.app.inject({ method: "PUT", url: "/api/v1/connections/test-api", payload: { displayName: "Test API", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" } });
      expect(saved.statusCode).toBe(200);
      const consumerModel = saved.json().data.models[0];
      expect(consumerModel).toEqual({ id: "upstream-model", recipeId: expect.any(String) });
      expect(saved.json().data.models.map((model: { id: string }) => model.id)).toEqual(["upstream-model", "explicit-chat-model"]);
      expect(runtime.routes.resolveRecipe(consumerModel.recipeId)).not.toHaveProperty("agentTopology");
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models" })).json().data.map((item: { id: string }) => item.id).sort()).toEqual(["fake-best-v1"]);
      const models = await runtime.app.inject({ method: "GET", url: "/v1/models" });
      expect(models.json().data.map((item: { id: string }) => item.id)).toEqual(["fake-best-v1"]);
      const recipeTest = await runtime.app.inject({ method: "POST", url: `/api/v1/management/recipes/${consumerModel.recipeId}/test` });
      expect(recipeTest.statusCode, recipeTest.body).toBe(200); expect(recipeTest.json().data.working).toBe(true);
      expect((await runtime.app.inject({ method: "PUT", url: "/api/v1/cloud-routes/smart", payload: { recipeId: consumerModel.recipeId } })).statusCode).toBe(200);
      expect((await runtime.app.inject({ method: "PUT", url: "/api/v1/cloud-routes/fast", payload: { recipeId: consumerModel.recipeId } })).statusCode).toBe(200);
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models" })).json().data.map((item: { id: string }) => item.id)).toEqual(["fake-best-v1", "upstream-model"]);
      const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Connection routing" } });
      const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "External", connectionId: "test-api", routeId: "smart" } });
      const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "smart", sessionId: session.json().data.id, messages: [{ role: "user", content: "hello" }] } });
      expect(run.statusCode, run.body).toBe(202);
      // A session's connectionId no longer scopes resolution: the run uses the global default class.
      expect(run.json().data.routeId).toBe("smart");
      // The public class remains the sole routing contract after connection refresh.
      const scopedCompletion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "smart", stream: false, messages: [{ role: "user", content: "hello" }] } });
      expect(scopedCompletion.statusCode, scopedCompletion.body).toBe(200);
      expect(scopedCompletion.json().choices[0].message.content).toContain("upstream ok");
      expect(scopedCompletion.json().model).toBe("upstream-model");
      const canonicalCloudCompletion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "upstream-model", stream: false, messages: [{ role: "user", content: "hello" }] } });
      expect(canonicalCloudCompletion.statusCode, canonicalCloudCompletion.body).toBe(200);
      expect(canonicalCloudCompletion.json().model).toBe("upstream-model");
      const fastSession = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Fast cloud", routeId: "fast" } });
      expect(fastSession.statusCode, fastSession.body).toBe(201);
      expect(fastSession.json().data.routeId).toBe("fast");
      const fastCompletion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "fast", stream: false, messages: [{ role: "user", content: "hello" }] } });
      expect(fastCompletion.statusCode, fastCompletion.body).toBe(200);
      expect(fastCompletion.json().choices[0].message.content).toContain("upstream ok");
      expect(fastCompletion.json().model).toBe("upstream-model");
      await runtime.app.inject({ method: "PUT", url: "/api/v1/connections/test-api", payload: { displayName: "Test API", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" } });
      expect(runtime.routes.resolveRecipe(consumerModel.recipeId)).not.toHaveProperty("agentTopology");
      const refreshedStatus = await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" });
      expect(refreshedStatus.json().cloudRoutes.smart).toBe(consumerModel.recipeId);
      expect(refreshedStatus.json().cloudRoutes.fast).toBe(consumerModel.recipeId);
      expect(refreshedStatus.json().agentTopologies.smart).toEqual({
        orchestratorContextTokens: 131_072,
        workerContextTokens: 32_768,
        workerCounts: { light: 0, normal: 3, high: 8 },
      });
      expect(refreshedStatus.json().agentTopologies.fast).toEqual({
        orchestratorContextTokens: 131_072,
        workerContextTokens: 32_768,
        workerCounts: { light: 0, normal: 3, high: 6 },
      });
      await runtime.app.inject({ method: "DELETE", url: "/api/v1/connections/test-api" });
      // Removing the connection releases the global class it had claimed.
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" })).json().cloudRoutes.smart).toBeUndefined();
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" })).json().cloudRoutes.fast).toBeUndefined();
    } finally { await runtime.app.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
  });

  it("runs independent cloud requests concurrently without displacing local Default", async () => {
    let active = 0;
    let maximumActive = 0;
    const upstream = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[{"id":"cloud-planner"}]}');
        return;
      }
      if (request.url === "/v1/chat/completions") {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end('data: {"choices":[{"delta":{"content":"cloud ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          active -= 1;
        }, 40);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const adapter = new FakeEngineAdapter();
    const runtime = createHost({ fakeAdapter: adapter });
    try {
      const saved = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/connections/cloud",
        payload: { displayName: "Cloud", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" },
      });
      const recipeId = saved.json().data.models[0].recipeId as string;
      expect((await runtime.app.inject({ method: "PUT", url: "/api/v1/cloud-routes/smart", payload: { recipeId } })).statusCode).toBe(200);
      for (let attempt = 0; attempt < 50 && runtime.lifecycle.snapshot().state !== "READY"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));

      const request = () => runtime.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "smart", stream: false, messages: [{ role: "user", content: "plan" }] },
      });
      const responses = await Promise.all([request(), request()]);

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(maximumActive).toBe(2);
      expect(runtime.lifecycle.snapshot()).toMatchObject({ state: "READY", recipeId: "fake-best" });
      expect(adapter.starts).toHaveLength(1);
    } finally {
      await runtime.app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("keeps cloud connections and Smart/Fast assignments private to their authenticated owner", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[{"id":"private-cloud-model"}]}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const store = SqliteStore.memory();
    const security = new SecurityService(store, "owner-isolation-pepper");
    const alice = security.createUser("Alice");
    const bob = security.createUser("Bob");
    const aliceHeaders = { authorization: `Bearer ${security.issueDevice(alice.id, "Alice laptop").token}` };
    const bobHeaders = { authorization: `Bearer ${security.issueDevice(bob.id, "Bob laptop").token}` };
    const runtime = createHost({ store, security, authMode: "required" });
    try {
      const saved = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/connections/private",
        headers: aliceHeaders,
        payload: { displayName: "Alice cloud", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const recipeId = saved.json().data.models[0].recipeId as string;
      expect((await runtime.app.inject({ method: "PUT", url: "/api/v1/cloud-routes/smart", headers: aliceHeaders, payload: { recipeId } })).statusCode).toBe(200);
      expect((await runtime.app.inject({ method: "PUT", url: "/api/v1/cloud-routes/fast", headers: aliceHeaders, payload: { recipeId } })).statusCode).toBe(200);

      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/connections", headers: aliceHeaders })).json().data).toHaveLength(1);
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/connections", headers: bobHeaders })).json().data).toEqual([]);
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models", headers: aliceHeaders })).json().data.map((model: { id: string }) => model.id)).toEqual(["fake-best-v1", "private-cloud-model"]);
      expect((await runtime.app.inject({ method: "GET", url: "/v1/models", headers: bobHeaders })).json().data.map((model: { id: string }) => model.id)).toEqual(["fake-best-v1"]);
      expect((await runtime.app.inject({ method: "PUT", url: "/api/v1/cloud-routes/smart", headers: bobHeaders, payload: { recipeId } })).statusCode).toBe(404);
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/cloud-routes", headers: bobHeaders })).json().data).toEqual({});
    } finally {
      await runtime.app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
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
      const saved = await runtime.app.inject({ method: "PUT", url: "/api/v1/connections/reasoning-api", payload: { displayName: "Reasoning API", baseUrl: `http://127.0.0.1:${reasoningAddress.port}/v1`, authType: "none" } });
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

  it("includes the recipes backing visible host media routes in remote configuration", async () => {
    const runtime = createHost();
    try {
      const recipe = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/recipes/test-image",
        payload: {
          playbookId: "test-media",
          displayName: "Test image",
          adapter: "fake",
          modelId: "test-image-v1",
          contextTokens: 8_192,
          capabilities: { chatCompletions: false, streaming: false, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1, modalities: { input: ["text"], output: ["image"] } },
          lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 300, minimumResidencySeconds: 0 },
          configuration: {},
        },
      });
      expect(recipe.statusCode, recipe.body).toBe(200);
      const route = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/routes/image", payload: { displayName: "Image", recipeId: "test-image", enabled: true, isDefault: false } });
      expect(route.statusCode, route.body).toBe(200);

      const configuration = await runtime.app.inject({ method: "GET", url: "/api/v1/configuration" });
      expect(configuration.statusCode, configuration.body).toBe(200);
      expect(configuration.json().routes).toContainEqual(expect.objectContaining({ id: "image", recipeId: "test-image" }));
      expect(configuration.json().recipes).toContainEqual(expect.objectContaining({ id: "test-image" }));
    } finally { await runtime.app.close(); }
  });

  it("ignores legacy recipe topology and applies the global local-agent policy", async () => {
    const runtime = createHost();
    try {
      const response = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/recipes/qwen-team",
        payload: {
          playbookId: "ninfer",
          displayName: "Qwen Team",
          adapter: "ninfer",
          modelId: "qwen3.8-27b",
          contextTokens: 262_144,
          capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
          lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
          configuration: { executable: "ninfer-serve", artifact: "qwen.ninfer", maxContext: 1, maxConcurrency: 3 },
          agentTopology: { sharedContextTokens: 272_320, workers: { count: 2, contextTokens: 64_000 } },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toMatchObject({
        contextTokens: 262_144,
        configuration: { maxContext: 131_072 },
      });
      expect(response.json().data).not.toHaveProperty("agentTopology");

      const second = await runtime.app.inject({
        method: "PUT",
        url: "/api/v1/management/recipes/qwen-overcommitted",
        payload: {
          ...response.json().data,
          agentTopology: { sharedContextTokens: 100_000, workers: { count: 2, contextTokens: 64_000 } },
        },
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().data).not.toHaveProperty("agentTopology");
    } finally {
      await runtime.app.close();
    }
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
    expect(runtime.lifecycle.snapshot().state).toBe("READY");
    expect(runtime.routes.listRoutes()).toEqual(routesBefore);
    await runtime.app.close();
  });

  it("allows only Default as a host-owned text route", async () => {
    const runtime = createHost();
    const rejected = await runtime.app.inject({
      method: "PUT",
      url: "/api/v1/management/routes/fast",
      payload: { displayName: "Fast", description: "Lowest-latency route", recipeId: "fake-best", enabled: true, isDefault: false },
    });
    expect(rejected.statusCode).toBe(400);
    expect(runtime.routes.listRoutes()).toEqual([expect.objectContaining({ id: "default", recipeId: "fake-best" })]);
    await runtime.app.close();
  });

  it("does not expose the removed internal subagent route", async () => {
    const runtime = createHost();
    const response = await runtime.app.inject({
      method: "PUT",
      url: "/api/v1/management/routes/subagent",
      payload: { displayName: "Subagent", description: "Internal delegated-work route", recipeId: "fake-fast", enabled: true },
    });

    expect(response.statusCode).toBe(400);
    expect(runtime.routes.listRoutes(true)).not.toContainEqual(expect.objectContaining({ id: "subagent" }));
    expect((await runtime.app.inject({ method: "GET", url: "/v1/models" })).json().data.map((model: { id: string }) => model.id)).toEqual(["fake-best-v1"]);
    await runtime.app.close();
  });

  it("does not retain the removed route-preload API", async () => {
    const runtime = createHost();
    try {
      const saved = await runtime.app.inject({ method: "PUT", url: "/api/v1/management/preload-routes", payload: { routeIds: ["subagent", "fast"] } });
      expect(saved.statusCode, saved.body).toBe(404);
      expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/status" })).json().startupPreloadRouteIds).toBeUndefined();
    } finally { await runtime.app.close(); }
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
          runtime: "linux-managed",
          baseUrl: "http://127.0.0.1:18080",
          healthPath: "/v1/models",
          launchCommand: "./build/bin/llama-server",
          launchArguments: ["--port", "{port}"],
          workingDirectory: ".",
          runtimeId: "inference-linux",
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
      id: "comfyui", folderName: "ComfyUI", displayName: "comfyui", connectionMode: "managed", runtime: "linux-managed",
      baseUrl: "http://127.0.0.1", healthPath: "/system_stats", launchCommand: "python", launchArguments: ["main.py"], workingDirectory: ".", runtimeId: "inference-linux",
      createdAt: timestamp, updatedAt: timestamp,
    });
    const runtime = createHost({ engineRoot, store });
    try {
      const response = await runtime.app.inject({
        method: "PUT", url: "/api/v1/management/engines/ComfyUI",
        payload: {
          displayName: "comfyui", connectionMode: "managed", runtime: "linux-managed",
          baseUrl: "http://127.0.0.1", healthPath: "/system_stats", launchCommand: "python", launchArguments: ["main.py"], workingDirectory: ".", runtimeId: "inference-linux",
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
        model: "default",
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
      expect.objectContaining({ routeId: "default", status: "completed" }),
    ]);
    await runtime.app.close();
  });

  it("lists the host's built-in custom tools for the Plugins page", async () => {
    const runtime = createHost({
      adminToken: "plugins-token",
      listCustomTools: () => [
        { name: "fitz_trash", label: "Move to trash", description: "Recoverable deletes" },
        { name: "lsp", label: "Language server", description: "Read-only editor queries" },
      ],
    });
    try {
      const response = await runtime.app.inject({
        method: "GET",
        url: "/api/v1/management/pi/custom-tools",
        headers: { "x-fitz-admin-token": "plugins-token" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual([
        { name: "fitz_trash", label: "Move to trash", description: "Recoverable deletes" },
        { name: "lsp", label: "Language server", description: "Read-only editor queries" },
      ]);
    } finally {
      await runtime.app.close();
    }
  });

  it("streams SSE chunks and terminates with DONE", async () => {
    const runtime = createHost();
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "default",
        stream: true,
        messages: [{ role: "user", content: "stream this" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("chat.completion.chunk");
    expect(response.body).toContain('"model":"fake-best-v1"');
    expect(response.body).not.toContain('"model":"default"');
    const content = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: {") && line.includes("chat.completion.chunk"))
      .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "")
      .join("");
    expect(content).toContain("stream this");
    expect(response.body).not.toContain('"usage"');
    expect(response.body).toContain("data: [DONE]");
    await runtime.app.close();
  });

  it("emits a final OpenAI usage chunk before DONE when requested", async () => {
    const adapter = new FakeEngineAdapter();
    const runtime = createHost({ fakeAdapter: adapter });
    const response = await runtime.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "default",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "report streamed usage" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const events = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    const doneIndex = events.indexOf("[DONE]");
    const usageIndex = events.findIndex((event) => {
      if (event === "[DONE]") return false;
      const parsed = JSON.parse(event) as { choices?: unknown[]; usage?: Record<string, number> };
      return Array.isArray(parsed.choices) && parsed.choices.length === 0 && parsed.usage !== undefined;
    });

    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(doneIndex);
    const usageEvent = JSON.parse(events[usageIndex]!) as { choices: unknown[]; usage: Record<string, number> };
    expect(usageEvent.choices).toEqual([]);
    expect(usageEvent.usage.prompt_tokens).toBeGreaterThan(0);
    expect(usageEvent.usage.completion_tokens).toBeGreaterThan(0);
    expect(usageEvent.usage.total_tokens).toBe(
      usageEvent.usage.prompt_tokens + usageEvent.usage.completion_tokens,
    );
    expect(adapter.requests[0]?.streamOptions).toEqual({ includeUsage: true });
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
        model: "default",
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
    expect(metrics.json().counters).toEqual(expect.objectContaining({ model_loads_total: 1 }));
    expect(metrics.json().counters.inference_requests_completed_total).toBeGreaterThanOrEqual(1);
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual(
      expect.objectContaining({
        versions: expect.objectContaining({ protocol: "1" }),
        metrics: expect.any(Object),
        recentRequests: expect.arrayContaining([expect.objectContaining({ status: "completed" })]),
        recentGpuWork: expect.arrayContaining([expect.objectContaining({ kind: "chat", status: "completed" })]),
      }),
    );
    expect(diagnostics.body).not.toContain("diagnostic-test-token");
    await runtime.app.close();
  });

  it("does not retain the removed Serve and standalone startup administration surfaces", async () => {
    const runtime = createHost({ adminToken: "development-token" });
    const headers = { "x-fitz-admin-token": "development-token" };
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/connectivity/status", headers })).statusCode).toBe(404);
    expect((await runtime.app.inject({ method: "POST", url: "/api/v1/management/connectivity/tailscale-serve", headers, payload: {} })).statusCode).toBe(404);
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/management/startup", headers })).statusCode).toBe(404);
    await runtime.app.close();
  });

  it("requires device authentication and gives every user the fixed Default capability", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const user = security.createUser("Consumer"); security.setRouteGrants(user.id, ["fast"]); const { token } = security.issueDevice(user.id, "Browser");
    const runtime = createHost({ store, security, authMode: "required" });
    const denied = await runtime.app.inject({ method: "GET", url: "/v1/models" });
    const publicHealth = await runtime.app.inject({ method: "GET", url: "/health" });
    const privateHealth = await runtime.app.inject({ method: "GET", url: "/health", headers: { authorization: `Bearer ${token}` } });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${token}` } });
    const completion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${token}` }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    expect(publicHealth.json()).not.toHaveProperty("resources"); expect(privateHealth.json()).toHaveProperty("resources"); expect(denied.statusCode).toBe(401); expect(models.json().data.map((model: { id: string }) => model.id)).toEqual(["fake-best-v1"]); expect(completion.statusCode).toBe(200); await runtime.app.close();
  });

  it("accepts the private Pi credential only on chat completions", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper");
    const runtime = createHost({ store, security, authMode: "required", internalAgentToken: "private-pi-token" });
    const denied = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer wrong" }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    const completion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer private-pi-token" }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer private-pi-token" } });
    expect(denied.statusCode).toBe(401); expect(completion.statusCode).toBe(200); expect(models.statusCode).toBe(401); await runtime.app.close();
  });

  it("accepts only the ephemeral dev supervisor credential for shutdown", async () => {
    const runtime = createHost({ authMode: "required", authPepper: "pepper", devSessionToken: "dev-session-secret" });
    let markClosed = () => undefined;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    runtime.app.addHook("onClose", async () => { markClosed(); });
    const denied = await runtime.app.inject({ method: "POST", url: "/__fitz/dev/shutdown", headers: { authorization: "Bearer wrong" } });
    expect(denied.statusCode).toBe(401);
    const accepted = await runtime.app.inject({ method: "POST", url: "/__fitz/dev/shutdown", headers: { authorization: "Bearer dev-session-secret" } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ status: "shutting-down" });
    await closed;
  });

  it("allows administrators to provision and revoke devices with audit history", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const admin = security.createUser("Admin", "administrator"); const { token } = security.issueDevice(admin.id, "Console"); const runtime = createHost({ store, security, authMode: "required" }); const headers = { authorization: `Bearer ${token}` };
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/management/users", headers, payload: { displayName: "Agent", role: "agent" } });
    const issued = await runtime.app.inject({ method: "POST", url: `/api/v1/management/users/${created.json().data.id}/devices`, headers, payload: { name: "Laptop" } }); const me = await runtime.app.inject({ method: "GET", url: "/api/v1/me", headers }); expect(me.json().data).toEqual(expect.objectContaining({ authMode: "required", user: expect.objectContaining({ role: "administrator" }) })); const access = await runtime.app.inject({ method: "GET", url: `/api/v1/management/users/${created.json().data.id}/access`, headers }); expect(access.json().data).toEqual(expect.objectContaining({ devices: [expect.objectContaining({ id: issued.json().data.device.id })], routeIds: [], quota: expect.objectContaining({ maxRequestsPerMinute: expect.any(Number) }), currentDeviceId: me.json().data.device.id }));
    expect(created.statusCode).toBe(201); expect(issued.statusCode).toBe(201); expect(issued.json().data.token).toMatch(/^fitz_/);
    const subjects = await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage-subjects", headers });
    expect(subjects.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.json().data.id, devices: [expect.objectContaining({ id: issued.json().data.device.id, name: "Laptop" })] })]));
    const deleted = await runtime.app.inject({ method: "DELETE", url: `/api/v1/management/devices/${issued.json().data.device.id}`, headers }); const audit = await runtime.app.inject({ method: "GET", url: "/api/v1/management/audit-events", headers });
    const subjectsAfterDelete = await runtime.app.inject({ method: "GET", url: "/api/v1/management/usage-subjects", headers });
    expect(deleted.statusCode).toBe(204); expect(store.listDevices(created.json().data.id)).toEqual([]); expect(subjectsAfterDelete.json().data.find((item: { id: string }) => item.id === created.json().data.id)?.devices).toEqual([]); expect(audit.json().data.map((event: { action: string }) => event.action)).toEqual(expect.arrayContaining(["user.created", "device.issued", "device.deleted"])); await runtime.app.close();
  });

  it("persists native agent events and resumes after a sequence", async () => {
    const runtime = createHost();
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "native protocol" }], effort: "high", max_tokens: 64 } });
    expect(created.statusCode).toBe(202); const runId = created.json().data.id as string;
    expect(runtime.store.getAgentRunRequest(runId)).toEqual(expect.objectContaining({ effort: "high", maxTokens: 64 }));
    let run = runtime.agentRuns.get(runId); for (let attempt = 0; attempt < 50 && run?.status !== "completed"; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); run = runtime.agentRuns.get(runId); }
    expect(run?.status).toBe("completed");
    const all = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events?after=0` }); const events = all.json().events as { sequence: number; type: string }[];
    expect(events[0]?.type).toBe("run.created"); expect(events.at(-1)?.type).toBe("run.completed");
    const resumed = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events?after=2` }); expect(resumed.json().events.every((event: { sequence: number }) => event.sequence > 2)).toBe(true);
    const usage = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/usage` });
    expect(usage.statusCode, usage.body).toBe(200);
    expect(usage.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "chat", runId, ttftMs: expect.any(Number), completionTokens: expect.any(Number) })]));
    runtime.store.saveAgentRunPlan({ runId, revision: 1, status: "completed", createdAt: run!.createdAt, updatedAt: run!.updatedAt, completedAt: run!.updatedAt, items: [{ id: "answer", task: "Answer", dependencies: [], owner: "main", workerEligible: false, required: true, status: "completed", attempts: 0, result: "done" }] });
    const plan = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/plan` });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().data).toEqual(expect.objectContaining({ runId, status: "completed", items: [expect.objectContaining({ id: "answer" })] }));
    const sse = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events`, headers: { accept: "text/event-stream", "last-event-id": "2" } }); expect(sse.statusCode).toBe(200); expect(sse.body).toContain("event: run.completed"); expect(sse.body).not.toContain("id: 1\n"); await runtime.app.close();
  });

  it("defaults missing effort to Medium, accepts its public alias, and rejects unknown effort independently of max_tokens", async () => {
    const runtime = createHost();
    const normal = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "normal" }], max_tokens: 77 } });
    expect(normal.statusCode).toBe(202);
    expect(runtime.store.getAgentRunRequest(normal.json().data.id)).toEqual(expect.objectContaining({ effort: "normal", maxTokens: 77 }));
    const medium = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "medium" }], effort: "medium", max_tokens: 77 } });
    expect(medium.statusCode).toBe(202);
    expect(runtime.store.getAgentRunRequest(medium.json().data.id)).toEqual(expect.objectContaining({ effort: "normal", maxTokens: 77 }));
    const invalid = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "invalid" }], effort: "maximum", max_tokens: 77 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain("effort must be light, medium, or high");
    await runtime.app.close();
  });

  it("returns the original run when creation is retried with the same client request identity", async () => {
    const runtime = createHost();
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Idempotent" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Once" } });
    const payload = { model: "default", sessionId: session.json().data.id, clientRequestId: "desktop:stable-request", messages: [{ role: "user", content: "run once" }] };
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload });
    const retried = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload });
    expect(first.statusCode).toBe(202);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(expect.objectContaining({ idempotentReplay: true, data: expect.objectContaining({ id: first.json().data.id }) }));
    expect(runtime.agentRuns.list().filter((run) => run.id === first.json().data.id)).toHaveLength(1);
    expect(runtime.store.transcriptAfter(session.json().data.id, 0).filter((entry) => entry.role === "user" && entry.content.text === "run once")).toHaveLength(1);
    await runtime.app.close();
  });

  it("does not restore an older interruption after a successful reply and host restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fitz-session-recovery-"));
    const open = () => createHost({
      store: new SqliteStore(join(directory, "fitz.db")),
      agentRuntime: {
        id: "recovery-display-agent",
        run: () => Object.assign((async function* () {
          yield { type: "assistant.delta" as const, text: "Task completed successfully." };
        })(), { cancel: () => undefined }),
      },
    });
    let runtime = open();
    try {
      const now = new Date(0).toISOString();
      runtime.store.createSession({ id: "recovered-session", title: "Recovered", status: "active", createdAt: now, updatedAt: now });
      const request = { model: "default", sessionId: "recovered-session", messages: [{ role: "user" as const, content: "finish the task" }] };
      runtime.store.createAgentRun({ id: "old-interruption", routeId: "default", sessionId: "recovered-session", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
      await runtime.app.close();
      runtime = open();

      const interrupted = await runtime.app.inject({ method: "GET", url: "/api/v1/sessions/recovered-session/agent-run-state" });
      expect(interrupted.json().data).toMatchObject({ id: "old-interruption", status: "interrupted", resumable: true });
      // A normal retry/follow-up is a new run, without a resume-of relationship.
      const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: request });
      expect(created.statusCode, created.body).toBe(202);
      const runId = created.json().data.id;
      await vi.waitFor(() => expect(runtime.agentRuns.get(runId)?.status).toBe("completed"));

      await runtime.app.close();
      runtime = open();
      const state = await runtime.app.inject({ method: "GET", url: "/api/v1/sessions/recovered-session/agent-run-state" });
      expect(state.statusCode).toBe(200);
      expect(state.json().data).toBeNull();
      expect(runtime.store.getAgentRun(runId)?.status).toBe("completed");
      expect(runtime.store.getAgentRun("old-interruption")).toMatchObject({ status: "interrupted", resumable: true });
      expect(runtime.store.transcriptAfter("recovered-session", 0)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", kind: "message", content: expect.objectContaining({ text: "Task completed successfully." }) }),
      ]));
    } finally {
      await runtime.app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues a failed run exactly once from its durable checkpoint", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "resume-project", name: "Resume", createdAt: now, updatedAt: now });
    store.createSession({ id: "resume-session", projectId: "resume-project", title: "Resume", status: "active", createdAt: now, updatedAt: now });
    store.createAgentRun({ id: "failed-run", routeId: "default", sessionId: "resume-session", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, { model: "default", sessionId: "resume-session", accessMode: "full", messages: [{ role: "user", content: "finish the task" }] });
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
    store.createAgentRun({ id: "unsafe-run", routeId: "default", sessionId: "unsafe-session", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, { model: "default", sessionId: "unsafe-session", accessMode: "full", messages: [{ role: "user", content: "publish the result" }] });
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
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId: session.json().data.id, messages: [{ role: "user", content: "use agent" }] } }); const runId = created.json().data.id;
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events` });
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual(["run.created", "run.queue.updated", "run.queue.updated", "run.started", "assistant.delta", "tool.started", "tool.completed", "assistant.delta", "assistant.completed", "run.completed"]);
    expect(replay.json().events.find((event: { type: string }) => event.type === "tool.started").data.input).toEqual({ path: "README.md" });
    const transcript = runtime.store.transcriptAfter(session.json().data.id, 0);
    expect(transcript.map((entry) => [entry.kind, entry.content.phase ?? entry.content.toolName])).toEqual([
      ["message", undefined], ["message", "commentary"], ["tool-call", "read"], ["tool-result", "read"], ["message", "final"],
    ]);
    expect(transcript.find((entry) => entry.kind === "tool-call")?.content.input).toEqual({ path: "README.md" });
    expect(transcript.find((entry) => entry.kind === "tool-result")?.content.result).toBe("ok");
    await runtime.app.close();
  });

  it("hydrates attached text, HTML, and opaque files for the model while keeping the transcript concise", async () => {
    const seen: unknown[] = [];
    const runtime = createHost({ agentRuntime: { id: "attachment-agent", run: (request) => {
      seen.push(request.messages);
      const events = (async function* () { yield { type: "assistant.delta" as const, text: "I can read both files." }; })();
      return Object.assign(events, { cancel: () => undefined });
    } } });
    try {
      const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Attachments" } });
      const sessionId = session.json().data.id as string;
      const note = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("the answer is 42").toString("base64") } });
      const page = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "page.html", mimeType: "text/html", contentBase64: Buffer.from("<main>important markup</main>").toString("base64") } });
      const archive = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "bundle.zip", mimeType: "application/zip", contentBase64: Buffer.from([0, 1, 2, 3]).toString("base64") } });
      const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: {
        model: "default", sessionId, messages: [{ role: "user", content: "analyse this" }],
        attachments: [{ artifactId: note.json().data.id }, { artifactId: page.json().data.id }, { artifactId: archive.json().data.id }],
      } });
      expect(created.statusCode, created.body).toBe(202);
      const runId = created.json().data.id as string;
      for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(JSON.stringify(seen[0])).toContain("the answer is 42");
      expect(JSON.stringify(seen[0])).toContain("<main>important markup</main>");
      expect(JSON.stringify(seen[0])).toContain("[ATTACHMENT: bundle.zip");
      const userEntry = runtime.store.transcriptAfter(sessionId, 0).find((entry) => entry.role === "user");
      expect(userEntry?.content.text).toBe("analyse this");
      expect(userEntry?.content.attachments).toEqual([
        expect.objectContaining({ id: note.json().data.id, name: "note.txt", mimeType: "text/plain" }),
        expect.objectContaining({ id: page.json().data.id, name: "page.html", mimeType: "text/html" }),
        expect.objectContaining({ id: archive.json().data.id, name: "bundle.zip", mimeType: "application/zip" }),
      ]);
      const followup = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, messages: [{ role: "user", content: "What is the answer in the note?" }] } });
      expect(followup.statusCode, followup.body).toBe(202);
      await vi.waitFor(() => expect(runtime.agentRuns.get(followup.json().data.id)?.status).toBe("completed"));
      expect(JSON.stringify(seen[1])).toContain("the answer is 42");
      expect(JSON.stringify(seen[1])).toContain("important markup");
      const compacted = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact`, payload: { model: "default" } });
      expect(compacted.statusCode, compacted.body).toBe(200);
      expect(compacted.json().data.entry.content.summary).toContain("the answer is 42");
      const afterCompaction = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, messages: [{ role: "user", content: "Remind me of the answer." }] } });
      expect(afterCompaction.statusCode, afterCompaction.body).toBe(202);
      await vi.waitFor(() => expect(runtime.agentRuns.get(afterCompaction.json().data.id)?.status).toBe("completed"));
      expect(JSON.stringify(seen[2])).toContain("the answer is 42");
    } finally { await runtime.app.close(); }
  });

  it("restores image attachments for regenerated and follow-up turns and tolerates removal", async () => {
    const seen: unknown[] = [];
    const runtime = createHost({ agentRuntime: { id: "image-continuity", run(request) {
      seen.push(request.messages);
      return Object.assign((async function* () { yield { type: "assistant.delta" as const, text: "Received." }; })(), { cancel() {} });
    } } });
    try {
      const sessionId = (await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Image continuity" } })).json().data.id;
      const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KJAAAAAASUVORK5CYII=";
      const upload = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "diagram.png", mimeType: "image/png", contentBase64: base64 } });
      expect(upload.statusCode, upload.body).toBe(201);
      const artifactId = upload.json().data.id;
      const send = async (extra: Record<string, unknown> = {}) => {
        const response = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, messages: [{ role: "user", content: "Inspect the diagram." }], ...extra } });
        expect(response.statusCode, response.body).toBe(202);
        await vi.waitFor(() => expect(runtime.agentRuns.get(response.json().data.id)?.status).toBe("completed"));
        return response.json().data.id as string;
      };
      const runId = await send({ attachments: [{ artifactId }] });
      const regenerated = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/regenerate`, payload: { runId } });
      expect(regenerated.statusCode, regenerated.body).toBe(200);
      await send({ persistedMessageId: regenerated.json().data.messageId });
      await send();
      for (const request of seen) expect(JSON.stringify(request)).toContain(`data:image/png;base64,${base64}`);
      await runtime.app.inject({ method: "DELETE", url: `/api/v1/artifacts/${artifactId}` });
      await send();
      expect(JSON.stringify(seen.at(-1))).toContain("Attachment unavailable: diagram.png");
      expect(JSON.stringify(seen.at(-1))).not.toContain(base64);
    } finally { await runtime.app.close(); }
  });

  it("rehydrates uploaded content after the host and database are reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fitz-attachment-restart-"));
    const seen: unknown[] = [];
    const open = () => {
      const store = new SqliteStore(join(directory, "fitz.db"));
      return createHost({ store, artifacts: new ArtifactRepository(store, new LocalBlobStore(join(directory, "artifacts"))), agentRuntime: { id: "restart-attachments", run(request) {
        seen.push(request.messages);
        return Object.assign((async function* () { yield { type: "assistant.delta" as const, text: "Received." }; })(), { cancel() {} });
      } } });
    };
    let runtime = open();
    try {
      const sessionId = (await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Persistent attachment" } })).json().data.id;
      const upload = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "requirements.txt", mimeType: "text/plain", contentBase64: Buffer.from("The release code is ORCHID-729.").toString("base64") } });
      expect(upload.statusCode, upload.body).toBe(201);
      const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, messages: [{ role: "user", content: "Read this for later." }], attachments: [{ artifactId: upload.json().data.id }] } });
      expect(first.statusCode, first.body).toBe(202);
      await vi.waitFor(() => expect(runtime.agentRuns.get(first.json().data.id)?.status).toBe("completed"));
      await runtime.app.close();
      runtime = open();
      const next = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, messages: [{ role: "user", content: "What is the release code?" }] } });
      expect(next.statusCode, next.body).toBe(202);
      await vi.waitFor(() => expect(runtime.agentRuns.get(next.json().data.id)?.status).toBe("completed"));
      expect(JSON.stringify(seen.at(-1))).toContain("ORCHID-729");
    } finally {
      await runtime.app.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId: session.json().data.id, messages: [{ role: "user", content: "think then act" }] } }); const runId = created.json().data.id;
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events` });
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual(["run.created", "run.queue.updated", "run.queue.updated", "run.started", "reasoning.delta", "reasoning.delta", "reasoning.completed", "assistant.delta", "tool.started", "tool.completed", "assistant.delta", "assistant.completed", "run.completed"]);
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
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId: session.json().data.id, messages: [{ role: "user", content: "begin" }] } });
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
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "first" }] } });
    const second = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "second" }] } });
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
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "first" }] } });
    const second = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "second" }] } });
    expect(started).toEqual(["first"]);
    const initial = await runtime.app.inject({ method: "GET", url: "/api/v1/work/queue" });
    expect(initial.json().data.filter((item: { kind: string }) => item.kind === "agent")).toEqual([
      expect.objectContaining({ id: first.json().data.id, kind: "agent", lane: "gpu", status: "running", position: 0, depth: 2 }),
      expect.objectContaining({ id: second.json().data.id, kind: "agent", lane: "gpu", status: "queued", position: 1, depth: 2 }),
    ]);
    const cancelled = await runtime.app.inject({ method: "DELETE", url: `/api/v1/agent/runs/${second.json().data.id}` }); expect(cancelled.statusCode).toBe(202); expect(runtime.agentRuns.get(second.json().data.id)?.status).toBe("cancelled"); expect(started).toEqual(["first"]);
    const third = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "third" }] } });
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/work/queue" })).json().data.find((item: { id: string }) => item.id === third.json().data.id)).toEqual(expect.objectContaining({ id: third.json().data.id, status: "queued", position: 1 }));
    releases.get("first")?.(); for (let attempt = 0; attempt < 50 && !started.includes("third"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(started).toEqual(["first", "third"]);
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/work/queue" })).json().data.filter((item: { kind: string }) => item.kind === "agent")).toEqual([expect.objectContaining({ id: third.json().data.id, status: "running", position: 0, depth: 1 })]);
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
    const first = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "first" }] } });
    const second = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "second" }] } });
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
    const seenModelRequests: unknown[] = [];
    let invocation = 0;
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
    const runtime = createHost({ agentRuntime: { id: "regeneration-agent", run: (request) => {
      seenModelRequests.push(request.messages);
      const currentInvocation = invocation++;
      const answer = currentInvocation === 0 ? "superseded answer" : "replacement answer";
      const events = (async function* () {
        if (currentInvocation === 1) await replacementGate;
        yield { type: "assistant.delta" as const, text: answer };
      })();
      return Object.assign(events, { cancel: () => undefined });
    } } }); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Fitz", rootPath: "C:\\work\\fitz" } }); const projectId = project.json().data.id; expect(project.json().data.rootPath).toBe("C:\\work\\fitz");
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Infrastructure" } }); const sessionId = session.json().data.id;
    const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, messages: [{ role: "user", content: "persist this turn" }] } }); const runId = run.json().data.id; for (let attempt = 0; attempt < 400 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.agentRuns.get(runId)?.status).toBe("completed");
    const transcript = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript` }); expect(transcript.json().data).toEqual([expect.objectContaining({ sequence: 1, role: "user", content: expect.objectContaining({ text: "persist this turn" }) }), expect.objectContaining({ sequence: 2, role: "assistant", content: expect.objectContaining({ runId }) })]);
    const regenerate = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/regenerate`, payload: { runId } });
    expect(regenerate.statusCode, regenerate.body).toBe(200);
    expect(regenerate.json().data).toEqual(expect.objectContaining({ prompt: "persist this turn", messageId: expect.any(String), sequence: 1, removedTranscriptEntries: 2, estimatedContextTokens: expect.any(Number) }));
    expect(runtime.store.transcriptAfter(sessionId, 0)).toEqual([expect.objectContaining({ role: "user", content: expect.objectContaining({ text: "persist this turn" }) })]);
    const replacement = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, persistedMessageId: regenerate.json().data.messageId, messages: [{ role: "user", content: regenerate.json().data.prompt }] } });
    const replacementRunId = replacement.json().data.id;
    const activeDuplicate = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, persistedMessageId: regenerate.json().data.messageId, messages: [{ role: "user", content: regenerate.json().data.prompt }] } });
    expect(activeDuplicate.statusCode).toBe(400);
    releaseReplacement();
    for (let attempt = 0; attempt < 400 && runtime.agentRuns.get(replacementRunId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seenModelRequests).toEqual([
      [{ role: "user", content: "persist this turn" }],
      [{ role: "user", content: "persist this turn" }],
    ]);
    expect(JSON.stringify(seenModelRequests.at(-1))).not.toContain("superseded answer");
    expect(runtime.store.transcriptAfter(sessionId, 0).filter((entry) => entry.role === "user")).toHaveLength(1);
    const staleReplacement = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId, persistedMessageId: regenerate.json().data.messageId, messages: [{ role: "user", content: regenerate.json().data.prompt }] } });
    expect(staleReplacement.statusCode).toBe(400);
    await runtime.app.close();
  });

  it("persists direct client messages idempotently in the canonical transcript", async () => {
    const runtime = createHost();
    const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Media command" } });
    const sessionId = session.json().data.id as string;
    const payload = { clientMessageId: "media-command-1", text: "/video a fox in snow" };
    const created = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, payload });
    expect(created.statusCode, created.body).toBe(201);
    const repeated = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/messages`, payload });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().data.id).toBe(created.json().data.id);
    expect(runtime.store.transcriptAfter(sessionId, 0)).toEqual([
      expect.objectContaining({ role: "user", content: expect.objectContaining({ text: "/video a fox in snow" }) }),
    ]);
    const conflict = await runtime.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { clientMessageId: "media-command-1", text: "/video something else" },
    });
    expect(conflict.statusCode).toBe(409);
    await runtime.app.close();
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
    const rootFor = (sessionId: string) => `C:\\fitz\\chat-workspaces\\${sessionId}`;
    const runtime = createHost({ sessionWorkspaceRoot: rootFor });
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Wrapped" } }); const projectId = project.json().data.id;
    const projectSession = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Wrapped chat" } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Standalone" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toEqual(expect.objectContaining({ title: "Standalone", status: "active", routeId: "default", workspaceRoot: rootFor(created.json().data.id) }));
    expect(created.json().data.projectId).toBeUndefined();
    const listed = await runtime.app.inject({ method: "GET", url: "/api/v1/chats" });
    expect(listed.json().data).toEqual([expect.objectContaining({ id: created.json().data.id, title: "Standalone", workspaceRoot: rootFor(created.json().data.id) })]);
    expect(runtime.store.getSession(created.json().data.id)?.workspaceRoot).toBe(rootFor(created.json().data.id));
    const projectSessions = await runtime.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/sessions` });
    expect(projectSessions.json().data).toEqual([expect.objectContaining({ title: "Wrapped chat", workspaceRoot: rootFor(projectSession.json().data.id) })]);
    await runtime.app.close();
  });

  it("persists, edits, and removes messages waiting behind an active turn", async () => {
    const runtime = createHost();
    const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Queued chat" } });
    const sessionId = session.json().data.id as string;
    const created = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/message-queue`, payload: { text: "first draft", model: "default", effort: "normal", maxTokens: 4096, temperature: 0.4, accessMode: "full" } });
    expect(created.statusCode).toBe(201); const messageId = created.json().data.id as string;
    const edited = await runtime.app.inject({ method: "PATCH", url: `/api/v1/sessions/${sessionId}/message-queue/${messageId}`, payload: { text: "final draft" } });
    expect(edited.json().data.text).toBe("final draft");
    expect((await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/message-queue` })).json().data).toEqual([expect.objectContaining({ id: messageId, text: "final draft" })]);
    expect((await runtime.app.inject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/message-queue/${messageId}` })).statusCode).toBe(204);
    expect(runtime.store.listSessionMessages(sessionId)).toEqual([]);
    await runtime.app.close();
  });

  it("exposes the historical host directory for standalone chats created before workspace roots", async () => {
    const runtime = createHost({ legacyStandaloneWorkspaceRoot: "C:\\legacy-host-cwd" });
    const now = new Date(0).toISOString();
    runtime.store.createSession({ id: "legacy-chat", title: "Legacy", status: "active", createdAt: now, updatedAt: now });

    const listed = await runtime.app.inject({ method: "GET", url: "/api/v1/chats" });
    const fetched = await runtime.app.inject({ method: "GET", url: "/api/v1/sessions/legacy-chat" });

    expect(listed.json().data[0]).toEqual(expect.objectContaining({ id: "legacy-chat", workspaceRoot: "C:\\legacy-host-cwd" }));
    expect(fetched.json().data).toEqual(expect.objectContaining({ id: "legacy-chat", workspaceRoot: "C:\\legacy-host-cwd" }));
    expect(runtime.store.getSession("legacy-chat")?.workspaceRoot).toBeUndefined();
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
    const response = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", sessionId: "context-session", messages: [{ role: "user", content: "continue" }] } }); expect(response.statusCode).toBe(202); expect(response.json().context.compacted).toBe(true); const transcript = store.transcriptAfter("context-session", 0); expect(transcript.some((entry) => entry.kind === "compaction")).toBe(true); expect(transcript.some((entry) => entry.role === "user" && entry.content.text === "continue")).toBe(true); await runtime.app.close();
  });

  it("manually compacts a session into a reusable context checkpoint", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Context" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Long" } }); const sessionId = session.json().data.id;
    runtime.store.appendTranscriptEntry({ id: "manual-context", sessionId, kind: "message", role: "user", content: { text: "preserve this context ".repeat(2_000) }, createdAt: new Date().toISOString() }); const compacted = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact`, payload: { model: "default" } });
    const result = compacted.json().data;
    const transcript = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript?limit=1` });
    expect(compacted.statusCode).toBe(200); expect(result).toEqual(expect.objectContaining({ originalMessageCount: 1, estimatedInputTokens: expect.any(Number), estimatedContextTokens: expect.any(Number) })); expect(result.estimatedContextTokens).toBeLessThan(result.estimatedInputTokens); expect(transcript.json().page.estimatedContextTokens).toBe(result.estimatedContextTokens); expect(runtime.store.transcriptAfter(sessionId, 0).at(-1)).toEqual(expect.objectContaining({ kind: "compaction", content: expect.objectContaining({ manual: true, throughSequence: 1 }) })); await runtime.app.close();
  });

  it("rejects manual compaction while the session has an active run", async () => {
    const runtime = createHost();
    try {
      const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Busy context" } });
      const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Busy" } });
      const sessionId = session.json().data.id as string;
      runtime.store.appendTranscriptEntry({ id: "busy-context", sessionId, kind: "message", role: "user", content: { text: "keep this" }, createdAt: new Date().toISOString() });
      const now = Date.now();
      runtime.store.createAgentRun({ id: "busy-context-run", routeId: "default", sessionId, status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, { model: "default", sessionId, accessMode: "full", messages: [{ role: "user", content: "working" }] });

      const response = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact`, payload: { model: "default" } });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toEqual(expect.objectContaining({ code: "resource_busy", message: "Stop the current response before compacting", retryable: true }));
      expect(runtime.store.transcriptAfter(sessionId, 0).some((entry) => entry.kind === "compaction")).toBe(false);
    } finally {
      await runtime.app.close();
    }
  });

  it("has no pairing-code onboarding API", async () => { const runtime = createHost({ adminToken: "test-token" }); const headers = { "x-fitz-admin-token": "test-token" }; expect((await runtime.app.inject({ method: "POST", url: "/api/v1/management/pairing-codes", headers, payload: {} })).statusCode).toBe(404); expect((await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/redeem-shared", payload: {} })).statusCode).toBe(404); await runtime.app.close(); });

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

  it("returns a complete session forensics artifact with linked evidence and bytes", async () => {
    const runtime = createHost();
    try {
      const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Forensics" } });
      const sessionId = session.json().data.id as string;
      const artifact = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "proof.txt", mimeType: "text/plain", contentBase64: Buffer.from("proof").toString("base64") } });
      runtime.store.appendTranscriptEntry({ id: "forensics-message", sessionId, kind: "message", role: "user", content: { text: "reconstruct this" }, createdAt: new Date().toISOString() });
      runtime.store.recordInferenceEvidence({ id: "forensics-request", kind: "chat", status: "failed", routeId: "default", sessionId, executionLane: "gpu", enqueuedAt: new Date().toISOString(), completedAt: new Date().toISOString(), request: { messages: [{ role: "user", content: "reconstruct this" }] }, error: { name: "EngineError", message: "fixture failure" } });
      const response = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/forensics?download=true` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-disposition"]).toContain("forensics.json");
      const data = response.json().data;
      expect(data).toEqual(expect.objectContaining({ schemaVersion: 1, coverage: expect.objectContaining({ artifactContent: "included" }) }));
      expect(data.transcript).toEqual(expect.arrayContaining([expect.objectContaining({ id: "forensics-message" })]));
      expect(data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: "forensics-request", status: "failed", error: { name: "EngineError", message: "fixture failure" } })]));
      expect(data.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: artifact.json().data.id, contentBase64: Buffer.from("proof").toString("base64") })]));
      const queried = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/query?section=overview` });
      expect(queried.statusCode, queried.body).toBe(200);
      expect(queried.json().data.snapshot.forensics.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: "forensics-request" })]));
      const metadataOnly = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/forensics?includeArtifactContent=false` });
      expect(metadataOnly.json().data.coverage.artifactContent).toBe("metadata-only");
      expect(metadataOnly.json().data.artifacts[0]).not.toHaveProperty("contentBase64");
    } finally { await runtime.app.close(); }
  });

  it("accepts artifacts up to the 5 MB bound and rejects larger ones", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Limits" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Limits" } }); const sessionId = session.json().data.id;
    const accepted = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "medium.pdf", mimeType: "application/pdf", contentBase64: Buffer.alloc(2_000_000, 1).toString("base64") } }); expect(accepted.statusCode).toBe(201); expect(accepted.json().data).toEqual(expect.objectContaining({ kind: "pdf", byteSize: 2_000_000 }));
    const rejected = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "big.pdf", mimeType: "application/pdf", contentBase64: Buffer.alloc(5_000_001, 1).toString("base64") } }); expect(rejected.statusCode).toBe(400); expect(String(rejected.json().error.message)).toContain("byte limit"); await runtime.app.close(); });

  it("streams large media references without crossing the JSON/base64 boundary", async () => {
    const runtime = createHost();
    try {
      const session = await runtime.app.inject({ method: "POST", url: "/api/v1/chats", payload: { title: "Media references" } });
      const sessionId = session.json().data.id as string;
      const payload = Buffer.alloc(5_000_001, 7);
      const uploaded = await runtime.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/artifacts/content`,
        headers: {
          "content-type": "application/x-fitz-artifact",
          "x-fitz-artifact-name": encodeURIComponent("reference clip.mp4"),
          "x-fitz-artifact-mime": "application/octet-stream",
        },
        payload,
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      expect(uploaded.json().data).toEqual(expect.objectContaining({
        name: "reference clip.mp4", mimeType: "video/mp4", kind: "video", byteSize: payload.byteLength,
      }));
      const content = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${uploaded.json().data.id}/content` });
      expect(content.rawPayload.equals(payload)).toBe(true);
    } finally {
      await runtime.app.close();
    }
  }, 20_000);

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
      const response = await runtime.app.inject({ method: "GET", url: "/api/v1/management/models/catalog?query=qwen&category=vision", headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual({ total: 1, models: [expect.objectContaining({ id: "Qwen/Qwen2.5-7B-Instruct-GGUF" })] });
      expect(requested.some((url) => url.includes("pipeline_tag=image-text-to-video"))).toBe(true);
      expect(requested.filter((url) => url.includes("pipeline_tag=image-text-to-video")).every((url) => !url.includes("filter=gguf"))).toBe(true);
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
