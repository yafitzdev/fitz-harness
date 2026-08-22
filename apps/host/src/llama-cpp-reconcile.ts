import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { LOCAL_MAIN_CONTEXT_TOKENS, type Recipe, type RecipeSpeculativeDecoding, type SpeculativeDrafter, type SpeculativeDecodingStrategy } from "@fitz/protocol";
import type { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import type { FitzRuntimePaths } from "./runtime-paths.js";
import { managedLinuxRuntimeLayout, type ManagedLinuxRuntimeLayout } from "./managed-linux-runtime.js";
import { withLocalAgentCapacity } from "./local-agent-capacity.js";
import { ggufHasTensor } from "./gguf-inspection.js";

const LLAMA_CPP_PLAYBOOK_ID = "llama.cpp";
const REGISTRATION_DIRECTORY = ".fitz";
const LLAMA_CPP_DEFAULT_COMMAND = "./build-linux-cuda/bin/llama-server";
const LLAMA_CPP_DFLASH2_COMMAND = "./build-linux-cuda-dflash2/bin/llama-server";

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
      // Auxiliary GGUFs (DFlash/MTP/projectors/embeddings) are payloads used by
      // a target model, never user-selectable recipes. Older builds persisted
      // them as standalone registrations, so retire those registrations during
      // reconciliation instead of letting them leak back into the catalog.
      if (auxiliaryGguf(basename(modelPath), modelPath)) {
        this.#retireRecipe(registration.id, recipes, routes);
        this.#deleteRegistration(registration.id);
        unregistered.push(registration.id);
        continue;
      }
      representedPayloads.add(registration.payload.path.toLowerCase());
      if (!existsSync(modelPath)) continue;
      const existed = recipes.has(registration.id);
      const recipe = this.#canonicalRecipe(registration.recipe, recipes.get(registration.id), modelPath);
      registration.recipe = recipe;
      this.#writeRegistration(registration);
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
      if ((recipe.playbookId !== LLAMA_CPP_PLAYBOOK_ID && !recipeIsAuxiliary(recipe)) || activeRecipeIds.has(recipe.id)) continue;
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

  /** Returns auxiliary drafter artifacts for first-class target recipe
   * configuration. These are deliberately not Recipes and therefore cannot be
   * assigned to a route or loaded on their own. */
  listDrafterCandidates(): SpeculativeDrafter[] {
    if (!dflash2RuntimeAvailable(this.#paths)) return [];
    return discoverDrafterFiles(this.#paths.ggufModelRoot).sort((left, right) => left.localeCompare(right)).map((modelPath) => {
      const payloadPath = relative(this.#paths.ggufModelRoot, modelPath).split(sep).join("/");
      const guestPath = `${this.#runtime.modelRoot}/gguf/${payloadPath}`;
      return {
        id: `gguf-drafter-${createHash("sha256").update(guestPath.toLowerCase()).digest("hex").slice(0, 12)}`,
        modelId: basename(modelPath, ".gguf"),
        path: guestPath,
      };
    });
  }

  #defaultRecipe(modelPath: string, guestPayloadPath: string): Recipe {
    const fileName = basename(modelPath, ".gguf");
    const id = `gguf-${slug(fileName)}-${createHash("sha256").update(guestPayloadPath.toLowerCase()).digest("hex").slice(0, 8)}`;
    const guestDirectory = posix.dirname(guestPayloadPath);
    const args = ["--host", "{host}", "--port", "{port}", "--model", guestPayloadPath, "--alias", "{model}"];
    const siblings = readdirSync(dirname(modelPath), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const projectors = siblings.filter((name) => /^mmproj.*\.gguf$/i.test(name));
    const projector = projectors.find((name) => name.toLowerCase().endsWith(".muse-glimmer.gguf")) ?? projectors[0];
    if (projector) args.push("--mmproj", posix.join(guestDirectory, projector));
    args.push("--ctx-size", "{context}", "--parallel", "1", "--flash-attn", "on", "--jinja", "--n-gpu-layers", "999");
    const drafter = this.#findDrafter(modelPath, guestDirectory);
    return withLocalAgentCapacity({
      id,
      playbookId: LLAMA_CPP_PLAYBOOK_ID,
      displayName: fileName.replaceAll("_", " "),
      adapter: "openai-managed",
      modelId: fileName,
      contextTokens: LOCAL_MAIN_CONTEXT_TOKENS,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: true, minP: true, maxConcurrentGenerations: 1 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
      configuration: {
        enginePath: `${this.#runtime.engineRoot}/llama.cpp`,
        runtime: "linux-managed",
        runtimeId: this.#runtime.id,
        command: llamaCppCommand(this.#paths, drafter),
        args,
        workingDirectory: ".",
        healthPath: "/v1/models",
        readinessTimeoutMs: 300_000,
        preloadPaths: preloadGgufPaths(args, drafter),
      },
      ...(drafter ? { speculativeDecoding: drafter } : {}),
    });
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

  #deleteRegistration(id: string): void {
    const target = resolve(join(this.#registrationRoot, `${id}.json`));
    if (relative(this.#registrationRoot, target).startsWith("..")) throw new Error(`Registration path escapes registry: ${target}`);
    if (existsSync(target)) unlinkSync(target);
  }

  #retireRecipe(id: string, recipes: Map<string, Recipe>, routes?: RouteResolver): void {
    const recipe = recipes.get(id);
    if (recipe) {
      for (const route of this.#store.listRoutes().filter((candidate) => candidate.recipeId === id)) {
        this.#store.deleteRoute(route.id);
        routes?.deleteRoute(route.id);
      }
      this.#store.deleteRecipe(id);
      routes?.deleteRecipe(id);
      recipes.delete(id);
    }
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

  #canonicalRecipe(recipe: Recipe, existing: Recipe | undefined, modelPath: string): Recipe {
    const args = normalizeLlamaSpeculativeArgs(recipe.configuration.args);
    const legacy = parseLegacySpeculativeDecoding(recipe.configuration.args);
    // Once a registration has been canonicalized, an absent relationship in
    // the live recipe is meaningful: it represents an explicit user disable.
    // Before canonicalization, only legacy raw flags are eligible for
    // migration; a typed registration relation must not resurrect a disabled
    // drafter on the next refresh.
    const explicitlyDisabled = existing?.speculativeDecoding === null || recipe.speculativeDecoding === null;
    const explicit = explicitlyDisabled
      ? undefined
      : existing
        ? (existing.speculativeDecoding ?? (recipe.speculativeDecoding ? undefined : legacy))
        : (recipe.speculativeDecoding ?? legacy);
    const payloadPath = relative(this.#paths.ggufModelRoot, modelPath).split(sep).join("/");
    const guestDirectory = posix.dirname(`${this.#runtime.modelRoot}/gguf/${payloadPath}`);
    const autoDetectionAllowed = !explicitlyDisabled && !(existing && !existing.speculativeDecoding && Boolean(recipe.speculativeDecoding));
    const drafter = explicit?.source === "manual"
      ? explicit
      : autoDetectionAllowed ? this.#findDrafter(modelPath, guestDirectory) : undefined;
    const speculativeDecoding = drafter && (drafter.strategy === "draft-mtp" || drafter.drafter.path) ? drafter : undefined;
    const { speculativeDecoding: _registrationSpeculativeDecoding, ...recipeWithoutSpeculative } = recipe;
    return withLocalAgentCapacity({
      ...recipeWithoutSpeculative,
      displayName: existing?.displayName ?? recipe.displayName,
      adapter: "openai-managed",
      // Managed GGUF recipes use Fitz's local main-agent quality envelope.
      // Older registrations carried the historical 32k discovery default;
      // reconciliation migrates those durable records to the current policy.
      contextTokens: LOCAL_MAIN_CONTEXT_TOKENS,
      configuration: {
        ...recipe.configuration,
        enginePath: `${this.#runtime.engineRoot}/llama.cpp`,
        runtime: "linux-managed",
        runtimeId: this.#runtime.id,
        command: llamaCppCommand(this.#paths, speculativeDecoding),
        workingDirectory: ".",
        args,
        preloadPaths: preloadGgufPaths(args, speculativeDecoding),
      },
      ...(explicitlyDisabled ? { speculativeDecoding: null } : speculativeDecoding ? { speculativeDecoding } : {}),
    });
  }

  #findDrafter(modelPath: string, guestDirectory: string): RecipeSpeculativeDecoding | undefined {
    if (ggufHasNativeMtp(modelPath)) {
      return {
        strategy: "draft-mtp",
        maxDraftTokens: 4,
        gpuLayers: "all",
        source: "auto",
      };
    }
    // DFlash2 checkpoints are not compatible with the normal llama.cpp
    // loader. Only auto-link them when the matching runtime binary is
    // installed; otherwise the target remains a normal llama.cpp recipe.
    if (!dflash2RuntimeAvailable(this.#paths)) return undefined;
    const candidates = readdirSync(dirname(modelPath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && isDrafterGguf(entry.name))
      .map((entry) => entry.name)
      .filter((name) => modelFamilyCompatible(basename(modelPath, ".gguf"), basename(name, ".gguf")));
    if (candidates.length !== 1) return undefined;
    const name = candidates[0]!;
    const guestPath = posix.join(guestDirectory || `${this.#runtime.modelRoot}/gguf`, name);
    return {
      strategy: "draft-dflash",
      drafter: { id: `gguf-drafter-${createHash("sha256").update(guestPath.toLowerCase()).digest("hex").slice(0, 12)}`, modelId: basename(name, ".gguf"), path: guestPath },
      // DFlash2 can draft seven future tokens, but verification overhead and
      // acceptance decay make that width a poor default for long coding-agent
      // histories. Width four remains near the shallow-context maximum while
      // materially outperforming seven around the 32k working-set boundary.
      maxDraftTokens: 4,
      gpuLayers: "all",
      source: "auto",
    };
  }
}

function llamaCppCommand(paths: FitzRuntimePaths, speculative?: RecipeSpeculativeDecoding): string {
  if ((speculative?.strategy === "draft-dflash" || speculative?.strategy === "draft-mtp") && dflash2RuntimeAvailable(paths)) {
    return LLAMA_CPP_DFLASH2_COMMAND;
  }
  return LLAMA_CPP_DEFAULT_COMMAND;
}

function dflash2RuntimeAvailable(paths: FitzRuntimePaths): boolean {
  return existsSync(join(paths.engineRoot, "llama.cpp", "build-linux-cuda-dflash2", "bin", "llama-server"));
}

function preloadGgufPaths(value: unknown, speculative?: RecipeSpeculativeDecoding): string[] {
  const paths = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string"
      && posix.isAbsolute(item) && item.toLowerCase().endsWith(".gguf"))
    : [];
  if (speculative?.strategy !== "draft-mtp" && speculative?.drafter.path && posix.isAbsolute(speculative.drafter.path)) paths.push(speculative.drafter.path);
  return [...new Set(paths)];
}

/** GGUF tensor descriptors live near the beginning of the file. Native MTP
 * checkpoints expose `nextn` tensors there; inspect only a bounded header
 * prefix instead of reading multi-gigabyte model payloads or guessing from a
 * filename. */
function ggufHasNativeMtp(path: string): boolean {
  return ggufHasTensor(path, (name) => name.includes(".nextn."));
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

function discoverDrafterFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 5) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf") && isDrafterGguf(entry.name) && statSync(path).size > 0) found.push(path);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return found;
}

function auxiliaryGguf(name: string, path: string): boolean {
  const value = `${name} ${path}`.toLowerCase();
  return name.toLowerCase().startsWith("mmproj") || isDrafterGguf(name) || isMtpGguf(name) || value.includes("nomic-embed") || value.includes("embedding");
}

function recipeIsAuxiliary(recipe: Recipe): boolean {
  const modelPath = typeof recipe.configuration.modelPath === "string" ? recipe.configuration.modelPath : undefined;
  const args = Array.isArray(recipe.configuration.args) ? recipe.configuration.args : [];
  const modelArgIndex = args.findIndex((item) => item === "--model" || item === "-m");
  const primaryArg = modelArgIndex >= 0 && typeof args[modelArgIndex + 1] === "string" ? args[modelArgIndex + 1] : undefined;
  return [recipe.modelId, modelPath, primaryArg]
    .filter((value): value is string => typeof value === "string")
    .some((value) => auxiliaryGguf(basename(value), value));
}

function isDrafterGguf(name: string): boolean {
  return /(^|[-_.])(dflash\d*|draft)([-_.]|$)/i.test(name);
}

function isMtpGguf(name: string): boolean {
  return /(^|[-_.])mtp([-_.]|$)/i.test(name);
}

function modelFamilyCompatible(target: string, drafter: string): boolean {
  const targetFamily = modelFamilyKey(target);
  const drafterFamily = modelFamilyKey(drafter);
  return targetFamily === drafterFamily || targetFamily.startsWith(`${drafterFamily}-`) || drafterFamily.startsWith(`${targetFamily}-`);
}

function modelFamilyKey(value: string): string {
  const normalized = value.toLowerCase().replace(/\.gguf$/i, "").replace(/[ _]+/g, "-").replace(/-+/g, "-");
  return normalized
    .replace(/-(?:dflash\d*|draft|mtp)(?:-.*)?$/i, "")
    .replace(/-(?:q\d+|iq\d+|f\d+|bf\d+|fp\d+|int\d+|nvfp\d+)(?:-.*)?$/i, "")
    .replace(/-+$/g, "");
}

function normalizeLlamaSpeculativeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const options = new Set(["--model-draft", "--spec-type", "--spec-draft-ngl", "--spec-draft-n-max"]);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") continue;
    const option = item.split("=", 1)[0] ?? "";
    if (!options.has(option)) { result.push(item); continue; }
    if (!item.includes("=") && index + 1 < value.length) index += 1;
  }
  return result;
}

function parseLegacySpeculativeDecoding(value: unknown): RecipeSpeculativeDecoding | undefined {
  if (!Array.isArray(value)) return undefined;
  const args = value.filter((item): item is string => typeof item === "string");
  const draftIndex = args.findIndex((arg) => arg === "--model-draft" || arg.startsWith("--model-draft="));
  if (draftIndex < 0) return undefined;
  const draftArg = args[draftIndex]!;
  const path = draftArg.includes("=") ? draftArg.slice(draftArg.indexOf("=") + 1) : args[draftIndex + 1];
  if (!path) return undefined;
  const strategyIndex = args.findIndex((arg) => arg === "--spec-type" || arg.startsWith("--spec-type="));
  const strategyArg = strategyIndex >= 0 ? (args[strategyIndex]!.includes("=") ? args[strategyIndex]!.slice(args[strategyIndex]!.indexOf("=") + 1) : args[strategyIndex + 1]) : "draft-model";
  const strategy: SpeculativeDecodingStrategy = strategyArg === "draft-dflash" || strategyArg === "draft-mtp" ? strategyArg : "draft-model";
  const maxIndex = args.findIndex((arg) => arg === "--spec-draft-n-max" || arg.startsWith("--spec-draft-n-max="));
  const maxArg = maxIndex >= 0 ? (args[maxIndex]!.includes("=") ? args[maxIndex]!.slice(args[maxIndex]!.indexOf("=") + 1) : args[maxIndex + 1]) : undefined;
  const maxDraftTokens = maxArg && Number.isInteger(Number(maxArg)) && Number(maxArg) > 0 ? Number(maxArg) : 15;
  const nglIndex = args.findIndex((arg) => arg === "--spec-draft-ngl" || arg.startsWith("--spec-draft-ngl="));
  const nglArg = nglIndex >= 0 ? (args[nglIndex]!.includes("=") ? args[nglIndex]!.slice(args[nglIndex]!.indexOf("=") + 1) : args[nglIndex + 1]) : undefined;
  const gpuLayers = nglArg === "999" ? "all" : nglArg && Number.isInteger(Number(nglArg)) ? Number(nglArg) : "all";
  if (strategy === "draft-mtp") return { strategy, maxDraftTokens, gpuLayers, source: "auto" };
  return { strategy, drafter: { id: `gguf-drafter-${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 12)}`, modelId: basename(path, ".gguf"), path }, maxDraftTokens, gpuLayers, source: "auto" };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "model";
}
