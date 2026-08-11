import { FakeEngineAdapter, type FakeInstanceHandle } from "@fitz/engine-fake";
import type { InferenceDelta, InferenceRequest, Recipe, Route } from "@fitz/protocol";
import { describe, expect, it } from "vitest";
import { EngineAdapterRegistry } from "./adapter.js";
import { ManualClock } from "./clock.js";
import { LifecycleEventBus } from "./event-bus.js";
import { LifecycleManager } from "./lifecycle-manager.js";
import { RouteResolver } from "./route-resolver.js";
import { InferenceScheduler } from "./scheduler.js";

describe("InferenceScheduler", () => {
  it("loads once, reuses the instance, and evicts after TTL", async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 31));
    const adapter = new FakeEngineAdapter();
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([adapter]),
      events,
      clock,
    });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default-agent", "best")], [recipe("best", 5)]),
      lifecycle,
      events,
    );

    const first = await collect(
      scheduler.enqueue("default-agent", { messages: [{ role: "user", content: "one" }] }),
    );
    const second = await collect(
      scheduler.enqueue("default-agent", { messages: [{ role: "user", content: "two" }] }),
    );

    expect(first).toContain("one");
    expect(second).toContain("two");
    expect(adapter.starts).toHaveLength(1);
    expect(lifecycle.snapshot().state).toBe("READY");

    await clock.advanceBy(4_999);
    expect(lifecycle.snapshot().state).toBe("READY");
    await clock.advanceBy(1);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
    expect(adapter.stops).toHaveLength(1);
  });

  it("restarts a loaded recipe when its runtime configuration changes", async () => {
    const adapter = new FakeEngineAdapter();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const initialRecipe = recipe("best", 600);
    const routes = new RouteResolver([route("default", "best")], [initialRecipe]);
    const scheduler = new InferenceScheduler(routes, lifecycle);

    await collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "before" }] }));
    routes.upsertRecipe({
      ...initialRecipe,
      contextTokens: 200_000,
      configuration: { args: ["--ctx-size", "{context}"] },
    });
    await collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "after" }] }));

    expect(adapter.starts).toHaveLength(2);
    expect(adapter.stops).toEqual([expect.objectContaining({ mode: "graceful" })]);
    expect(lifecycle.snapshot().state).toBe("READY");
  });

  it("caps text model residency at ten idle minutes", async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 31));
    const adapter = new FakeEngineAdapter();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), clock });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "best")], [recipe("best", 3_600)]),
      lifecycle,
    );

    await collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "hello" }] }));
    await clock.advanceBy(599_999);
    expect(lifecycle.snapshot().state).toBe("READY");
    await clock.advanceBy(1);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
    expect(adapter.stops).toHaveLength(1);
  });

  it("shares a speculative warm-up load with the first generation", async () => {
    const adapter = new FakeEngineAdapter({ prepareDelayMs: 10, loadDelayMs: 10 });
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const selectedRecipe = recipe("best", 600);
    const scheduler = new InferenceScheduler(new RouteResolver([route("default", "best")], [selectedRecipe]), lifecycle);

    const warmup = lifecycle.warm(selectedRecipe);
    const output = collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "hello" }] }));
    await Promise.all([warmup, output]);

    expect(adapter.starts).toHaveLength(1);
    expect(adapter.preparations).toEqual(["best"]);
    expect(lifecycle.snapshot().state).toBe("READY");
  });

  it("prepares a recipe without starting its model and reuses that work on activation", async () => {
    const adapter = new FakeEngineAdapter();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const selectedRecipe = recipe("best", 600);

    await Promise.all([lifecycle.prepare(selectedRecipe), lifecycle.prepare(selectedRecipe)]);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
    expect(adapter.preparations).toEqual(["best"]);
    expect(adapter.starts).toHaveLength(0);

    await lifecycle.warm(selectedRecipe);
    expect(adapter.preparations).toEqual(["best"]);
    expect(adapter.starts).toHaveLength(1);
  });

  it("falls back to ordinary cold activation when optional preparation fails", async () => {
    const adapter = new FakeEngineAdapter({ failPrepare: true });
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const selectedRecipe = recipe("best", 600);

    await expect(lifecycle.prepare(selectedRecipe)).rejects.toThrow("preparation failure");
    await lifecycle.warm(selectedRecipe);

    expect(adapter.starts).toHaveLength(1);
    expect(lifecycle.snapshot().state).toBe("READY");
  });

  it("serializes requests and switches recipes safely", async () => {
    const adapter = new FakeEngineAdapter({ tokenDelayMs: 1 });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({
      adapters: new EngineAdapterRegistry([adapter]),
      events,
    });
    const routes = new RouteResolver(
      [route("best", "best"), route("fast", "fast")],
      [recipe("best", 60), recipe("fast", 60)],
    );
    const scheduler = new InferenceScheduler(routes, lifecycle, events);

    const best = scheduler.enqueue("best", { messages: [{ role: "user", content: "alpha" }] });
    const fast = scheduler.enqueue("fast", { messages: [{ role: "user", content: "beta" }] });
    const [bestText, fastText] = await Promise.all([collect(best), collect(fast)]);

    expect(bestText).toContain("alpha");
    expect(fastText).toContain("beta");
    expect(adapter.starts.map((instance) => instance.modelId)).toEqual(["best-model", "fast-model"]);
    expect(adapter.stops).toHaveLength(1);
    expect(events.after(0).some((event) => event.type === "queue.updated")).toBe(true);
  });

  it("round-robins queued GPU work across users without reordering either user", async () => {
    const adapter = new FakeEngineAdapter({ tokenDelayMs: 15 });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), events });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "default")], [recipe("default", 60)]),
      lifecycle,
      events,
    );
    const submit = (ownerUserId: string, content: string) => scheduler.enqueue(
      "default",
      { messages: [{ role: "user", content }] },
      undefined,
      { ownerUserId, label: content },
    );

    const a0 = submit("a", "a0");
    await waitFor(() => lifecycle.snapshot().state === "BUSY");
    const streams = [submit("a", "a1"), submit("a", "a2"), submit("b", "b1"), submit("b", "b2")];
    await Promise.all([collect(a0), ...streams.map(collect)]);

    const started = events.after(0)
      .filter((event) => event.type === "queue.updated" && event.data.status === "started")
      .map((event) => event.data.label);
    expect(started).toEqual(["a0", "b1", "a1", "b2", "a2"]);
  });

  it("queues model activation behind active generation instead of bypassing the GPU slot", async () => {
    const adapter = new FakeEngineAdapter({ tokenDelayMs: 10, loadDelayMs: 5 });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), events });
    const scheduler = new InferenceScheduler(
      new RouteResolver(
        [route("default", "default"), route("smart", "smart")],
        [recipe("default", 60), recipe("smart", 60)],
      ),
      lifecycle,
      events,
    );

    const chat = scheduler.enqueue("default", { messages: [{ role: "user", content: "first" }] });
    await waitFor(() => lifecycle.snapshot().state === "BUSY");
    const warm = scheduler.enqueueWarm("smart");
    const next = scheduler.enqueue("smart", { messages: [{ role: "user", content: "second" }] });
    const [, warmed, nextText] = await Promise.all([collect(chat), warm.result, collect(next)]);

    expect(warmed.recipeId).toBe("smart");
    expect(nextText).toContain("second");
    expect(events.after(0)
      .filter((event) => event.type === "queue.updated" && event.data.status === "started")
      .map((event) => event.data.kind)).toEqual(["chat", "warm", "chat"]);
  });

  it("tests an exact recipe without assigning it to a consumer route", async () => {
    const adapter = new FakeEngineAdapter();
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), events });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "routed")], [recipe("routed", 60), recipe("unassigned", 60)]),
      lifecycle,
      events,
    );

    const output = await collect(scheduler.enqueueRecipe(
      "unassigned",
      { messages: [{ role: "user", content: "Say hi." }], maxTokens: 16 },
      undefined,
      { unloadAfterCompletion: true },
    ));

    expect(output).toContain("Say hi.");
    expect(adapter.starts.at(-1)?.modelId).toBe("unassigned-model");
    expect(adapter.stops).toEqual([expect.objectContaining({ mode: "graceful" })]);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
    expect(scheduler.routes.resolve("default").recipe.id).toBe("routed");
  });

  it("cancels active and queued work without wedging the scheduler", async () => {
    const adapter = new FakeEngineAdapter({ tokenDelayMs: 30 });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), events });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "default")], [recipe("default", 60)]),
      lifecycle,
      events,
    );

    const active = scheduler.enqueue("default", { messages: [{ role: "user", content: "active" }] });
    const queued = scheduler.enqueue("default", { messages: [{ role: "user", content: "queued" }] });
    queued.cancel();
    await expect(collect(queued)).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => lifecycle.snapshot().state === "BUSY");
    active.cancel();
    await expect(collect(active)).rejects.toMatchObject({ name: "AbortError" });

    expect(events.after(0).filter((event) => event.type === "queue.updated" && event.data.status === "cancelled")).toHaveLength(2);
    expect(scheduler.queueDepth).toBe(0);
    expect(lifecycle.snapshot()).toMatchObject({ state: "READY", activeLeases: 0 });
  });

  it("applies finite backpressure and settles already-aborted submissions", async () => {
    const adapter = new FakeEngineAdapter({ tokenDelayMs: 30 });
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "default")], [recipe("default", 60)]),
      lifecycle,
      undefined,
      { gpuQueueCapacity: 1 },
    );
    const active = scheduler.enqueue("default", { messages: [{ role: "user", content: "active" }] });
    const queued = scheduler.enqueue("default", { messages: [{ role: "user", content: "queued" }] });
    expect(() => scheduler.enqueue("default", { messages: [{ role: "user", content: "overflow" }] })).toThrowError(
      expect.objectContaining({ name: "InferenceAdmissionError", lane: "gpu", reason: "queue_capacity", retryable: true }),
    );
    const controller = new AbortController(); controller.abort();
    await expect(collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "aborted" }] }, controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    active.cancel(); queued.cancel();
    await expect(collect(active)).rejects.toMatchObject({ name: "AbortError" });
    await expect(collect(queued)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("recovers from a generation failure by replacing the failed instance", async () => {
    const adapter = new FakeEngineAdapter({ failWhenPromptIncludes: "explode" });
    const events = new LifecycleEventBus();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), events });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "default")], [recipe("default", 60)]),
      lifecycle,
      events,
    );

    await expect(collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "explode" }] }))).rejects.toThrow("request failure");
    expect(lifecycle.snapshot().state).toBe("FAILED");
    await expect(collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "recover" }] }))).resolves.toContain("recover");
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.stops).toEqual([expect.objectContaining({ mode: "force" })]);
    expect(lifecycle.snapshot().state).toBe("READY");
  });

  it("keeps a healthy instance resident after a rejected request", async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 31));
    const adapter = new FakeEngineAdapter({ rejectWhenPromptIncludes: "too large" });
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]), clock });
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("default", "best")], [recipe("best", 600)]),
      lifecycle,
    );

    await expect(collect(scheduler.enqueue("default", {
      messages: [{ role: "user", content: "too large" }],
    }))).rejects.toMatchObject({ name: "InferenceRequestRejectedError", statusCode: 400 });
    expect(lifecycle.snapshot()).toMatchObject({ state: "READY", activeLeases: 0 });

    await expect(collect(scheduler.enqueue("default", {
      messages: [{ role: "user", content: "recover without reload" }],
    }))).resolves.toContain("recover without reload");
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.stops).toHaveLength(0);

    await clock.advanceBy(600_000);
    expect(lifecycle.snapshot().state).toBe("UNLOADED");
    expect(adapter.stops).toHaveLength(1);
  });

  it("records one terminal usage fact with provider token telemetry", async () => {
    const adapter = new FakeEngineAdapter();
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const records: import("@fitz/protocol").RequestUsageRecord[] = [];
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("smart", "reasoner")], [recipe("reasoner", 60)]),
      lifecycle,
      undefined,
      { recordUsage: (record) => { records.push(record); } },
    );

    await collect(scheduler.enqueue("smart", { messages: [{ role: "user", content: "count these tokens" }] }, undefined, { ownerUserId: "user-1", sessionId: "session-1" }));
    await waitFor(() => records.length === 1);

    expect(records).toEqual([expect.objectContaining({
      kind: "chat", status: "completed", routeId: "smart", recipeId: "reasoner", modelId: "reasoner-model",
      ownerUserId: "user-1", sessionId: "session-1", executionLane: "gpu", promptTokens: expect.any(Number), completionTokens: expect.any(Number),
      metadata: expect.objectContaining({ responseDurationMs: expect.any(Number), outputDelivery: "streamed", observedOutputChunks: expect.any(Number) }),
    })]);
  });

  it("persists a local token estimate and model-ready timing when usage is absent", async () => {
    class AtomicNoUsageAdapter extends FakeEngineAdapter {
      override async *streamChat(instance: FakeInstanceHandle, request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceDelta> {
        let text = "";
        for await (const delta of super.streamChat(instance, request, signal)) text += delta.text;
        yield { text, finishReason: "stop" };
      }
    }
    const adapter = new AtomicNoUsageAdapter({ loadDelayMs: 5, responseFactory: () => "a".repeat(400) });
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const records: import("@fitz/protocol").RequestUsageRecord[] = [];
    const scheduler = new InferenceScheduler(
      new RouteResolver([route("fast", "atomic")], [recipe("atomic", 60)]),
      lifecycle,
      undefined,
      { recordUsage: (record) => { records.push(record); } },
    );

    await collect(scheduler.enqueue("fast", { messages: [{ role: "user", content: "answer atomically" }] }));
    await waitFor(() => records.length === 1);

    expect(records[0]?.completionTokens).toBeUndefined();
    expect(records[0]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        outputDelivery: "atomic",
        observedOutputChunks: 1,
        estimatedCompletionTokens: 100,
        responseDurationMs: expect.any(Number),
        modelLoadMs: expect.any(Number),
      }),
    }));
  });
});

async function collect(stream: AsyncIterable<InferenceDelta>): Promise<string> {
  let text = "";
  for await (const delta of stream) text += delta.text;
  return text;
}

function route(id: string, recipeId: string): Route {
  return { id, displayName: id, recipeId, enabled: true };
}

function recipe(id: string, ttlSeconds: number): Recipe {
  return {
    id,
    playbookId: "fake",
    displayName: id,
    adapter: "fake",
    modelId: `${id}-model`,
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
      idleTtlSeconds: ttlSeconds,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for test condition");
}
