import type { EngineRegistration, Recipe, Route } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { MemoryBlobStore } from "./blob-store.js";

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
    const engine: EngineRegistration = {
      id: "engine-1", folderName: "engine-1", displayName: "Engine 1", connectionMode: "managed", runtime: "linux-managed",
      baseUrl: "http://127.0.0.1:18080", healthPath: "/v1/models", launchCommand: "./serve", launchArguments: ["--port", "{port}"], workingDirectory: ".", runtimeId: "inference-linux",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };

    store.upsertEngine(engine);
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

    expect(store.listEngines()).toEqual([engine]);
    expect(store.getEngine(engine.id)).toEqual(engine);
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
        kind: "chat",
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
        kind: "chat",
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

  it("routes non-secret settings through a canonical backend but keeps security material private", () => {
    const store = SqliteStore.memory();
    store.setSetting("legacy", 1);
    const values = new Map<string, unknown>();
    store.useSettingsBackend({
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: (key, value) => { values.set(key, value); },
      delete: (key) => values.delete(key),
    });
    store.setSetting("engineRoot", "D:\\engines");
    store.setSetting("security.authPepper", "private");
    expect(store.getSetting("engineRoot")).toBe("D:\\engines");
    expect(store.getSetting("security.authPepper")).toBe("private");
    expect(store.listLegacySettings()).toMatchObject({ legacy: 1, "security.authPepper": "private" });
    store.close();
  });

  it("aggregates usage by owning user", () => {
    const store = SqliteStore.memory();
    store.recordRequestUsage({ id: "alice-1", kind: "chat", status: "completed", routeId: "default", ownerUserId: "alice", executionLane: "gpu", enqueuedAt: "2026-08-09T10:00:00.000Z", completedAt: "2026-08-09T10:00:01.000Z", promptTokens: 10, completionTokens: 5, durationMs: 1000 });
    store.recordRequestUsage({ id: "bob-1", kind: "image", status: "failed", routeId: "image", ownerUserId: "bob", executionLane: "gpu", enqueuedAt: "2026-08-09T11:00:00.000Z", completedAt: "2026-08-09T11:00:02.000Z", durationMs: 2000 });
    expect(store.userUsageSummaries({ from: "2026-08-09T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" })).toEqual([
      expect.objectContaining({ ownerUserId: "bob", requests: 1, failed: 1, mediaJobs: 1 }),
      expect.objectContaining({ ownerUserId: "alice", requests: 1, totalTokens: 15 }),
    ]);
    store.close();
  });

  it("deletes obsolete routes", () => {
    const store = SqliteStore.memory();
    store.upsertRoute({ id: "obsolete", displayName: "Obsolete", recipeId: "recipe-1", enabled: true });
    store.deleteRoute("obsolete");
    expect(store.listRoutes()).toEqual([]);
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

  it("persists projects, sessions, canonical transcripts, tool policy, and approvals", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "project-1", name: "Fitz", createdAt: now, updatedAt: now }); store.createSession({ id: "session-1", projectId: "project-1", title: "Build", status: "active", connectionId: "cohere", routeId: "smart", createdAt: now, updatedAt: now });
    expect(store.getSession("session-1")).toEqual(expect.objectContaining({ connectionId: "cohere", routeId: "smart" }));
    const first = store.appendTranscriptEntry({ id: "entry-1", sessionId: "session-1", kind: "message", role: "user", content: { text: "hello" }, createdAt: now }); const second = store.appendTranscriptEntry({ id: "entry-2", sessionId: "session-1", kind: "message", role: "assistant", content: { text: "hi" }, createdAt: now });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(store.transcriptAfter("session-1", 1)).toEqual([second]);
    expect(store.transcriptBefore("session-1", Number.MAX_SAFE_INTEGER, 1)).toEqual([second]);
    expect(store.transcriptBefore("session-1", second.sequence, 1)).toEqual([first]);
    expect(store.hasTranscriptBefore("session-1", second.sequence)).toBe(true);
    expect(store.hasTranscriptBefore("session-1", first.sequence)).toBe(false);
    expect(store.deleteTranscriptFrom("session-1", 2)).toBe(1);
    expect(store.transcriptAfter("session-1", 0)).toEqual([first]);
    store.upsertToolPolicy({ subjectType: "role", subjectId: "consumer", toolName: "bash", decision: "deny", updatedAt: now }); expect(store.resolveToolPolicy(undefined, "consumer", "bash")).toBe("deny"); expect(store.resolveToolPolicy(undefined, "consumer", "read")).toBe("ask");
    store.createToolApproval({ id: "approval-1", sessionId: "session-1", toolCallId: "call-1", toolName: "read", status: "pending", request: { path: "README.md" }, requestedAt: now }); expect(store.resolveToolApproval("approval-1", "approved", "user-1")).toBe(true); expect(store.getToolApproval("approval-1")?.status).toBe("approved"); store.createToolApproval({ id: "approval-2", sessionId: "session-1", toolCallId: "call-2", toolName: "bash", status: "pending", request: {}, requestedAt: now }); expect(store.cancelToolApproval("approval-2", "cancelled")).toBe(true); expect(store.getToolApproval("approval-2")?.status).toBe("cancelled"); store.close();
  });

  it("persists Fast as a selectable session route", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createSession({
      id: "fast-session",
      title: "Fast cloud",
      status: "active",
      routeId: "fast",
      createdAt: now,
      updatedAt: now,
    });
    expect(store.getSession("fast-session")?.routeId).toBe("fast");
    store.close();
  });

  it("removes projects and their session data without deleting run history", () => { const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "remove-project", name: "Remove", createdAt: now, updatedAt: now }); store.createSession({ id: "remove-session", projectId: "remove-project", title: "Remove", status: "active", createdAt: now, updatedAt: now }); store.createAgentRun({ id: "remove-run", routeId: "fast", sessionId: "remove-session", status: "completed", createdAt: now, updatedAt: now, lastSequence: 0 }); expect(store.deleteProject("remove-project")).toBe(true); expect(store.getProject("remove-project")).toBeUndefined(); expect(store.getSession("remove-session")).toBeUndefined(); expect(store.getAgentRun("remove-run")?.sessionId).toBeUndefined(); expect(store.deleteProject("remove-project")).toBe(false); store.close(); });

  it("removes one session and detaches its retained run history", () => { const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createSession({ id: "remove-chat", title: "Remove", status: "active", createdAt: now, updatedAt: now }); store.createAgentRun({ id: "chat-run", routeId: "fast", sessionId: "remove-chat", status: "completed", createdAt: now, updatedAt: now, lastSequence: 0 }); expect(store.deleteSession("remove-chat")).toBe(true); expect(store.getSession("remove-chat")).toBeUndefined(); expect(store.getAgentRun("chat-run")?.sessionId).toBeUndefined(); expect(store.deleteSession("remove-chat")).toBe(false); store.close(); });

  it("persists standalone chats with no project and keeps them out of project listings", () => { const store = SqliteStore.memory(); const now = new Date(0).toISOString(); store.createProject({ id: "chat-project", name: "Fitz", createdAt: now, updatedAt: now }); store.createSession({ id: "chat-1", title: "Standalone", status: "active", createdAt: now, updatedAt: now }); store.createSession({ id: "chat-2", projectId: "chat-project", title: "Wrapped", status: "active", createdAt: now, updatedAt: now }); const chat = store.getSession("chat-1"); expect(chat?.title).toBe("Standalone"); expect(chat?.projectId).toBeUndefined(); expect(store.listStandaloneSessions()).toEqual([expect.objectContaining({ id: "chat-1", title: "Standalone" })]); expect(store.listSessions("chat-project")).toEqual([expect.objectContaining({ id: "chat-2" })]); store.createSession({ id: "chat-3", title: "Mine", status: "active", ownerUserId: "user-1", createdAt: now, updatedAt: now }); store.createSession({ id: "chat-4", title: "Theirs", status: "active", ownerUserId: "user-2", createdAt: now, updatedAt: now }); expect(store.listStandaloneSessions("user-1").map((session) => session.id)).toEqual(["chat-3"]); store.close(); });

  it("stores and removes artifact content outside SQLite", async () => { const store = SqliteStore.memory(); const artifacts = new ArtifactRepository(store, new MemoryBlobStore()); const now = new Date(0).toISOString(); store.createProject({ id: "ap", name: "Artifacts", createdAt: now, updatedAt: now }); store.createSession({ id: "as", projectId: "ap", title: "Artifacts", status: "active", createdAt: now, updatedAt: now }); const artifact = await artifacts.create({ id: "a1", sessionId: "as", name: "result.txt", mimeType: "text/plain", kind: "text" as const, createdAt: now, metadata: {} }, Buffer.from("hello")); expect(store.listArtifacts("as")).toEqual([artifact]); expect(Buffer.from((await artifacts.read("a1"))!).toString()).toBe("hello"); expect(await artifacts.delete("a1")).toBe(true); expect(store.getArtifact("a1")).toBeUndefined(); expect(await artifacts.read("a1")).toBeUndefined(); expect(await artifacts.delete("a1")).toBe(false); store.close(); });

  it("round-trips media route kinds and keeps chat routes unchanged", () => {
    const store = SqliteStore.memory();
    store.upsertRoute({ id: "chat-1", displayName: "Chat", recipeId: "recipe-1", enabled: true });
    store.upsertRoute({ id: "image", displayName: "Image", recipeId: "recipe-2", kind: "image", enabled: false });
    const routes = store.listRoutes();
    expect(routes.find((route) => route.id === "chat-1")).toEqual({ id: "chat-1", displayName: "Chat", recipeId: "recipe-1", enabled: true });
    expect(routes.find((route) => route.id === "image")).toEqual(expect.objectContaining({ id: "image", displayName: "Image", recipeId: "recipe-2", kind: "image", enabled: false }));
    store.close();
  });

  it("accounts terminal requests idempotently and aggregates nullable token telemetry", () => {
    const store = SqliteStore.memory();
    store.recordRequestUsage({
      id: "chat-usage", kind: "chat", status: "completed", routeId: "smart", recipeId: "reasoner", playbookId: "ninfer", adapter: "ninfer", modelId: "qwen",
      ownerUserId: "user-1", executionLane: "gpu", enqueuedAt: "2026-08-09T10:00:00.000Z", startedAt: "2026-08-09T10:00:01.000Z",
      firstOutputAt: "2026-08-09T10:00:03.000Z", completedAt: "2026-08-09T10:00:09.000Z", queueWaitMs: 1_000, ttftMs: 2_000, durationMs: 8_000,
    });
    // A terminal replay enriches the same request instead of double-counting it.
    store.recordRequestUsage({
      id: "chat-usage", kind: "chat", status: "completed", routeId: "smart", recipeId: "reasoner", playbookId: "ninfer", adapter: "ninfer", modelId: "qwen",
      ownerUserId: "user-1", executionLane: "gpu", enqueuedAt: "2026-08-09T10:00:00.000Z", startedAt: "2026-08-09T10:00:01.000Z",
      firstOutputAt: "2026-08-09T10:00:03.000Z", completedAt: "2026-08-09T10:00:09.000Z", queueWaitMs: 1_000, ttftMs: 2_000, durationMs: 8_000,
      promptTokens: 120, completionTokens: 30,
    });
    // A contradictory terminal replay cannot rewrite the original outcome.
    store.recordRequestUsage({
      id: "chat-usage", kind: "chat", status: "interrupted", routeId: "different", executionLane: "cloud",
      enqueuedAt: "2026-08-09T12:00:00.000Z", completedAt: "2026-08-09T12:00:01.000Z",
    });
    store.recordRequestUsage({
      id: "image-usage", kind: "image", status: "failed", routeId: "image", recipeId: "flux", executionLane: "gpu",
      enqueuedAt: "2026-08-09T11:00:00.000Z", completedAt: "2026-08-09T11:00:04.000Z", durationMs: 4_000, errorCode: "generation_failed",
    });

    const report = store.usageReport({ from: "2026-08-09T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z", bucket: "hour" });
    expect(report.totals).toEqual(expect.objectContaining({ requests: 2, successful: 1, failed: 1, mediaJobs: 1, promptTokens: 120, completionTokens: 30, totalTokens: 150, tokenReportedRequests: 1 }));
    expect(report.totals.interrupted).toBe(0);
    expect(report.timeline).toHaveLength(2);
    expect(report.routes).toEqual(expect.arrayContaining([expect.objectContaining({ key: "smart", requests: 1, totalTokens: 150 })]));
    expect(report.recipes).toEqual(expect.arrayContaining([expect.objectContaining({ key: "reasoner", label: "qwen" })]));
    expect(report.modalities).toEqual(expect.arrayContaining([expect.objectContaining({ key: "image", label: "Images", failed: 1 })]));
    const ownerReport = store.usageReport({ from: "2026-08-09T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z", bucket: "day", ownerUserId: "user-1" });
    expect(ownerReport.totals.requests).toBe(1);
    expect(store.listRequestUsageForRun("missing")).toEqual([]);
    store.close();
  });

  it("lists exact request telemetry for an agent run in model-turn order", () => {
    const store = SqliteStore.memory();
    store.recordRequestUsage({ id: "second", kind: "chat", status: "completed", routeId: "local", runId: "run-1", executionLane: "gpu", enqueuedAt: "2026-08-09T10:00:10.000Z", completedAt: "2026-08-09T10:00:12.000Z", ttftMs: 800, generationMs: 1_200, promptTokens: 200, completionTokens: 60 });
    store.recordRequestUsage({ id: "first", kind: "chat", status: "completed", routeId: "local", runId: "run-1", executionLane: "gpu", enqueuedAt: "2026-08-09T10:00:00.000Z", completedAt: "2026-08-09T10:00:02.000Z", ttftMs: 500, generationMs: 1_500, promptTokens: 100, completionTokens: 30 });
    store.recordRequestUsage({ id: "other", kind: "chat", status: "completed", routeId: "local", runId: "run-2", executionLane: "gpu", enqueuedAt: "2026-08-09T10:00:00.000Z", completedAt: "2026-08-09T10:00:01.000Z" });

    expect(store.listRequestUsageForRun("run-1")).toEqual([
      expect.objectContaining({ id: "first", ttftMs: 500, promptTokens: 100 }),
      expect.objectContaining({ id: "second", generationMs: 1_200, completionTokens: 60 }),
    ]);
    store.close();
  });
});
