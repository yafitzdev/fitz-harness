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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for test condition");
}
