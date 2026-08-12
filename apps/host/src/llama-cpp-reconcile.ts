import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { Recipe } from "@fitz/protocol";
import type { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { managedLinuxRuntimeLayout, type ManagedLinuxRuntimeLayout } from "./managed-linux-runtime.js";

const LLAMA_CPP_PLAYBOOK_ID = "llama.cpp";
const REGISTRATION_DIRECTORY = ".fitz";

interface GgufRegistration {
  schemaVersion: 1;
  id: string;
  engine: "llama.cpp";
  format: "gguf";
  payload: { backend: "runtime-filesystem"; runtimeId: "inference-linux"; path: string };
  recipe: Recipe;
}

export interface LlamaCppReconcileResult {
  registered: string[];
  unregistered: string[];
}

/** Materializes llama.cpp recipes from canonical GGUF payloads and persistent
 * registration JSON. The filesystem registry is authoritative for presence;
 * SQLite is the live index used by the scheduler and UI. */
export class LlamaCppModelReconciler {
  readonly #store: SqliteStore;
  readonly #paths: FitzRuntimePaths;
  readonly #runtime: ManagedLinuxRuntimeLayout;
  readonly #registrationRoot: string;

  constructor(store: SqliteStore, paths: FitzRuntimePaths) {
    this.#store = store;
    this.#paths = paths;
    this.#runtime = managedLinuxRuntimeLayout(paths);
    this.#registrationRoot = resolve(join(paths.ggufModelRoot, REGISTRATION_DIRECTORY));
  }

  reconcile(routes?: RouteResolver): LlamaCppReconcileResult {
    mkdirSync(this.#registrationRoot, { recursive: true });
    const registrations = this.#readRegistrations();
    const recipes = new Map(this.#store.listRecipes().map((recipe) => [recipe.id, recipe]));
    const representedPayloads = new Set<string>();
    const activeRecipeIds = new Set<string>();
    const registered: string[] = [];
    const unregistered: string[] = [];

    for (const registration of registrations.values()) {
      const modelPath = this.#payloadHostPath(registration.payload.path);
      representedPayloads.add(registration.payload.path.toLowerCase());
      if (!existsSync(modelPath)) continue;
      const existed = recipes.has(registration.id);
      const recipe = this.#canonicalRecipe(registration.recipe);
      this.#store.upsertRecipe(recipe);
      routes?.upsertRecipe(recipe);
      recipes.set(recipe.id, recipe);
      activeRecipeIds.add(recipe.id);
      if (!existed) registered.push(recipe.id);
    }

    if (this.#llamaCppAvailable()) for (const modelPath of discoverMainGgufFiles(this.#paths.ggufModelRoot)) {
      const payloadPath = relative(this.#paths.ggufModelRoot, modelPath).split(sep).join("/");
      const guestPayloadPath = `${this.#runtime.modelRoot}/gguf/${payloadPath}`;
      if (representedPayloads.has(guestPayloadPath.toLowerCase())) continue;
      const recipe = this.#defaultRecipe(modelPath, guestPayloadPath);
      const registration: GgufRegistration = { schemaVersion: 1, id: recipe.id, engine: "llama.cpp", format: "gguf", payload: { backend: "runtime-filesystem", runtimeId: "inference-linux", path: guestPayloadPath }, recipe };
      this.#writeRegistration(registration);
      this.#store.upsertRecipe(recipe);
      routes?.upsertRecipe(recipe);
      representedPayloads.add(guestPayloadPath.toLowerCase());
      activeRecipeIds.add(recipe.id);
      registered.push(recipe.id);
    }
    for (const recipe of recipes.values()) {
      if (recipe.playbookId !== LLAMA_CPP_PLAYBOOK_ID || activeRecipeIds.has(recipe.id)) continue;
      for (const route of this.#store.listRoutes().filter((candidate) => candidate.recipeId === recipe.id)) {
        this.#store.deleteRoute(route.id);
        routes?.deleteRoute(route.id);
      }
      this.#store.deleteRecipe(recipe.id);
      routes?.deleteRecipe(recipe.id);
      unregistered.push(recipe.id);
    }
    return { registered, unregistered };
  }

  #defaultRecipe(modelPath: string, guestPayloadPath: string): Recipe {
    const fileName = basename(modelPath, ".gguf");
    const id = `gguf-${slug(fileName)}-${createHash("sha256").update(guestPayloadPath.toLowerCase()).digest("hex").slice(0, 8)}`;
    const guestDirectory = posix.dirname(guestPayloadPath);
    const args = ["--host", "{host}", "--port", "{port}", "--model", guestPayloadPath];
    const siblings = readdirSync(dirname(modelPath), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const projectors = siblings.filter((name) => /^mmproj.*\.gguf$/i.test(name));
    const projector = projectors.find((name) => name.toLowerCase().endsWith(".muse-glimmer.gguf")) ?? projectors[0];
    if (projector) args.push("--mmproj", posix.join(guestDirectory, projector));
    const dflash = siblings.find((name) => /dflash.*\.gguf$/i.test(name));
    if (dflash && /muse[-_ ]glimmer/i.test(fileName)) {
      args.push("--model-draft", posix.join(guestDirectory, dflash), "--spec-type", "draft-dflash", "--spec-draft-ngl", "999", "--spec-draft-n-max", "15");
    }
    args.push("--ctx-size", "{context}", "--parallel", "1", "--flash-attn", "on", "--jinja", "--n-gpu-layers", "999");
    return {
      id,
      playbookId: LLAMA_CPP_PLAYBOOK_ID,
      displayName: fileName.replaceAll("_", " "),
      adapter: "openai-managed",
      modelId: fileName,
      contextTokens: 32_768,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: true, minP: true, maxConcurrentGenerations: 1 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: {
        enginePath: `${this.#runtime.engineRoot}/llama.cpp`,
        runtime: "linux-managed",
        runtimeId: this.#runtime.id,
        command: "./build-linux-cuda/bin/llama-server",
        args,
        workingDirectory: ".",
        healthPath: "/v1/models",
        readinessTimeoutMs: 300_000,
        preloadPaths: preloadGgufPaths(args),
      },
    };
  }

  #readRegistrations(): Map<string, GgufRegistration> {
    const values = new Map<string, GgufRegistration>();
    for (const entry of readdirSync(this.#registrationRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(readFileSync(join(this.#registrationRoot, entry.name), "utf8")) as Partial<GgufRegistration>;
        if (value.schemaVersion !== 1 || value.engine !== "llama.cpp" || value.format !== "gguf" || !value.id || !value.recipe || value.payload?.backend !== "runtime-filesystem" || value.payload.runtimeId !== this.#runtime.id || typeof value.payload.path !== "string") continue;
        this.#payloadHostPath(value.payload.path);
        values.set(value.id, value as GgufRegistration);
      } catch { /* A malformed registration is ignored; it never authorizes a path. */ }
    }
    return values;
  }

  #writeRegistration(registration: GgufRegistration): void {
    const target = resolve(join(this.#registrationRoot, `${registration.id}.json`));
    if (relative(this.#registrationRoot, target).startsWith("..")) throw new Error(`Registration path escapes registry: ${target}`);
    const partial = `${target}.partial`;
    writeFileSync(partial, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
    renameSync(partial, target);
  }

  #payloadHostPath(payloadPath: string): string {
    const guestRoot = `${this.#runtime.modelRoot}/gguf`;
    const child = posix.relative(guestRoot, posix.resolve(payloadPath));
    if (!child || child.startsWith("..") || posix.isAbsolute(child)) throw new Error(`GGUF payload escapes registry: ${payloadPath}`);
    return resolve(join(this.#paths.ggufModelRoot, ...child.split("/")));
  }

  #insideGgufRoot(path: string): boolean {
    const child = relative(resolve(this.#paths.ggufModelRoot), resolve(path));
    return child !== "" && !child.startsWith("..") && !isAbsolute(child);
  }

  #llamaCppAvailable(): boolean {
    return existsSync(join(this.#paths.engineRoot, "llama.cpp", "build-linux-cuda", "bin", "llama-server"));
  }

  #canonicalRecipe(recipe: Recipe): Recipe {
    return {
      ...recipe,
      adapter: "openai-managed",
      configuration: {
        ...recipe.configuration,
        enginePath: `${this.#runtime.engineRoot}/llama.cpp`,
        runtime: "linux-managed",
        runtimeId: this.#runtime.id,
        command: "./build-linux-cuda/bin/llama-server",
        workingDirectory: ".",
        preloadPaths: preloadGgufPaths(recipe.configuration.args),
      },
    };
  }
}

function preloadGgufPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"
    && posix.isAbsolute(item) && item.toLowerCase().endsWith(".gguf")))];
}

function discoverMainGgufFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 5) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf") || auxiliaryGguf(entry.name, path)) continue;
      if (statSync(path).size > 0) found.push(path);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return found;
}

function auxiliaryGguf(name: string, path: string): boolean {
  const value = `${name} ${path}`.toLowerCase();
  return name.toLowerCase().startsWith("mmproj") || /(^|[-_.])(dflash|draft|mtp)([-_.]|$)/i.test(name) || value.includes("nomic-embed") || value.includes("embedding");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "model";
}
