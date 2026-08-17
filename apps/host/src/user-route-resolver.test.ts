import { describe, expect, it } from "vitest";
import type { Recipe, Route } from "@fitz/protocol";
import { RecipeNotFoundError, RouteNotFoundError, RouteResolver } from "@fitz/inference-core";
import { SqliteStore } from "@fitz/storage";
import { UserRouteResolver, type ConsumerConnectionRegistration } from "./user-route-resolver.js";

const defaultRecipe = recipe("local-default", "fake", "local-model");
const defaultRoute: Route = {
  id: "default",
  displayName: "Default",
  recipeId: defaultRecipe.id,
  enabled: true,
  isDefault: true,
};

describe("UserRouteResolver", () => {
  it("publishes enabled generation routes for OpenAI-compatible discovery", () => {
    const store = SqliteStore.memory();
    const mediaRoutes: Route[] = [
      { id: "image", displayName: "Image", recipeId: "image-recipe", kind: "image", enabled: true },
      { id: "video", displayName: "Video", recipeId: "video-recipe", kind: "video", enabled: false },
      { id: "audio", displayName: "Audio", recipeId: "audio-recipe", kind: "audio", enabled: true },
    ];
    const resolver = new UserRouteResolver(store, new RouteResolver([defaultRoute, ...mediaRoutes], [defaultRecipe]));

    expect(resolver.publicMediaRoutes().map((route) => route.id)).toEqual(["image", "audio"]);
    store.close();
  });

  it("projects chat routes to model IDs while retaining legacy route aliases", () => {
    const store = SqliteStore.memory();
    const resolver = new UserRouteResolver(store, new RouteResolver([defaultRoute], [defaultRecipe]));

    expect(resolver.publicChatModels().map((entry) => entry.modelId)).toEqual(["local-model"]);
    expect(resolver.resolvePublicModel("local-model").route.id).toBe("default");
    expect(resolver.resolvePublicModel("default").recipe.modelId).toBe("local-model");
    store.close();
  });

  it("isolates Smart and Fast bindings by connection owner", () => {
    const store = SqliteStore.memory();
    const aliceRecipe = recipe("alice-cloud", "openai-compatible", "alice-model");
    const bobRecipe = recipe("bob-cloud", "openai-compatible", "bob-model");
    const routes = new RouteResolver([defaultRoute], [defaultRecipe, aliceRecipe, bobRecipe]);
    const resolver = new UserRouteResolver(store, routes);
    resolver.replaceConnection("alice", connection("alice", "cloud", aliceRecipe.id));
    resolver.replaceConnection("bob", connection("bob", "cloud", bobRecipe.id));

    resolver.assign("alice", "smart", aliceRecipe.id);
    resolver.assign("alice", "fast", aliceRecipe.id);

    expect(resolver.publicRoutes("alice").map((route) => route.id)).toEqual(["default", "fast", "smart"]);
    expect(resolver.resolve("smart", "alice").recipe.id).toBe(aliceRecipe.id);
    expect(resolver.resolve("fast", "alice", true).recipe.id).toBe(aliceRecipe.id);
    expect(resolver.publicRoutes("bob").map((route) => route.id)).toEqual(["default"]);
    expect(() => resolver.resolve("smart", "bob")).toThrow(RouteNotFoundError);
    expect(() => resolver.assign("bob", "smart", aliceRecipe.id)).toThrow(RecipeNotFoundError);

    resolver.assign("bob", "smart", bobRecipe.id);
    expect(resolver.resolve("smart", "bob").recipe.id).toBe(bobRecipe.id);
    expect(resolver.resolve("smart", "alice").recipe.id).toBe(aliceRecipe.id);
    store.close();
  });

  it("does not expose workers until that owner configures Fast", () => {
    const store = SqliteStore.memory();
    const workerRecipe = recipe("cloud-worker", "openai-compatible", "worker-model");
    const resolver = new UserRouteResolver(store, new RouteResolver([defaultRoute], [defaultRecipe, workerRecipe]));
    resolver.replaceConnection("user", connection("user", "workers", workerRecipe.id));

    expect(() => resolver.resolve("fast", "user", true)).toThrow(RouteNotFoundError);
    expect(() => resolver.resolve("fast", "user", false)).toThrow(RouteNotFoundError);

    resolver.assign("user", "fast", workerRecipe.id);
    expect(resolver.resolve("fast", "user", true).recipe.id).toBe(workerRecipe.id);
    expect(resolver.resolve("fast", "user").recipe.id).toBe(workerRecipe.id);
    expect(resolver.publicRoutes("user").map((route) => route.id)).toEqual(["default", "fast"]);
    store.close();
  });

  it("clears only bindings backed by a replaced or removed owned connection", () => {
    const store = SqliteStore.memory();
    const first = recipe("first-cloud", "openai-compatible", "first-model");
    const second = recipe("second-cloud", "openai-compatible", "second-model");
    const resolver = new UserRouteResolver(store, new RouteResolver([defaultRoute], [defaultRecipe, first, second]));
    resolver.replaceConnection("user", connection("user", "first", first.id));
    resolver.replaceConnection("user", connection("user", "second", second.id));
    resolver.assign("user", "smart", first.id);
    resolver.assign("user", "fast", second.id);

    resolver.removeConnection("user", "first");
    expect(resolver.binding("user", "smart")).toBeUndefined();
    expect(resolver.binding("user", "fast")?.recipeId).toBe(second.id);

    resolver.replaceConnection("user", connection("user", "second", first.id));
    expect(resolver.binding("user", "fast")).toBeUndefined();
    store.close();
  });
});

function recipe(id: string, adapter: string, modelId: string): Recipe {
  return {
    id,
    playbookId: `${id}-playbook`,
    displayName: id,
    adapter,
    modelId,
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      toolCalls: true,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "never",
      idleTtlSeconds: 0,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}

function connection(ownerUserId: string, id: string, recipeId: string): ConsumerConnectionRegistration {
  return {
    ownerUserId,
    id,
    displayName: id,
    baseUrl: "https://example.test/v1",
    authType: "none",
    credentialEnv: "FITZ_TEST_KEY",
    template: "openai-compatible",
    models: [{ modelId: `${id}-model`, recipeId }],
    mediaModels: [],
    updatedAt: new Date(0).toISOString(),
  };
}
