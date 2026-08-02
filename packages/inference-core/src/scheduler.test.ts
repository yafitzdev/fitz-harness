import { FakeEngineAdapter } from "@fitz/engine-fake";
import type { InferenceDelta, Recipe, Route } from "@fitz/protocol";
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

  it("shares a speculative warm-up load with the first generation", async () => {
    const adapter = new FakeEngineAdapter({ loadDelayMs: 10 });
    const lifecycle = new LifecycleManager({ adapters: new EngineAdapterRegistry([adapter]) });
    const selectedRecipe = recipe("best", 600);
    const scheduler = new InferenceScheduler(new RouteResolver([route("default", "best")], [selectedRecipe]), lifecycle);

    const warmup = lifecycle.warm(selectedRecipe);
    const output = collect(scheduler.enqueue("default", { messages: [{ role: "user", content: "hello" }] }));
    await Promise.all([warmup, output]);

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
