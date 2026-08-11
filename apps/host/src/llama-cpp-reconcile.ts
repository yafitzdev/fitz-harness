import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Recipe } from "@fitz/protocol";
import type { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";

const LLAMA_CPP_PLAYBOOK_ID = "llama.cpp";
const REGISTRATION_DIRECTORY = ".fitz";

interface GgufRegistration {
  schemaVersion: 1;
  id: string;
  engine: "llama.cpp";
  format: "gguf";
  payload: { backend: "host-filesystem"; path: string };
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
  readonly #registrationRoot: string;

  constructor(store: SqliteStore, paths: FitzRuntimePaths) {
    this.#store = store;
    this.#paths = paths;
    this.#registrationRoot = resolve(join(paths.ggufModelRoot, REGISTRATION_DIRECTORY));
  }

  reconcile(routes?: RouteResolver): LlamaCppReconcileResult {
    mkdirSync(this.#registrationRoot, { recursive: true });
    const registrations = this.#readRegistrations();
    const recipes = new Map(this.#store.listRecipes().map((recipe) => [recipe.id, recipe]));
    const representedPayloads = new Set<string>();
    const registered: string[] = [];
    const unregistered: string[] = [];

    for (const recipe of recipes.values()) {
      if (recipe.playbookId !== LLAMA_CPP_PLAYBOOK_ID || recipe.adapter !== "openai-managed") continue;
      const modelPath = recipeModelPath(recipe);
      if (!modelPath || !this.#insideGgufRoot(modelPath)) continue;
      const payloadPath = relative(this.#paths.ggufModelRoot, resolve(modelPath)).split(sep).join("/");
      representedPayloads.add(payloadPath.toLowerCase());
      this.#writeRegistration({ schemaVersion: 1, id: recipe.id, engine: "llama.cpp", format: "gguf", payload: { backend: "host-filesystem", path: payloadPath }, recipe });
      registrations.set(recipe.id, { schemaVersion: 1, id: recipe.id, engine: "llama.cpp", format: "gguf", payload: { backend: "host-filesystem", path: payloadPath }, recipe });
      if (existsSync(modelPath)) continue;
      for (const route of this.#store.listRoutes().filter((candidate) => candidate.recipeId === recipe.id)) {
        this.#store.deleteRoute(route.id);
        routes?.deleteRoute(route.id);
      }
      this.#store.deleteRecipe(recipe.id);
      routes?.deleteRecipe(recipe.id);
      recipes.delete(recipe.id);
      unregistered.push(recipe.id);
    }

    for (const registration of registrations.values()) {
      const modelPath = this.#payloadPath(registration.payload.path);
      representedPayloads.add(registration.payload.path.toLowerCase());
      if (!existsSync(modelPath) || recipes.has(registration.id)) continue;
      const recipe = withModelPath(registration.recipe, modelPath);
      this.#store.upsertRecipe(recipe);
      routes?.upsertRecipe(recipe);
      recipes.set(recipe.id, recipe);
      registered.push(recipe.id);
    }

    if (!this.#llamaCppAvailable()) return { registered, unregistered };
    for (const modelPath of discoverMainGgufFiles(this.#paths.ggufModelRoot)) {
      const payloadPath = relative(this.#paths.ggufModelRoot, modelPath).split(sep).join("/");
      if (representedPayloads.has(payloadPath.toLowerCase())) continue;
      const recipe = this.#defaultRecipe(modelPath, payloadPath);
      const registration: GgufRegistration = { schemaVersion: 1, id: recipe.id, engine: "llama.cpp", format: "gguf", payload: { backend: "host-filesystem", path: payloadPath }, recipe };
      this.#writeRegistration(registration);
      this.#store.upsertRecipe(recipe);
      routes?.upsertRecipe(recipe);
      representedPayloads.add(payloadPath.toLowerCase());
      registered.push(recipe.id);
    }
    return { registered, unregistered };
  }

  #defaultRecipe(modelPath: string, payloadPath: string): Recipe {
    const fileName = basename(modelPath, ".gguf");
    const id = `gguf-${slug(fileName)}-${createHash("sha256").update(payloadPath.toLowerCase()).digest("hex").slice(0, 8)}`;
    const args = ["--host", "{host}", "--port", "{port}", "--model", modelPath];
    const siblings = readdirSync(dirname(modelPath), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const projectors = siblings.filter((name) => /^mmproj.*\.gguf$/i.test(name));
    const projector = projectors.find((name) => name.toLowerCase().endsWith(".muse-glimmer.gguf")) ?? projectors[0];
    if (projector) args.push("--mmproj", join(dirname(modelPath), projector));
    const dflash = siblings.find((name) => /dflash.*\.gguf$/i.test(name));
    if (dflash && /muse[-_ ]glimmer/i.test(fileName)) {
      args.push("--model-draft", join(dirname(modelPath), dflash), "--spec-type", "draft-dflash", "--spec-draft-ngl", "999", "--spec-draft-n-max", "15");
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
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
      configuration: {
        enginePath: join(this.#paths.engineRoot, "llama.cpp"),
        runtime: "windows",
        command: ".\\build-win-cuda\\bin\\Release\\llama-server.exe",
        args,
        workingDirectory: ".",
        healthPath: "/v1/models",
        readinessTimeoutMs: 300_000,
      },
    };
  }

  #readRegistrations(): Map<string, GgufRegistration> {
    const values = new Map<string, GgufRegistration>();
    for (const entry of readdirSync(this.#registrationRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(readFileSync(join(this.#registrationRoot, entry.name), "utf8")) as Partial<GgufRegistration>;
        if (value.schemaVersion !== 1 || value.engine !== "llama.cpp" || value.format !== "gguf" || !value.id || !value.recipe || value.payload?.backend !== "host-filesystem" || typeof value.payload.path !== "string") continue;
        this.#payloadPath(value.payload.path);
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

  #payloadPath(payloadPath: string): string {
    if (isAbsolute(payloadPath)) throw new Error("GGUF registration payload paths must be relative");
    const target = resolve(this.#paths.ggufModelRoot, payloadPath);
    if (!this.#insideGgufRoot(target)) throw new Error(`GGUF payload escapes registry: ${payloadPath}`);
    return target;
  }

  #insideGgufRoot(path: string): boolean {
    const child = relative(resolve(this.#paths.ggufModelRoot), resolve(path));
    return child !== "" && !child.startsWith("..") && !isAbsolute(child);
  }

  #llamaCppAvailable(): boolean {
    return existsSync(join(this.#paths.engineRoot, "llama.cpp", "build-win-cuda", "bin", "Release", "llama-server.exe"));
  }
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

function recipeModelPath(recipe: Recipe): string | undefined {
  const args = recipe.configuration.args;
  if (!Array.isArray(args)) return undefined;
  const index = args.indexOf("--model");
  return index >= 0 && typeof args[index + 1] === "string" ? args[index + 1] as string : undefined;
}

function withModelPath(recipe: Recipe, modelPath: string): Recipe {
  const args = Array.isArray(recipe.configuration.args) ? [...recipe.configuration.args] : [];
  const index = args.indexOf("--model");
  if (index >= 0) args[index + 1] = modelPath;
  return { ...recipe, configuration: { ...recipe.configuration, args } };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "model";
}
