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
import { SqliteStore } from "@fitz/storage";

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

  it("warms a selected route without generating a message", async () => {
    const runtime = createHost();
    try {
      const response = await runtime.app.inject({ method: "POST", url: "/api/v1/inference/warm", payload: { model: "default", connectionId: "hosted--local" } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(expect.objectContaining({ state: "READY", recipeId: "fake-best" }));
      expect(runtime.lifecycle.snapshot()).toEqual(expect.objectContaining({ state: "READY", activeLeases: 0 }));
    } finally { await runtime.app.close(); }
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
      // Legacy scoped ids collapse to the class, so they resolve to the same global route.
      const scopedCompletion = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model: "consumer--test-api--route--default", stream: false, messages: [{ role: "user", content: "hello" }] } });
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
      expect(test.json().error).toContain("produced reasoning");
      expect(test.json().error).toContain("length");
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
    const initial = await runtime.app.inject({ method: "GET", url: "/api/v1/agent/queue" });
    expect(initial.json().data).toEqual([
      expect.objectContaining({ runId: first.json().data.id, status: "running", position: 0, depth: 2 }),
      expect.objectContaining({ runId: second.json().data.id, status: "queued", position: 1, depth: 2 }),
    ]);
    const cancelled = await runtime.app.inject({ method: "DELETE", url: `/api/v1/agent/runs/${second.json().data.id}` }); expect(cancelled.statusCode).toBe(202); expect(runtime.agentRuns.get(second.json().data.id)?.status).toBe("cancelled"); expect(started).toEqual(["first"]);
    const third = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "default", messages: [{ role: "user", content: "third" }] } });
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/agent/queue" })).json().data.at(-1)).toEqual(expect.objectContaining({ runId: third.json().data.id, status: "queued", position: 1 }));
    releases.get("first")?.(); for (let attempt = 0; attempt < 50 && !started.includes("third"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(started).toEqual(["first", "third"]);
    expect((await runtime.app.inject({ method: "GET", url: "/api/v1/agent/queue" })).json().data).toEqual([expect.objectContaining({ runId: third.json().data.id, status: "running", position: 0, depth: 1 })]);
    releases.get("third")?.(); for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(third.json().data.id)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5)); await runtime.app.close();
  });

  it("creates projects and sessions and records a canonical run transcript", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Fitz", rootPath: "C:\\work\\fitz" } }); const projectId = project.json().data.id; expect(project.json().data.rootPath).toBe("C:\\work\\fitz");
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Infrastructure" } }); const sessionId = session.json().data.id;
    const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId, messages: [{ role: "user", content: "persist this turn" }] } }); const runId = run.json().data.id; for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const transcript = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript` }); expect(transcript.json().data).toEqual([expect.objectContaining({ sequence: 1, role: "user", content: expect.objectContaining({ text: "persist this turn" }) }), expect.objectContaining({ sequence: 2, role: "assistant", content: expect.objectContaining({ runId }) })]); await runtime.app.close();
  });

  it("removes a project without touching its source folder", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Disposable", rootPath: "C:\\work\\disposable" } }); const projectId = project.json().data.id; await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Temporary" } }); const removed = await runtime.app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` }); expect(removed.statusCode).toBe(204); expect((await runtime.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}` })).statusCode).toBe(404); await runtime.app.close(); });

  it("applies tool policy before creating a durable approval decision", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Tools" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Approval" } }); const sessionId = session.json().data.id;
    await runtime.app.inject({ method: "PUT", url: "/api/v1/management/tool-policies/role/consumer/bash", payload: { decision: "deny" } });
    const pending = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/tool-approvals`, payload: { toolCallId: "read-1", toolName: "read", request: { path: "README.md" } } }); expect(pending.json().data.status).toBe("pending");
    const decided = await runtime.app.inject({ method: "POST", url: `/api/v1/tool-approvals/${pending.json().data.id}/decision`, payload: { decision: "approved" } }); expect(decided.json().data.status).toBe("approved"); await runtime.app.close();
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
    const rejected = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "big.pdf", mimeType: "application/pdf", contentBase64: Buffer.alloc(5_000_001, 1).toString("base64") } }); expect(rejected.statusCode).toBe(400); expect(String(rejected.json().error)).toContain("byte limit"); await runtime.app.close(); });

  it("exposes the Hugging Face model catalog to administrators", async () => {
    const modelRoot = await mkdtemp(join(tmpdir(), "fitz-models-"));
    const requested: string[] = [];
    const runtime = createHost({
      adminToken: "model-test-token",
      modelCatalog: new ModelCatalogService({
        modelRoot,
        fetch: async (input: RequestInfo | URL) => { requested.push(String(input)); return new Response(JSON.stringify({ count: 1, items: [{ id: "Qwen/Qwen2.5-7B-Instruct-GGUF", downloads: 10, likes: 2, pipeline_tag: "text-generation" }] }), { status: 200 }); },
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
