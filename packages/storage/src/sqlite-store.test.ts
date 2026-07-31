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
});
