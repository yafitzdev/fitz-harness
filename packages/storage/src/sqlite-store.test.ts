import type { EngineRegistration, MediaJobRecord, Recipe, Route } from "@fitz/protocol";
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
      id: "engine-1", folderName: "engine-1", displayName: "Engine 1", connectionMode: "managed", runtime: "wsl",
      baseUrl: "http://127.0.0.1:18080", healthPath: "/v1/models", launchCommand: "./serve", launchArguments: ["--port", "{port}"], workingDirectory: ".", wslDistribution: "Ubuntu",
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

  it("persists resumable agent runs and marks active runs interrupted on recovery", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now }); store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    const request = { model: "fast", sessionId: "s", accessMode: "full" as const, messages: [{ role: "user" as const, content: "continue me" }] };
    store.createAgentRun({ id: "run-1", routeId: "fast", sessionId: "s", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 1, timestamp: now, type: "run.created", data: {} });
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 2, timestamp: now, type: "reasoning.delta", data: { text: "durable thought" } });
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 3, timestamp: now, type: "tool.started", data: { toolCallId: "call-1", toolName: "write", input: { path: "a.txt" } } });
    expect(store.recoverInterruptedAgentRuns()).toBe(1);
    expect(store.getAgentRun("run-1")).toEqual(expect.objectContaining({ status: "interrupted", resumable: true, checkpoint: expect.objectContaining({ resumeSafety: "review-required", sequence: 4 }) }));
    expect(store.getAgentRunRequest("run-1")).toEqual(request);
    expect(store.latestSessionAgentRun("s")?.id).toBe("run-1");
    expect(store.agentEventsAfter("run-1", 0).at(-1)?.type).toBe("run.interrupted");
    expect(store.transcriptAfter("s", 0)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reasoning", content: expect.objectContaining({ text: "durable thought", eventSequence: 2 }) }), expect.objectContaining({ kind: "tool-call", content: expect.objectContaining({ toolCallId: "call-1", eventSequence: 3 }) })]));
    expect(store.claimAgentRunResume("run-1")).toBe(true); expect(store.claimAgentRunResume("run-1")).toBe(false);
    store.createAgentRun({ id: "run-2", routeId: "fast", sessionId: "s", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request, "run-1");
    expect(store.agentRunResumedFrom("run-1")?.id).toBe("run-2"); store.close();
  });

  it("reopens an orphaned continuation claim after restart without reopening consumed sources", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    const request = { model: "fast", accessMode: "full" as const, messages: [{ role: "user" as const, content: "continue" }] };
    store.createAgentRun({ id: "source", routeId: "fast", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    store.appendAgentEvent({ protocolVersion: "1", runId: "source", sequence: 1, timestamp: now, type: "run.failed", data: { error: "lost" } });
    expect(store.claimAgentRunResume("source")).toBe(true);
    store.recoverInterruptedAgentRuns();
    expect(store.getAgentRun("source")?.resumable).toBe(true);
    expect(store.claimAgentRunResume("source")).toBe(true);
    store.createAgentRun({ id: "child", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request, "source");
    store.recoverInterruptedAgentRuns();
    expect(store.getAgentRun("source")?.resumable).toBe(false);
    store.close();
  });

  it("maps one client request identity to one durable run", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    const request = { model: "fast", clientRequestId: "desktop:request-1", accessMode: "full" as const, messages: [{ role: "user" as const, content: "once" }] };
    store.createAgentRun({ id: "run-once", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    expect(store.agentRunForClientRequest("desktop:request-1")?.id).toBe("run-once");
    expect(() => store.createAgentRun({ id: "run-duplicate", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request)).toThrow();
    expect(store.getAgentRun("run-duplicate")).toBeUndefined();
    store.close();
  });

  it("commits terminal run status and its replay event atomically", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    const request = { model: "fast", messages: [{ role: "user" as const, content: "finish" }] };
    store.createAgentRun({ id: "atomic-run", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    store.appendAgentEvent({ protocolVersion: "1", runId: "atomic-run", sequence: 1, timestamp: now, type: "run.started", data: {} });
    expect(store.getAgentRun("atomic-run")?.status).toBe("running");
    store.appendAgentEvent({ protocolVersion: "1", runId: "atomic-run", sequence: 2, timestamp: now, type: "run.completed", data: {} });
    expect(store.getAgentRun("atomic-run")).toEqual(expect.objectContaining({ status: "completed", lastSequence: 2, resumable: false, checkpoint: expect.objectContaining({ phase: "completed", sequence: 2 }) }));
    expect(store.agentEventsAfter("atomic-run", 1).map((event) => event.type)).toEqual(["run.completed"]);
    store.close();
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
    store.upsertToolPolicy({ subjectType: "role", subjectId: "consumer", toolName: "bash", decision: "deny", updatedAt: now }); expect(store.resolveToolPolicy(undefined, "consumer", "bash")).toBe("deny"); expect(store.resolveToolPolicy(undefined, "consumer", "read")).toBe("ask");
    store.createToolApproval({ id: "approval-1", sessionId: "session-1", toolCallId: "call-1", toolName: "read", status: "pending", request: { path: "README.md" }, requestedAt: now }); expect(store.resolveToolApproval("approval-1", "approved", "user-1")).toBe(true); expect(store.getToolApproval("approval-1")?.status).toBe("approved"); store.createToolApproval({ id: "approval-2", sessionId: "session-1", toolCallId: "call-2", toolName: "bash", status: "pending", request: {}, requestedAt: now }); expect(store.cancelToolApproval("approval-2", "cancelled")).toBe(true); expect(store.getToolApproval("approval-2")?.status).toBe("cancelled"); store.close();
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

  it("persists media jobs, partial updates, filters, and restart recovery", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "media-project", name: "Media", createdAt: now, updatedAt: now });
    store.createSession({ id: "session-1", projectId: "media-project", title: "Media", status: "active", createdAt: now, updatedAt: now });
    const job: MediaJobRecord = {
      id: "job-1", sessionId: "session-1", routeId: "video", modality: "video", status: "queued",
      execution: { recipeId: "h3", recipeDisplayName: "MiniMax H3", modelId: "minimax-h3", adapter: "media-fake" },
      params: { prompt: "a cat", durationSeconds: 5 }, enqueuedAt: now, createdByUserId: "user-1", creditCostCents: 3,
    };
    store.createMediaJob(job);
    expect(store.getMediaJob("job-1")).toEqual(job);
    store.updateMediaJob("job-1", { status: "started", startedAt: now, providerJobId: "provider-1", progress: 0.25 });
    expect(store.getMediaJob("job-1")).toEqual(expect.objectContaining({ status: "started", startedAt: now, providerJobId: "provider-1", progress: 0.25, sessionId: "session-1" }));
    expect(store.listMediaJobs({ ownerUserId: "user-1" })).toHaveLength(1);
    expect(store.listMediaJobs({ sessionId: "session-1" })).toHaveLength(1);
    expect(store.listMediaJobs({ sessionId: "another-session" })).toHaveLength(0);
    expect(store.listMediaJobs({ status: "queued" })).toHaveLength(0);
    expect(store.countNonTerminalMediaJobs("user-1", now)).toBe(1);
    expect(store.recoverInterruptedMediaJobs()).toBe(1);
    expect(store.getMediaJob("job-1")).toEqual(expect.objectContaining({ status: "interrupted", errorCode: "host_restarted" }));
    store.close();
  });

  it("appends sequenced media job events and replays after a sequence", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createMediaJob({ id: "job-1", routeId: "video", modality: "video", status: "queued", params: { prompt: "x" }, enqueuedAt: now });
    const first = store.appendMediaJobEvent("job-1", { type: "progress", progress: 0.5 }, now);
    const second = store.appendMediaJobEvent("job-1", { type: "completed", result: { data: { url: "https://example.com/out.mp4" }, mimeType: "video/mp4", byteSize: 1024 } }, now);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(store.mediaJobEventsAfter("job-1", 0)).toEqual([first, second]);
    expect(store.mediaJobEventsAfter("job-1", 1)).toEqual([second]);
    expect(store.mediaJobEventsAfter("missing", 0)).toEqual([]);
    store.close();
  });

  it("accumulates the media credit ledger per user within a window", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createMediaJob({ id: "job-1", routeId: "image", modality: "image", status: "completed", params: { prompt: "x" }, enqueuedAt: now, createdByUserId: "user-1" });
    store.createMediaJob({ id: "job-2", routeId: "image", modality: "image", status: "completed", params: { prompt: "y" }, enqueuedAt: now, createdByUserId: "user-2" });
    store.appendMediaCredit({ id: "c-1", userId: "user-1", jobId: "job-1", modality: "image", costCents: 3, createdAt: now });
    store.appendMediaCredit({ id: "c-2", userId: "user-1", jobId: "job-1", modality: "image", costCents: 7, createdAt: now });
    store.appendMediaCredit({ id: "c-3", userId: "user-2", jobId: "job-2", modality: "image", costCents: 100, createdAt: now });
    expect(store.sumMediaLedgerForUser("user-1", now)).toBe(10);
    expect(store.sumMediaLedgerForUser("user-1", new Date(1).toISOString())).toBe(0);
    expect(store.sumMediaLedgerForUser("user-2", now)).toBe(100);
    store.close();
  });

  it("detaches media jobs from deleted sessions without deleting the job", () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createProject({ id: "mp", name: "Media", createdAt: now, updatedAt: now });
    store.createSession({ id: "ms", projectId: "mp", title: "Media", status: "active", createdAt: now, updatedAt: now });
    store.createMediaJob({ id: "job-1", sessionId: "ms", routeId: "image", modality: "image", status: "queued", params: { prompt: "x" }, enqueuedAt: now });
    expect(store.deleteProject("mp")).toBe(true);
    expect(store.getSession("ms")).toBeUndefined();
    const detached = store.getMediaJob("job-1");
    expect(detached?.id).toBe("job-1");
    expect(detached?.sessionId).toBeUndefined();
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
