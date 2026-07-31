import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NInferEngineAdapter, buildCurrentNInferRecipe } from "@fitz/engine-ninfer";
import type { Route } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { createHost } from "./create-app.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDataPath = resolve(moduleDirectory, "../../../data/fitz.db");
const databasePath = process.env.FITZ_DATABASE_PATH ?? defaultDataPath;
const host = process.env.FITZ_HOST ?? "127.0.0.1";
const port = parsePort(process.env.FITZ_PORT ?? "8787");
const engineMode = process.env.FITZ_ENGINE_MODE ?? "fake";
const reserveVramMiB = parseNonNegativeInteger(
  process.env.FITZ_RESERVE_VRAM_MIB ?? "2048",
  "FITZ_RESERVE_VRAM_MIB",
);
const authMode = process.env.FITZ_AUTH_MODE === "required" ? "required" : "disabled";

mkdirSync(dirname(databasePath), { recursive: true });
const engineOptions = engineMode === "ninfer" ? ninferOptions() : {};
const runtime = createHost({
  store: new SqliteStore(databasePath),
  logger: true,
  resourcePolicy: { reserveVramMiB },
  authMode,
  ...(authMode === "required" ? { authPepper: requiredEnvironment("FITZ_AUTH_PEPPER") } : {}),
  ...engineOptions,
  ...(process.env.FITZ_ADMIN_TOKEN ? { adminToken: process.env.FITZ_ADMIN_TOKEN } : {}),
});

if (authMode === "required" && runtime.store.listUsers().length === 0) {
  const bootstrapToken = requiredEnvironment("FITZ_BOOTSTRAP_ADMIN_TOKEN");
  const administrator = runtime.security!.createUser("Bootstrap Administrator", "administrator");
  runtime.security!.issueDevice(administrator.id, "Bootstrap Device", bootstrapToken);
  runtime.security!.audit("security.bootstrapped", administrator.id, "user", administrator.id);
}

await runtime.app.listen({ host, port });

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid FITZ_PORT: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function requiredEnvironment(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }

function ninferOptions() {
  const recipes = [
    buildCurrentNInferRecipe(
      "qwen36-35b-a3b-mtp4-100k",
      "qwen3.6-35b-a3b",
      "/opt/ninfer/models/qwen3_6_35b_a3b.ninfer",
      4,
    ),
    buildCurrentNInferRecipe(
      "qwen36-27b-mtp3-100k",
      "qwen3.6-27b",
      "/opt/ninfer/models/qwen3_6_27b_nvfp4.ninfer",
      3,
    ),
  ];
  const routes: Route[] = [
    {
      id: "default-agent",
      displayName: "Qwen 3.6 35B A3B",
      description: "Best local agent route",
      recipeId: recipes[0]!.id,
      enabled: true,
      isDefault: true,
    },
    {
      id: "fast",
      displayName: "Qwen 3.6 27B",
      description: "Fast local route",
      recipeId: recipes[1]!.id,
      enabled: true,
    },
  ];
  return { adapters: [new NInferEngineAdapter()], initialRecipes: recipes, initialRoutes: routes };
}
