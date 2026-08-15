import { createServer } from "node:http";
import { once } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { RouteResolver } from "@fitz/inference-core";
import {
  FalProvider,
  MediaProviderRegistry,
  OpenAICompatibleMediaProvider,
  ReplicateProvider,
} from "@fitz/media-providers";
import { SqliteStore } from "@fitz/storage";
import { DEFAULT_RECIPES, DEFAULT_ROUTES } from "./defaults.js";
import {
  discardLegacyConsumerConnections,
  registerConsumerConnectionRoutes,
} from "./consumer-connection-routes.js";
import { UserRouteResolver } from "./user-route-resolver.js";

function connectionRouteFixture() {
  const app = Fastify({ logger: false });
  const store = SqliteStore.memory();
  for (const recipe of DEFAULT_RECIPES) store.upsertRecipe(recipe);
  for (const route of DEFAULT_ROUTES) store.upsertRoute(route);
  const routes = new RouteResolver(store.listRoutes(), store.listRecipes());
  const userRoutes = new UserRouteResolver(store, routes);
  registerConsumerConnectionRoutes({
    app,
    store,
    routes,
    userRoutes,
    mediaProviders: new MediaProviderRegistry([
      new OpenAICompatibleMediaProvider(),
      new FalProvider(),
      new ReplicateProvider(),
    ]),
    principals: new WeakMap(),
    wellKnownMediaRouteIds: ["image", "video", "audio"],
  });
  return { app, store, routes, userRoutes };
}

describe("consumer connection routes", () => {
  it("owns connection discovery, cloud assignment, and cleanup as one route family", async () => {
    const upstream = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[{"id":"chat-model"},{"id":"embed-model","endpoints":["embed"]}]}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const fixture = connectionRouteFixture();

    try {
      const saved = await fixture.app.inject({
        method: "PUT",
        url: "/api/v1/connections/cloud",
        payload: { displayName: "Cloud", baseUrl: `http://127.0.0.1:${address.port}/v1`, authType: "none" },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().data).toMatchObject({ executionClass: "metered_cloud", accessClass: "same_device" });
      expect(saved.json().data.models).toEqual([{ id: "chat-model", recipeId: expect.any(String) }]);
      const recipeId = saved.json().data.models[0].recipeId as string;
      expect(fixture.routes.resolveRecipe(recipeId)).toMatchObject({ modelId: "chat-model", executionClass: "metered_cloud" });

      const assigned = await fixture.app.inject({
        method: "PUT",
        url: "/api/v1/cloud-routes/smart",
        payload: { recipeId },
      });
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect((await fixture.app.inject({ method: "GET", url: "/api/v1/cloud-routes" })).json().data.smart).toBe(recipeId);

      expect((await fixture.app.inject({ method: "DELETE", url: "/api/v1/connections/cloud" })).statusCode).toBe(204);
      expect(fixture.store.listRecipes().some((recipe) => recipe.id === recipeId)).toBe(false);
      expect((await fixture.app.inject({ method: "GET", url: "/api/v1/cloud-routes" })).json().data.smart).toBeUndefined();
    } finally {
      await fixture.app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("removes ownerless legacy recipes and routes without touching owned registrations", () => {
    const store = SqliteStore.memory();
    store.upsertRecipe(DEFAULT_RECIPES[0]!);
    store.upsertRoute(DEFAULT_ROUTES[0]!);
    store.setSetting("consumerConnections", [
      {
        id: "legacy",
        models: [{ recipeId: DEFAULT_RECIPES[0]!.id }],
        mediaModels: [{ recipeId: "legacy-media", routeId: DEFAULT_ROUTES[0]!.id }],
      },
      {
        ownerUserId: "user-1",
        id: "owned",
        models: [],
        mediaModels: [],
      },
    ]);

    discardLegacyConsumerConnections(store);

    expect(store.listRecipes()).toEqual([]);
    expect(store.listRoutes()).toEqual([]);
    expect(store.getSetting<unknown[]>("consumerConnections")).toEqual([
      expect.objectContaining({ ownerUserId: "user-1", id: "owned" }),
    ]);
  });

  it("removes retired cloud worker topology from persisted connection recipes", () => {
    const store = SqliteStore.memory();
    const recipe = {
      ...DEFAULT_RECIPES[0]!,
      id: "consumer-recipe--owned--cloud",
      playbookId: "consumer-owned",
      adapter: "openai-compatible",
      agentTopology: { sharedContextTokens: 131_072, workers: { count: 2, contextTokens: 32_000 } },
    };
    store.upsertRecipe(recipe);
    store.setSetting("consumerConnections", [{
      ownerUserId: "user-1",
      id: "cloud",
      models: [{ modelId: "cloud-model", recipeId: recipe.id }],
      mediaModels: [],
    }]);

    discardLegacyConsumerConnections(store);

    expect(store.listRecipes().find((candidate) => candidate.id === recipe.id)?.agentTopology).toBeUndefined();
    expect(store.listRecipes().find((candidate) => candidate.id === recipe.id)?.executionClass).toBe("metered_cloud");
    store.close();
  });
});
