import type { AgentRuntime, AgentRuntimeRun } from "@fitz/agent-core";
import type { InferenceScheduler } from "@fitz/inference-core";
import type { AgentRunRequest } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { describe, expect, it } from "vitest";
import { AgentRunCoordinator } from "./agent-runs.js";

class ControlledRuntime implements AgentRuntime {
  readonly id = "controlled";
  readonly starts: string[] = [];
  readonly #releases = new Map<string, () => void>();

  run(request: AgentRunRequest): AgentRuntimeRun {
    const label = request.messages[0]?.content ?? "unknown";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#releases.set(label, release);
    const starts = this.starts;
    return {
      cancel: release,
      async *[Symbol.asyncIterator]() {
        starts.push(label);
        await gate;
        yield { type: "assistant.delta", text: `done:${label}` };
      },
    };
  }

  release(label: string): void { this.#releases.get(label)?.(); }
}

describe("AgentRunCoordinator", () => {
  it("correlates assistant output and its transcript with the exact model request", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createSession({ id: "correlated", title: "Correlated", status: "active", createdAt: now, updatedAt: now });
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const run = coordinator.start({ model: "default", sessionId: "correlated", messages: [{ role: "user", content: "trace" }] });
    await waitFor(() => runtime.starts.includes("trace"));

    coordinator.recordModelRequest({
      sequence: 42,
      protocolVersion: "1",
      timestamp: new Date(1).toISOString(),
      type: "queue.updated",
      data: { requestId: "request-42", routeId: "default", kind: "chat", lane: "gpu", runId: run.id, sessionId: "correlated", position: 0, depth: 1, status: "started" },
    });
    runtime.release("trace");
    await waitFor(() => coordinator.get(run.id)?.status === "completed");

    const events = coordinator.eventsAfter(run.id, 0);
    expect(events).toContainEqual(expect.objectContaining({ type: "model.request.updated", data: expect.objectContaining({ requestId: "request-42", lifecycleSequence: 42 }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant.delta", data: expect.objectContaining({ text: "done:trace", requestId: "request-42" }) }));
    expect(store.transcriptAfter("correlated", 0)).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      content: expect.objectContaining({ text: "done:trace", requestId: "request-42" }),
    }));
    store.close();
  });

  it("persists retry and terminal failure notices in the session transcript", async () => {
    const store = SqliteStore.memory(); const now = new Date(0).toISOString();
    store.createSession({ id: "notices", title: "Notices", status: "active", createdAt: now, updatedAt: now });
    const runtime: AgentRuntime = { id: "failure", run: () => ({ cancel: () => undefined, async *[Symbol.asyncIterator]() { throw new Error("provider unavailable"); } }) };
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const run = coordinator.start({ model: "default", sessionId: "notices", clientRetryCount: 1, messages: [{ role: "user", content: "hello" }] });
    await waitFor(() => coordinator.get(run.id)?.status === "failed");
    expect(store.transcriptAfter("notices", 0).filter((entry) => entry.kind === "run-notice").map((entry) => entry.content.type)).toEqual(["retry", "failure"]);
    store.close();
  });

  it("round-robins complete agent turns across owners", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(
      store,
      {} as InferenceScheduler,
      runtime,
      undefined,
      256,
      1,
    );
    const start = (owner: string, label: string) => coordinator.start(
      { model: "default", messages: [{ role: "user", content: label }] },
      owner,
    );

    start("a", "a0");
    await waitFor(() => runtime.starts.length === 1);
    start("a", "a1"); start("a", "a2"); start("b", "b1"); start("b", "b2");
    for (const label of ["a0", "b1", "a1", "b2", "a2"]) {
      await waitFor(() => runtime.starts.at(-1) === label);
      runtime.release(label);
    }
    await waitFor(() => coordinator.queue().length === 0);

    expect(runtime.starts).toEqual(["a0", "b1", "a1", "b2", "a2"]);
    expect(coordinator.list(undefined, 10).every((run) => run.status === "completed")).toBe(true);
    store.close();
  });

  it("runs different owners concurrently while serializing each owner", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime, undefined, 256, 3, 1);

    coordinator.start({ model: "default", messages: [{ role: "user", content: "a0" }] }, "a");
    coordinator.start({ model: "default", messages: [{ role: "user", content: "a1" }] }, "a");
    coordinator.start({ model: "default", messages: [{ role: "user", content: "b0" }] }, "b");
    await waitFor(() => runtime.starts.length === 2);

    expect(new Set(runtime.starts)).toEqual(new Set(["a0", "b0"]));
    expect(runtime.starts).not.toContain("a1");
    runtime.release("a0");
    await waitFor(() => runtime.starts.includes("a1"));
    runtime.release("a1");
    runtime.release("b0");
    await waitFor(() => coordinator.queue().length === 0);
    store.close();
  });

  it("interrupts queued and active runs durably during shutdown", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime, undefined, 256, 1, 1);
    const active = coordinator.start({ model: "default", messages: [{ role: "user", content: "active" }] }, "a");
    const queued = coordinator.start({ model: "default", messages: [{ role: "user", content: "queued" }] }, "b");
    await waitFor(() => runtime.starts.includes("active"));

    await coordinator.shutdown();

    expect(coordinator.get(active.id)?.status).toBe("interrupted");
    expect(coordinator.get(queued.id)?.status).toBe("interrupted");
    expect(() => coordinator.start({ model: "default", messages: [{ role: "user", content: "late" }] })).toThrow("shutting down");
    store.close();
  });

  it("does not misclassify a runtime abort as a user cancellation", async () => {
    const store = SqliteStore.memory();
    const abort = Object.assign(new Error("runtime stream disappeared"), { name: "AbortError" });
    const runtime: AgentRuntime = { id: "aborted", run: () => ({ cancel: () => undefined, async *[Symbol.asyncIterator]() { throw abort; } }) };
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const run = coordinator.start({ model: "default", messages: [{ role: "user", content: "hello" }] });

    await waitFor(() => coordinator.get(run.id)?.status === "interrupted");

    expect(coordinator.eventsAfter(run.id, 0)).toContainEqual(expect.objectContaining({
      type: "run.interrupted",
      data: expect.objectContaining({ error: "runtime_interrupted", detail: "runtime stream disappeared", resumable: true }),
    }));
    store.close();
  });

  it("still records an explicit user stop as cancelled", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const run = coordinator.start({ model: "default", messages: [{ role: "user", content: "stop-me" }] });
    await waitFor(() => runtime.starts.includes("stop-me"));

    expect(coordinator.cancel(run.id)).toBe(true);
    await waitFor(() => coordinator.get(run.id)?.status === "cancelled");

    expect(coordinator.eventsAfter(run.id, 0).at(-1)?.type).toBe("run.cancelled");
    store.close();
  });

  it("waits for asynchronous terminal hooks before shutdown returns", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    let releaseHook!: () => void;
    let hookStarted = false;
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime, async () => {
      hookStarted = true;
      await hookGate;
    });
    coordinator.start({ model: "default", messages: [{ role: "user", content: "run" }] }, "a");
    await waitFor(() => runtime.starts.includes("run"));
    runtime.release("run");
    await waitFor(() => hookStarted);

    let closed = false;
    const closing = coordinator.shutdown().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(closed).toBe(false);
    releaseHook();
    await closing;
    store.close();
  });

  it("runs durable subagents concurrently without using the occupied parent queue slot", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime, undefined, 256, 1, 1);
    const now = new Date(0).toISOString();
    const parentRequest: AgentRunRequest = { model: "default", messages: [{ role: "user", content: "parent" }] };
    store.createAgentRun({ id: "parent", routeId: "default", ownerUserId: "owner", ownerDeviceId: "device-1", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 }, parentRequest);

    const first = coordinator.runSubagent({
      parentRunId: "parent",
      role: store.getSubagentRole("researcher")!,
      ownerUserId: "owner",
      request: { model: "subagent", accessMode: "read-only", messages: [{ role: "user", content: "research-one" }] },
    });
    await waitFor(() => runtime.starts.includes("research-one"));
    const second = coordinator.runSubagent({
      parentRunId: "parent",
      role: store.getSubagentRole("implementer")!,
      ownerUserId: "owner",
      request: { model: "subagent", accessMode: "full", messages: [{ role: "user", content: "worker-two" }] },
    });
    await waitFor(() => runtime.starts.includes("worker-two"));
    expect(runtime.starts).toEqual(["research-one", "worker-two"]);

    runtime.release("research-one");
    runtime.release("worker-two");
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.run.status).toBe("completed");
    expect(firstResult.run.ownerDeviceId).toBe("device-1");
    expect(firstResult.text).toBe("done:research-one");
    expect(secondResult.run.routeId).toBe("subagent");
    expect(store.getAgentRunRequest(firstResult.run.id)?.delegation).toEqual({ role: roleSnapshot(store, "researcher"), parentRunId: "parent" });
    store.close();
  });

  it("returns a durable worker handle immediately while the child keeps running", async () => {
    const store = SqliteStore.memory();
    const runtime = new ControlledRuntime();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const now = new Date(0).toISOString();
    store.createAgentRun(
      { id: "parent", routeId: "default", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 },
      { model: "default", messages: [{ role: "user", content: "parent" }] },
    );

    const launch = coordinator.launchSubagent({
      parentRunId: "parent",
      planItemId: "research",
      role: store.getSubagentRole("researcher")!,
      request: { model: "default", messages: [{ role: "user", content: "background" }] },
    });

    expect(launch.run.status).toBe("running");
    await waitFor(() => runtime.starts.includes("background"));
    expect(store.getAgentRun(launch.run.id)?.status).toBe("running");
    expect(store.getAgentRunRequest(launch.run.id)?.delegation?.planItemId).toBe("research");
    runtime.release("background");
    await expect(launch.result).resolves.toEqual(expect.objectContaining({ run: expect.objectContaining({ status: "completed" }), text: "done:background" }));
    store.close();
  });

  it("forbids nested subagent delegation", async () => {
    const store = SqliteStore.memory();
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, new ControlledRuntime());
    const now = new Date(0).toISOString();
    store.createAgentRun(
      { id: "child-parent", routeId: "default", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 },
      { model: "default", delegation: { role: roleSnapshot(store, "reviewer"), parentRunId: "root-parent" }, messages: [{ role: "user", content: "review" }] },
    );

    await expect(coordinator.runSubagent({
      parentRunId: "child-parent",
      role: store.getSubagentRole("researcher")!,
      request: { model: "default", messages: [{ role: "user", content: "nested" }] },
    })).rejects.toThrow("cannot delegate");
    store.close();
  });

  it("persists exactly one final answer after plan readiness with no answer-shaped commentary", async () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createSession({ id: "session-final", title: "Final", status: "active", createdAt: now, updatedAt: now });
    const runtime: AgentRuntime = {
      id: "single-final",
      run: (_request, _signal, options) => ({
        cancel: () => undefined,
        async *[Symbol.asyncIterator]() {
          store.saveAgentRunPlan({
            runId: options!.runId!, revision: 1, status: "ready_for_answer", createdAt: now, updatedAt: now,
            items: [{ id: "inspect", task: "Inspect implementation", dependencies: [], owner: "main", workerEligible: false, required: true, status: "completed", attempts: 0, result: "done" }],
          });
          yield { type: "tool.started" as const, toolCallId: "ready", toolName: "agent_plan", input: { action: "ready" } };
          yield { type: "tool.completed" as const, toolCallId: "ready", toolName: "agent_plan", result: { details: { plan: { status: "ready_for_answer" } } } };
          yield { type: "assistant.delta" as const, text: "One standalone final answer." };
        },
      }),
    };
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const run = coordinator.start({ model: "default", sessionId: "session-final", messages: [{ role: "user", content: "work" }] });
    await waitFor(() => coordinator.get(run.id)?.status === "completed");

    const assistant = store.transcriptAfter("session-final", 0, 100).filter((entry) => entry.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toEqual(expect.objectContaining({ phase: "final", text: "One standalone final answer." }));
    expect(store.getAgentRunPlan(run.id)?.status).toBe("completed");
    store.close();
  });

  it("persists prompt provenance as run evidence without adding transcript text", async () => {
    const store = SqliteStore.memory();
    const runtime: AgentRuntime = {
      id: "provenance",
      run: () => ({
        cancel: () => undefined,
        async *[Symbol.asyncIterator]() {
          yield { type: "prompt.provenance" as const, id: "fitz.root", version: 1, sha256: "b".repeat(64), sections: ["core", "tools"] };
          yield { type: "assistant.delta" as const, text: "done" };
        },
      }),
    };
    const coordinator = new AgentRunCoordinator(store, {} as InferenceScheduler, runtime);
    const run = coordinator.start({ model: "default", messages: [{ role: "user", content: "work" }] });
    await waitFor(() => coordinator.get(run.id)?.status === "completed");
    expect(store.agentEventsAfter(run.id, 0)).toContainEqual(expect.objectContaining({
      type: "prompt.provenance",
      data: { promptId: "fitz.root", promptVersion: 1, sha256: "b".repeat(64), sections: ["core", "tools"] },
    }));
    store.close();
  });
});

function roleSnapshot(store: SqliteStore, id: string) {
  const { enabled: _enabled, ...snapshot } = store.getSubagentRole(id)!;
  return snapshot;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for test condition");
}
