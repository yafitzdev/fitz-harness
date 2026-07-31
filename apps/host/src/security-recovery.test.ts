import { describe, expect, it } from "vitest";
import { SecurityService } from "@fitz/security";
import { SqliteStore } from "@fitz/storage";
import { createHost } from "./create-app.js";

describe("host security and recovery boundaries", () => {
  it("enforces output, request-rate, and route quotas through both protocols", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "quota-pepper");
    const user = security.createUser("Limited"); security.setRouteGrants(user.id, ["fast"]);
    security.setQuota(user.id, { maxRequestsPerMinute: 1, maxPromptChars: 20, maxOutputTokens: 2, maxQueueDepth: 1 });
    const token = security.issueDevice(user.id, "Client").token; const headers = { authorization: `Bearer ${token}` };
    const runtime = createHost({ store, security, authMode: "required" });

    const outputDenied = await runtime.app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "fast", stream: false, max_tokens: 3, messages: [{ role: "user", content: "hello" }] } });
    expect(outputDenied.statusCode).toBe(429);
    const accepted = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", headers, payload: { model: "fast", maxTokens: 2, messages: [{ role: "user", content: "hello" }] } });
    expect(accepted.statusCode).toBe(202);
    const rateDenied = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", headers, payload: { model: "fast", maxTokens: 2, messages: [{ role: "user", content: "again" }] } });
    expect(rateDenied.statusCode).toBe(429);
    const routeDenied = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", headers, payload: { model: "default-agent", maxTokens: 2, messages: [{ role: "user", content: "route" }] } });
    expect(routeDenied.statusCode).toBe(403);
    await runtime.app.close();
  });

  it("prevents cross-user access to runs, sessions, artifacts, and approvals", async () => {
    const store = SqliteStore.memory(); const security = new SecurityService(store, "isolation-pepper");
    const first = security.createUser("First"); const second = security.createUser("Second");
    security.setRouteGrants(first.id, ["fast"]); security.setRouteGrants(second.id, ["fast"]);
    const firstHeaders = { authorization: `Bearer ${security.issueDevice(first.id, "One").token}` };
    const secondHeaders = { authorization: `Bearer ${security.issueDevice(second.id, "Two").token}` };
    const runtime = createHost({ store, security, authMode: "required" });
    const project = await runtime.app.inject({ method: "POST", url: "/api/v1/projects", headers: firstHeaders, payload: { name: "Private" } });
    const session = await runtime.app.inject({ method: "POST", url: `/api/v1/projects/${project.json().data.id}/sessions`, headers: firstHeaders, payload: { title: "Secrets" } });
    const sessionId = session.json().data.id;
    const artifact = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/artifacts`, headers: firstHeaders, payload: { name: "secret.txt", mimeType: "text/plain", contentBase64: Buffer.from("secret").toString("base64") } });
    const approval = await runtime.app.inject({ method: "POST", url: `/api/v1/sessions/${sessionId}/tool-approvals`, headers: firstHeaders, payload: { toolCallId: "call", toolName: "read", request: {} } });
    const run = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", headers: firstHeaders, payload: { model: "fast", sessionId, messages: [{ role: "user", content: "private" }] } });

    for (const [method, url] of [
      ["GET", `/api/v1/sessions/${sessionId}`],
      ["GET", `/api/v1/artifacts/${artifact.json().data.id}/content`],
      ["DELETE", `/api/v1/artifacts/${artifact.json().data.id}`],
      ["GET", `/api/v1/agent/runs/${run.json().data.id}`],
      ["POST", `/api/v1/tool-approvals/${approval.json().data.id}/decision`],
    ] as const) {
      const response = await runtime.app.inject({ method, url, headers: secondHeaders, ...(method === "POST" ? { payload: { decision: "approved" } } : {}) });
      expect(response.statusCode, url).toBe(403);
    }
    await runtime.app.close();
  });

  it("reports and persists interrupted inference and agent work during host restart", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.recordQueueEvent({ sequence: 1, protocolVersion: "1", timestamp: now, type: "queue.updated", data: { requestId: "inference-in-flight", routeId: "fast", position: 0, depth: 1, status: "started" } });
    store.createAgentRun({ id: "agent-in-flight", routeId: "fast", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 });
    const runtime = createHost({ store });
    const health = await runtime.app.inject({ method: "GET", url: "/health" });
    expect(health.json().recovery).toEqual({ interruptedRequests: 1, interruptedAgentRuns: 1 });
    expect(store.listInferenceRequests()).toEqual([expect.objectContaining({ id: "inference-in-flight", status: "interrupted", errorCode: "host_restarted" })]);
    expect(store.getAgentRun("agent-in-flight")).toEqual(expect.objectContaining({ status: "interrupted", error: "host_restarted" }));
    await runtime.app.close();
  });

  it("cancels a durable native run and refuses repeated cancellation", async () => {
    let cancelled = false;
    const runtime = createHost({ agentRuntime: { id: "blocking", run: () => {
      const events = (async function* () { while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 5)); const error = new Error("cancelled"); error.name = "AbortError"; throw error; yield { type: "assistant.delta" as const, text: "unreachable" }; })();
      return Object.assign(events, { cancel: () => { cancelled = true; } });
    } } });
    const created = await runtime.app.inject({ method: "POST", url: "/api/v1/agent/runs", payload: { model: "fast", messages: [{ role: "user", content: "wait" }] } });
    const runId = created.json().data.id;
    const cancel = await runtime.app.inject({ method: "DELETE", url: `/api/v1/agent/runs/${runId}` });
    expect(cancel.statusCode).toBe(202);
    for (let attempt = 0; attempt < 50 && runtime.agentRuns.get(runId)?.status !== "cancelled"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.agentRuns.get(runId)).toEqual(expect.objectContaining({ status: "cancelled" }));
    expect(runtime.agentRuns.eventsAfter(runId, 0).at(-1)?.type).toBe("run.cancelled");
    const repeated = await runtime.app.inject({ method: "DELETE", url: `/api/v1/agent/runs/${runId}` });
    expect(repeated.statusCode).toBe(409);
    await runtime.app.close();
  });
});
