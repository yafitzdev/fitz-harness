import { describe, expect, it } from "vitest";
import { createHost } from "./create-app.js";
import { SecurityService } from "@fitz/security";
import { SqliteStore } from "@fitz/storage";

describe("Fitz host", () => {
  it("boots idle and exposes consumer routes instead of recipes", async () => {
    const runtime = createHost();
    const health = await runtime.app.inject({ method: "GET", url: "/health" });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models" });

    expect(health.statusCode).toBe(200);
    expect(health.json().engine.state).toBe("UNLOADED");
    expect(models.json().data.map((model: { id: string }) => model.id)).toEqual([
      "default",
      "fast",
      "smart",
    ]);
    expect(models.body).not.toContain("fake-best");
    await runtime.app.close();
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

  it("requires device authentication and filters routes by grants", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const user = security.createUser("Consumer"); security.setRouteGrants(user.id, ["fast"]); const { token } = security.issueDevice(user.id, "Browser");
    const runtime = createHost({ store, security, authMode: "required" });
    const denied = await runtime.app.inject({ method: "GET", url: "/v1/models" });
    const models = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${token}` } });
    const forbidden = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${token}` }, payload: { model: "default", stream: false, messages: [{ role: "user", content: "hello" }] } });
    expect(denied.statusCode).toBe(401); expect(models.json().data.map((model: { id: string }) => model.id)).toEqual(["fast"]); expect(forbidden.statusCode).toBe(403); await runtime.app.close();
  });

  it("allows administrators to provision and revoke devices with audit history", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pepper"); const admin = security.createUser("Admin", "administrator"); const { token } = security.issueDevice(admin.id, "Console"); const runtime = createHost({ store, security, authMode: "required" }); const headers = { authorization: `Bearer ${token}` };
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/management/users", headers, payload: { displayName: "Agent", role: "agent" } });
    const issued = await runtime.app.inject({ method: "POST", url: `/api/v1/management/users/${created.json().data.id}/devices`, headers, payload: { name: "Laptop" } });
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
    const runtime = createHost({ agentRuntime: { id: "test-agent", run: () => { const events = (async function* () { yield { type: "assistant.delta" as const, text: "agent output" }; yield { type: "tool.started" as const, toolCallId: "tool-1", toolName: "read" }; yield { type: "tool.completed" as const, toolCallId: "tool-1", toolName: "read", result: "ok" }; })(); return Object.assign(events, { cancel: () => undefined }); } } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", messages: [{ role: "user", content: "use agent" }] } }); const runId = created.json().data.id; await new Promise((resolve) => setTimeout(resolve, 5)); const replay = await runtime.app.inject({ method: "GET", url: `/api/v1/agent/runs/${runId}/events` });
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual(["run.created", "run.started", "assistant.delta", "tool.started", "tool.completed", "run.completed"]); await runtime.app.close();
  });

  it("creates projects and sessions and records a canonical run transcript", async () => {
    const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Fitz", rootPath: "C:\\work\\fitz" } }); const projectId = project.json().data.id; expect(project.json().data.rootPath).toBe("C:\\work\\fitz");
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/sessions`, payload: { title: "Infrastructure" } }); const sessionId = session.json().data.id;
    const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", sessionId, messages: [{ role: "user", content: "persist this turn" }] } }); const runId = run.json().data.id; for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const transcript = await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/transcript` }); expect(transcript.json().data).toEqual([expect.objectContaining({ sequence: 1, role: "user", content: expect.objectContaining({ text: "persist this turn" }) }), expect.objectContaining({ sequence: 2, role: "assistant", content: expect.objectContaining({ runId }) })]); await runtime.app.close();
  });

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

  it("issues and redeems one-time pairing codes without pre-authentication", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "pairing-pepper"); const admin = security.createUser("Admin", "administrator"); const adminToken = security.issueDevice(admin.id, "Console").token; const runtime = createHost({ store, security, authMode: "required" }); const headers = { authorization: `Bearer ${adminToken}` };
    const issued = await runtime.app.inject({ method: "POST", url: "/api/v1/management/pairing-codes", headers, payload: { intendedRole: "consumer", ttlSeconds: 60 } }); expect(issued.statusCode).toBe(201); const code = issued.json().data.code;
    const redeemed = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/redeem", payload: { code, displayName: "Remote", deviceName: "Phone" } }); expect(redeemed.statusCode).toBe(201); const token = redeemed.json().data.token; const authenticated = await runtime.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${token}` } }); expect(authenticated.statusCode).toBe(200);
    const replay = await runtime.app.inject({ method: "POST", url: "/api/v1/pairing/redeem", payload: { code, displayName: "Replay", deviceName: "Other" } }); expect(replay.statusCode).toBe(403); await runtime.app.close();
  });

  it("stores bounded artifacts and serves content with defensive headers", async () => { const runtime = createHost(); const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Artifacts" } }); const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, payload: { title: "Preview" } }); const sessionId = session.json().data.id;
    const created = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, payload: { name: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("hello").toString("base64") } }); expect(created.statusCode).toBe(201); expect(created.json().data).toEqual(expect.objectContaining({ kind: "text", byteSize: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })); const content = await runtime.app.inject({ method: "GET", url: `/api/v1/artifacts/${created.json().data.id}/content` }); expect(content.body).toBe("hello"); expect(content.headers["x-content-type-options"]).toBe("nosniff"); expect(content.headers["content-disposition"]).toContain("attachment"); const removed = await runtime.app.inject({ method: "DELETE", url: `/api/v1/artifacts/${created.json().data.id}` }); expect(removed.statusCode).toBe(204); expect((await runtime.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}/artifacts` })).json().data).toEqual([]); await runtime.app.close(); });
});
