import { describe, expect, it } from "vitest";
import { parseManagementConfiguration, parseManagementRoute } from "./management-configuration.js";

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: { state: "READY", activeLeases: 0 },
    residency: {},
    queueDepth: 0,
    resources: {},
    routes: [],
    recipes: [],
    engines: [],
    cloudRoutes: { smart: "planner", fast: undefined },
    chatDefaults: { route: "default", effort: "normal" },
    agentTopologies: {},
    isAdministrator: true,
    hostName: "YanPC",
    engineRoot: "C:\\Fitz\\engines",
    engineFolders: [{ folderName: "ninfer", rootPath: "C:\\Fitz\\engines\\ninfer", registered: false }],
    ...overrides,
  };
}

describe("parseManagementConfiguration", () => {
  it("accepts the management snapshot and preserves typed route bindings", () => {
    const configuration = parseManagementConfiguration(snapshot({ recoveredAgentRuns: [{ id: "run-1" }] }));

    expect(configuration.hostName).toBe("YanPC");
    expect(configuration.cloudRoutes).toEqual({ smart: "planner" });
    expect(configuration.engineFolders[0]?.folderName).toBe("ninfer");
  });

  it("rejects malformed runtime and route state before it reaches UI controllers", () => {
    expect(() => parseManagementConfiguration(snapshot({ routes: "not-an-array" }))).toThrow("routes, recipes, engines, or engine folders are invalid");
    expect(() => parseManagementConfiguration(snapshot({ routes: [{ id: "default", displayName: "Local", recipeId: "local-model", enabled: "yes" }] }))).toThrow("route is invalid");
    expect(() => parseManagementConfiguration(snapshot({ chatDefaults: { route: "default", effort: "maximum" } }))).toThrow("chat defaults are invalid");
    expect(() => parseManagementConfiguration(snapshot({ cloudRoutes: { smart: 42 } }))).toThrow("smart route binding is invalid");
  });

  it("rejects malformed engine folder entries", () => {
    expect(() => parseManagementConfiguration(snapshot({ engineFolders: [{ folderName: "ninfer" }] }))).toThrow("engine folder is invalid");
    expect(() => parseManagementConfiguration(snapshot({ engineFolders: [{ folderName: "ninfer", rootPath: "x", registered: true, engine: "bad" }] }))).toThrow("engine registration is invalid");
  });

  it("validates route snapshots used by optimistic route updates", () => {
    expect(parseManagementRoute({ id: "default", displayName: "Local", recipeId: "local-model", enabled: true })).toMatchObject({ id: "default" });
    expect(() => parseManagementRoute({ id: "default", displayName: "Local", recipeId: "local-model", enabled: "yes" })).toThrow("route is invalid");
    expect(() => parseManagementRoute({ id: "default", displayName: "Local", recipeId: "local-model", enabled: true, kind: "unknown" })).toThrow("route kind is invalid");
  });
});
