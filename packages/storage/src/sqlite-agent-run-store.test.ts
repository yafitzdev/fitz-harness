import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

describe("SqliteStore agent-run persistence", () => {
  it.each(["completed", "cancelled"] as const)("does not revive an older interruption after a newer %s run", (status) => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    try {
      store.createSession({ id: "s", title: "Recovered chat", status: "active", createdAt: now, updatedAt: now });
      const request = { model: "default", sessionId: "s", messages: [{ role: "user" as const, content: "hello" }] };
      store.createAgentRun({ id: "old", routeId: "default", sessionId: "s", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
      store.recoverInterruptedAgentRuns();
      expect(store.latestSessionAgentRun("s")?.id).toBe("old");
      // Equal creation timestamps must follow durable admission order, not UUID
      // order or the later timestamp stamped onto the old run during recovery.
      store.createAgentRun({ id: "new", routeId: "default", sessionId: "s", status, createdAt: now, updatedAt: now, lastSequence: 0 });
      store.recoverInterruptedAgentRuns();
      expect(store.latestSessionAgentRun("s")).toBeUndefined();
      expect(store.getAgentRun("old")).toMatchObject({ status: "interrupted", resumable: true });
    } finally { store.close(); }
  });

  it("recovers the newest failed attempt even when an older failure was updated later", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    try {
      store.createSession({ id: "s", title: "Retry", status: "active", createdAt: now, updatedAt: now });
      const request = { model: "default", sessionId: "s", messages: [{ role: "user" as const, content: "hello" }] };
      store.createAgentRun({ id: "old", routeId: "default", sessionId: "s", status: "failed", createdAt: now, updatedAt: new Date(2000).toISOString(), lastSequence: 0 }, request);
      store.createAgentRun({ id: "new", routeId: "default", sessionId: "s", status: "failed", createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), lastSequence: 0 }, request);
      store.recoverInterruptedAgentRuns();
      expect(store.latestSessionAgentRun("s")?.id).toBe("new");
    } finally { store.close(); }
  });

  it("keeps live work discoverable even when a newer run has finished", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    try {
      store.createSession({ id: "s", title: "Live chat", status: "active", createdAt: now, updatedAt: now });
      store.createAgentRun({ id: "live", routeId: "default", sessionId: "s", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 });
      store.createAgentRun({ id: "finished", routeId: "default", sessionId: "s", status: "completed", createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), lastSequence: 0 });
      expect(store.latestSessionAgentRun("s")?.id).toBe("live");
    } finally { store.close(); }
  });

  it("persists resumable runs and marks active runs interrupted on recovery", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createProject({ id: "p", name: "P", createdAt: now, updatedAt: now });
    store.createSession({ id: "s", projectId: "p", title: "S", status: "active", createdAt: now, updatedAt: now });
    const request = { model: "fast", sessionId: "s", accessMode: "full" as const, messages: [{ role: "user" as const, content: "continue me" }] };
    store.createAgentRun({ id: "run-1", routeId: "fast", sessionId: "s", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 1, timestamp: now, type: "run.created", data: {} });
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 2, timestamp: now, type: "reasoning.delta", data: { text: "durable thought" } });
    store.appendAgentEvent({ protocolVersion: "1", runId: "run-1", sequence: 3, timestamp: now, type: "tool.started", data: { toolCallId: "call-1", toolName: "write", input: { path: "a.txt" } } });

    expect(store.recoverInterruptedAgentRuns()).toBe(1);
    expect(store.getAgentRun("run-1")).toEqual(expect.objectContaining({
      status: "interrupted",
      resumable: true,
      checkpoint: expect.objectContaining({ resumeSafety: "review-required", sequence: 4 }),
    }));
    expect(store.getAgentRunRequest("run-1")).toEqual(request);
    expect(store.latestSessionAgentRun("s")?.id).toBe("run-1");
    expect(store.agentEventsAfter("run-1", 0).at(-1)?.type).toBe("run.interrupted");
    expect(store.transcriptAfter("s", 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reasoning", content: expect.objectContaining({ text: "durable thought", eventSequence: 2 }) }),
      expect.objectContaining({ kind: "tool-call", content: expect.objectContaining({ toolCallId: "call-1", eventSequence: 3 }) }),
    ]));
    expect(store.getSessionProjection("s")).toMatchObject({ sourceRevision: 2, transcriptEntryCount: 2, reasoningCount: 1, toolCallCount: 1 });
    expect(store.claimAgentRunResume("run-1")).toBe(true);
    expect(store.claimAgentRunResume("run-1")).toBe(false);
    store.createAgentRun({ id: "run-2", routeId: "fast", sessionId: "s", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request, "run-1");
    expect(store.agentRunResumedFrom("run-1")?.id).toBe("run-2");
    store.close();
  });

  it("reopens an orphaned continuation claim without reopening consumed sources", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
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
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    const request = { model: "fast", clientRequestId: "desktop:request-1", accessMode: "full" as const, messages: [{ role: "user" as const, content: "once" }] };
    store.createAgentRun({ id: "run-once", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    expect(store.agentRunForClientRequest("desktop:request-1")?.id).toBe("run-once");
    expect(() => store.createAgentRun({ id: "run-duplicate", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request)).toThrow();
    expect(store.getAgentRun("run-duplicate")).toBeUndefined();
    store.close();
  });

  it("commits terminal status and replay events atomically", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    const request = { model: "fast", messages: [{ role: "user" as const, content: "finish" }] };
    store.createAgentRun({ id: "atomic-run", routeId: "fast", status: "queued", createdAt: now, updatedAt: now, lastSequence: 0 }, request);
    store.appendAgentEvent({ protocolVersion: "1", runId: "atomic-run", sequence: 1, timestamp: now, type: "run.started", data: {} });
    expect(store.getAgentRun("atomic-run")?.status).toBe("running");
    store.appendAgentEvent({ protocolVersion: "1", runId: "atomic-run", sequence: 2, timestamp: now, type: "run.completed", data: {} });
    expect(store.getAgentRun("atomic-run")).toEqual(expect.objectContaining({
      status: "completed",
      lastSequence: 2,
      resumable: false,
      checkpoint: expect.objectContaining({ phase: "completed", sequence: 2 }),
    }));
    expect(store.agentEventsAfter("atomic-run", 1).map((event) => event.type)).toEqual(["run.completed"]);
    store.close();
  });
});
