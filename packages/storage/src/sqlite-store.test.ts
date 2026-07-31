import type { Recipe, Route } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("SqliteStore", () => {
  it("migrates and round-trips routes, recipes, settings, and events", () => {
    const store = SqliteStore.memory();
    const recipe: Recipe = {
      id: "recipe-1",
      playbookId: "playbook-1",
      displayName: "Recipe 1",
      adapter: "fake",
      modelId: "fake-1",
      contextTokens: 100_000,
      capabilities: {
        chatCompletions: true,
        streaming: true,
        toolCalls: false,
        responseFormat: false,
        minP: false,
        maxConcurrentGenerations: 1,
      },
      lifecycle: {
        loadPolicy: "onDemand",
        evictionPolicy: "idle-ttl",
        idleTtlSeconds: 60,
        minimumResidencySeconds: 0,
      },
      configuration: { example: true },
    };
    const route: Route = {
      id: "default-agent",
      displayName: "Default",
      recipeId: recipe.id,
      enabled: true,
      isDefault: true,
    };

    store.upsertRecipe(recipe);
    store.upsertRoute(route);
    store.setSetting("test", { enabled: true });
    store.appendLifecycleEvent({
      sequence: 1,
      protocolVersion: "1",
      timestamp: new Date(0).toISOString(),
      type: "instance.state.changed",
      data: { previousState: "UNLOADED", state: "PREPARING" },
    });

    expect(store.listRecipes()).toEqual([recipe]);
    expect(store.listRoutes()).toEqual([route]);
    expect(store.getSetting("test")).toEqual({ enabled: true });
    expect(store.lifecycleEventsAfter(0)).toHaveLength(1);

    store.recordQueueEvent({
      sequence: 2,
      protocolVersion: "1",
      timestamp: new Date(1).toISOString(),
      type: "queue.updated",
      data: {
        requestId: "request-1",
        routeId: "default-agent",
        position: 1,
        depth: 1,
        status: "queued",
      },
    });
    store.recordQueueEvent({
      sequence: 3,
      protocolVersion: "1",
      timestamp: new Date(2).toISOString(),
      type: "queue.updated",
      data: {
        requestId: "request-1",
        routeId: "default-agent",
        position: 0,
        depth: 1,
        status: "completed",
      },
    });
    expect(store.listInferenceRequests()).toEqual([
      expect.objectContaining({ id: "request-1", status: "completed" }),
    ]);
    store.close();
  });

  it("persists users, grants, quotas, devices, and audit records", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createUser({ id: "user-1", displayName: "Admin", role: "administrator", status: "active", createdAt: now, updatedAt: now });
    store.createDevice({ id: "device-1", userId: "user-1", name: "Workstation", createdAt: now }, "hashed-token");
    store.replaceUserRouteGrants("user-1", ["fast"]);
    const quota = { maxRequestsPerMinute: 10, maxPromptChars: 100, maxOutputTokens: 20, maxQueueDepth: 2 }; store.setUserQuota("user-1", quota);
    store.appendAuditEvent({ id: "audit-1", timestamp: now, actorUserId: "user-1", action: "test", detail: { safe: true } });
    expect(store.findDeviceByTokenHash("hashed-token")?.user.role).toBe("administrator");
    expect(store.listDevices("user-1")[0]).not.toHaveProperty("tokenHash");
    expect(store.listUserRouteGrants("user-1")).toEqual(["fast"]); expect(store.getUserQuota("user-1")).toEqual(quota); expect(store.listAuditEvents()).toHaveLength(1); store.close();
  });

  it("persists resumable agent runs and marks active runs interrupted on recovery", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createAgentRun({ id: "run-1", routeId: "fast", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 });
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 1, timestamp: now, type: "run.created", data: {} }); expect(store.agentEventsAfter("run-1", 0)).toHaveLength(1); expect(store.getAgentRun("run-1")?.lastSequence).toBe(1);
    expect(store.recoverInterruptedAgentRuns()).toBe(1); expect(store.getAgentRun("run-1")?.status).toBe("interrupted"); store.close();
  });

  it("persists projects, sessions, canonical transcripts, tool policy, and approvals", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "project-1", name: "Fitz", createdAt: now, updatedAt: now }); store.createSession({ id: "session-1", projectId: "project-1", title: "Build", status: "active", createdAt: now, updatedAt: now });
    const first = store.appendTranscriptEntry({ id: "entry-1", sessionId: "session-1", kind: "message", role: "user", content: { text: "hello" }, createdAt: now }); const second = store.appendTranscriptEntry({ id: "entry-2", sessionId: "session-1", kind: "message", role: "assistant", content: { text: "hi" }, createdAt: now }); expect([first.sequence, second.sequence]).toEqual([1, 2]); expect(store.transcriptAfter("session-1", 1)).toEqual([second]);
    store.upsertToolPolicy({ subjectType: "role", subjectId: "consumer", toolName: "bash", decision: "deny", updatedAt: now }); expect(store.resolveToolPolicy(undefined, "consumer", "bash")).toBe("deny"); expect(store.resolveToolPolicy(undefined, "consumer", "read")).toBe("ask");
    store.createToolApproval({ id: "approval-1", sessionId: "session-1", toolCallId: "call-1", toolName: "read", status: "pending", request: { path: "README.md" }, requestedAt: now }); expect(store.resolveToolApproval("approval-1", "approved", "user-1")).toBe(true); expect(store.getToolApproval("approval-1")?.status).toBe("approved"); store.close();
  });

  it("stores and removes artifact content with its metadata", () => { const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "ap", name: "Artifacts", createdAt: now, updatedAt: now }); store.createSession({ id: "as", projectId: "ap", title: "Artifacts", status: "active", createdAt: now, updatedAt: now }); const artifact = { id: "a1", sessionId: "as", name: "result.txt", mimeType: "text/plain", kind: "text" as const, byteSize: 5, sha256: "hash", createdAt: now, metadata: {} }; store.createArtifact(artifact, Buffer.from("hello")); expect(store.listArtifacts("as")).toEqual([artifact]); expect(Buffer.from(store.getArtifactContent("a1")!).toString()).toBe("hello"); expect(store.deleteArtifact("a1")).toBe(true); expect(store.getArtifact("a1")).toBeUndefined(); expect(store.getArtifactContent("a1")).toBeUndefined(); expect(store.deleteArtifact("a1")).toBe(false); store.close(); });
});
