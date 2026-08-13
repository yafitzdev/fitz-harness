import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RouteResolver } from "@fitz/inference-core";
import type { EngineRegistration } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import {
  ensureMediaRoutes,
  scanEngineFolders,
} from "./model-management-routes.js";

describe("model management routes", () => {
  it("creates missing media slots without resetting an existing assignment", () => {
    const store = SqliteStore.memory();
    const routes = new RouteResolver([], []);

    try {
      ensureMediaRoutes(store, routes);
      expect(routes.listRoutes(true)).toEqual([
        expect.objectContaining({ id: "image", recipeId: "", enabled: false, kind: "image" }),
        expect.objectContaining({ id: "video", recipeId: "", enabled: false, kind: "video" }),
        expect.objectContaining({ id: "audio", recipeId: "", enabled: false, kind: "audio" }),
      ]);

      const assigned = { ...routes.listRoutes(true).find((route) => route.id === "image")!, recipeId: "image-recipe", enabled: true };
      store.upsertRoute(assigned);
      routes.upsertRoute(assigned);
      ensureMediaRoutes(store, routes);

      expect(routes.listRoutes(true).find((route) => route.id === "image")).toEqual(assigned);
    } finally {
      store.close();
    }
  });

  it("reports only visible engine directories and attaches registrations", () => {
    const engineRoot = mkdtempSync(join(tmpdir(), "fitz-model-management-"));
    mkdirSync(join(engineRoot, "alpha"));
    mkdirSync(join(engineRoot, "zeta"));
    mkdirSync(join(engineRoot, ".internal"));
    const now = new Date().toISOString();
    const engine: EngineRegistration = {
      id: "zeta",
      folderName: "zeta",
      displayName: "Zeta",
      connectionMode: "external",
      runtime: "linux-managed",
      baseUrl: "http://127.0.0.1:8000",
      healthPath: "/health",
      launchArguments: [],
      createdAt: now,
      updatedAt: now,
    };

    try {
      expect(scanEngineFolders(engineRoot, [engine])).toEqual([
        expect.objectContaining({ folderName: "alpha", registered: false, rootPath: join(engineRoot, "alpha") }),
        expect.objectContaining({ folderName: "zeta", registered: true, rootPath: join(engineRoot, "zeta"), engine }),
      ]);
    } finally {
      rmSync(engineRoot, { recursive: true, force: true });
    }
  });
});
