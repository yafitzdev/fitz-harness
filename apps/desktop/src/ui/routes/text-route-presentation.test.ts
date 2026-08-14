import { describe, expect, it } from "vitest";
import { CLOUD_TEXT_ROUTE_DEFINITIONS, TEXT_ROUTE_DEFINITIONS, textRouteOptions, textRouteRecipeId } from "./text-route-presentation.js";

describe("text route presentation", () => {
  const configuration = {
    routes: [{ id: "default", recipeId: "local", enabled: true }],
    cloudRoutes: { fast: "worker", smart: "planner" },
    recipes: [
      { id: "local", displayName: "Muse Glimmer Q5" },
      { id: "worker", modelId: "deepseek-chat" },
      { id: "planner", displayName: "Command A" },
    ],
  };

  it("owns the canonical Local, Fast, Smart order", () => {
    expect(TEXT_ROUTE_DEFINITIONS.map((route) => route.id)).toEqual(["default", "fast", "smart"]);
    expect(CLOUD_TEXT_ROUTE_DEFINITIONS.map((route) => route.id)).toEqual(["fast", "smart"]);
  });

  it("resolves cloud roles from cloudRoutes and labels every role identically", () => {
    expect(textRouteRecipeId(configuration, "smart")).toBe("planner");
    expect(textRouteOptions(configuration)).toEqual([
      { id: "default", label: "Local · Muse Glimmer Q5", displayName: "Local", group: "Routes" },
      { id: "fast", label: "Fast · deepseek-chat", displayName: "Fast", group: "Routes" },
      { id: "smart", label: "Smart · Command A", displayName: "Smart", group: "Routes" },
    ]);
  });

  it("omits unconfigured cloud roles", () => {
    expect(textRouteOptions({ routes: configuration.routes, recipes: configuration.recipes })).toEqual([
      { id: "default", label: "Local · Muse Glimmer Q5", displayName: "Local", group: "Routes" },
    ]);
  });
});
