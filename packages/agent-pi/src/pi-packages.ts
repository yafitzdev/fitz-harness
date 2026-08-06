import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";

export interface PiCatalogPackage {
  name: string;
  description: string;
  version: string;
  publisher: string;
  updatedAt?: string;
  downloads?: number;
  keywords: string[];
  types: PiPackageType[];
  links: Record<string, string>;
}

export type PiPackageType = "extension" | "skill" | "prompt" | "theme";

/** Shared catalog sort keys; `downloads`/`likes` map to npm's popularity score. */
export type CatalogSortKey = "downloads" | "updated" | "name" | "likes";
export type CatalogSortDirection = "asc" | "desc";

const CATALOG_SORT_KEYS: readonly string[] = ["downloads", "updated", "name", "likes"];

export function normalizeCatalogSort(value: unknown): CatalogSortKey {
  return typeof value === "string" && CATALOG_SORT_KEYS.includes(value) ? value as CatalogSortKey : "downloads";
}

export function normalizeCatalogDirection(value: unknown): CatalogSortDirection {
  return value === "asc" ? "asc" : "desc";
}

/**
 * npm keywords for the type facets. npm search ANDs every term, so a single
 * selected type is pushed into the query (the first page then fills with
 * matching packages instead of a sparse client-side filter of extension-heavy
 * pages); multiple selected types stay client-side.
 */
const TYPE_KEYWORDS: Record<PiPackageType, string> = {
  extension: "extension",
  skill: "skill",
  prompt: "prompt",
  theme: "theme",
};

export interface InstalledPiPackage {
  source: string;
  displayName: string;
  version?: string;
  description?: string;
  enabled: boolean;
  installedPath?: string;
  resources: { extensions: number; skills: number; prompts: number; themes: number };
}

export interface PiSkillSummary {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  filePath: string;
}

export interface PiPackageServiceOptions {
  agentDir: string;
  cwd: string;
  npmCommand?: string[];
  fetch?: typeof globalThis.fetch;
}

/**
 * Pi packages live in a single folder — `{agentDir}/extensions/` — and that folder is the
 * registry: `extensions/registry.json` is the source of truth for what is installed and
 * enabled. Each package is a directory (`extensions/<name>/`) containing the package files,
 * its own `config.json`, and its own `node_modules/` for runtime dependencies. Nothing is
 * stored in `{agentDir}/npm/` or in `settings.json`'s `packages` array.
 */
export class PiPackageService {
  readonly #agentDir: string;
  readonly #cwd: string;
  readonly #extensionsRoot: string;
  readonly #registryPath: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #npmCommand: string[];
  #operation: Promise<unknown> = Promise.resolve();
  #migration: Promise<void> | undefined;

  constructor(options: PiPackageServiceOptions) {
    this.#agentDir = options.agentDir;
    this.#cwd = options.cwd;
    this.#extensionsRoot = join(options.agentDir, "extensions");
    this.#registryPath = join(this.#extensionsRoot, "registry.json");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#npmCommand = options.npmCommand?.length ? options.npmCommand : ["npm"];
  }

  async catalog(query = "", offset = 0, limit = 50, sort: CatalogSortKey = "downloads", direction: CatalogSortDirection = "desc", types: PiPackageType[] = []): Promise<{ total: number; packages: PiCatalogPackage[] }> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeTypes = types.filter((type): type is PiPackageType => type in TYPE_KEYWORDS);
    const typeTerm = safeTypes.length === 1 ? `keywords:${TYPE_KEYWORDS[safeTypes[0]!]}` : "";
    const text = [query.trim(), "keywords:pi-package", typeTerm].filter(Boolean).join(" ");
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", text);
    url.searchParams.set("size", String(safeLimit));
    url.searchParams.set("from", String(safeOffset));
    if (sort === "downloads" || sort === "likes") {
      // npm ranks results by a weighted score rather than raw counts; its
      // popularity measure is derived from download activity, so "most
      // downloads" (and "most likes", which npm doesn't track) sort by it.
      url.searchParams.set("popularity", "1.0");
      url.searchParams.set("quality", "0");
      url.searchParams.set("maintenance", "0");
    }
    const response = await this.#fetch(url, { headers: { accept: "application/json", "user-agent": "Fitz-Codex" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Pi catalog request failed (${response.status})`);
    const payload = await response.json() as { total?: number; objects?: Array<Record<string, unknown>> };
    const packages = (payload.objects ?? []).map(catalogPackage).filter((value): value is PiCatalogPackage => Boolean(value));
    // npm only sorts server-side by its weighted score; name and date are
    // ordered here over the fetched page (approximate with pagination).
    if (sort === "name") packages.sort((left, right) => direction === "asc" ? left.name.localeCompare(right.name) : right.name.localeCompare(left.name));
    if (sort === "updated") packages.sort((left, right) => sortByUpdated(left, right, direction));
    if ((sort === "downloads" || sort === "likes") && direction === "asc") packages.reverse();
    return { total: Number(payload.total ?? packages.length), packages };
  }

  async installed(): Promise<InstalledPiPackage[]> {
    await this.#ensureMigrated();
    const registry = await this.#readRegistry();
    return Promise.all(registry.packages.map(async (entry) => {
      const dir = this.#entryDir(entry);
      const manifest = await packageManifest(dir);
      const version = entry.version ?? manifest?.version;
      const description = manifest?.description;
      return {
        source: entry.source,
        displayName: manifest?.name ?? entry.name,
        ...(version !== undefined ? { version } : {}),
        ...(description !== undefined ? { description } : {}),
        enabled: entry.enabled,
        installedPath: dir,
        resources: packageResourceCounts(manifest, dir),
      };
    }));
  }

  async skills(): Promise<PiSkillSummary[]> {
    await this.#ensureMigrated();
    const registry = await this.#readRegistry();
    const enabledByDir = new Map(registry.packages.map((entry) => [this.#entryDir(entry), entry.enabled]));
    const packageSkillPaths: string[] = [];
    for (const entry of registry.packages) {
      packageSkillPaths.push(...await collectSkillFiles(this.#entryDir(entry)));
    }
    const result = loadSkills({ cwd: this.#cwd, agentDir: this.#agentDir, skillPaths: packageSkillPaths, includeDefaults: true });
    return result.skills.map((skill) => {
      const packageDir = packageDirContaining(skill.filePath, this.#extensionsRoot);
      const isPackage = packageDir !== undefined;
      return {
        name: skill.name,
        description: skill.description,
        source: isPackage ? "package" : skill.sourceInfo?.source ?? "unknown",
        enabled: isPackage ? (enabledByDir.get(packageDir) ?? true) : true,
        filePath: skill.filePath,
      };
    });
  }

  install(source: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#ensureMigrated();
      const normalized = normalizeSource(source);
      const dir = this.#packageTargetDir(normalized);
      await mkdir(dir, { recursive: true });
      if (isNpmSource(normalized)) {
        await this.#installNpmPackage(normalized.slice("npm:".length), dir);
      } else {
        await this.#installLocalPackage(normalized, dir);
      }
      const manifest = await packageManifest(dir);
      const registry = await this.#readRegistry();
      const existing = registry.packages.find((entry) => entry.source === normalized);
      if (existing) {
        existing.name = basename(dir);
        if (manifest?.version !== undefined) existing.version = manifest.version;
        existing.enabled = true;
      } else {
        registry.packages.push({ source: normalized, name: basename(dir), enabled: true, ...(manifest?.version !== undefined ? { version: manifest.version } : {}) });
      }
      await this.#writeRegistry(registry);
    });
  }

  update(source: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#ensureMigrated();
      const registry = await this.#readRegistry();
      const entry = registry.packages.find((candidate) => candidate.source === source);
      if (!entry) throw new Error("Pi package is not installed");
      const dir = this.#entryDir(entry);
      const configPath = join(dir, "config.json");
      const savedConfig = existsSync(configPath) ? await readFile(configPath) : undefined;
      if (isNpmSource(entry.source)) {
        await this.#installNpmPackage(entry.source.slice("npm:".length), dir);
      } else {
        await this.#installLocalPackage(entry.source, dir);
      }
      if (savedConfig && !existsSync(configPath)) await writeFile(configPath, savedConfig);
      const manifest = await packageManifest(dir);
      if (manifest?.version !== undefined) entry.version = manifest.version;
      await this.#writeRegistry(registry);
    });
  }

  remove(source: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#ensureMigrated();
      const registry = await this.#readRegistry();
      const index = registry.packages.findIndex((entry) => entry.source === source);
      if (index === -1) throw new Error("Pi package is not installed");
      const [entry] = registry.packages.splice(index, 1);
      if (entry) await rm(this.#entryDir(entry), { recursive: true, force: true });
      await this.#writeRegistry(registry);
    });
  }

  setEnabled(source: string, enabled: boolean): Promise<void> {
    return this.#serialize(async () => {
      await this.#ensureMigrated();
      const registry = await this.#readRegistry();
      const entry = registry.packages.find((candidate) => candidate.source === source);
      if (!entry) throw new Error("Pi package is not installed");
      entry.enabled = enabled;
      await this.#writeRegistry(registry);
    });
  }

  #entryDir(entry: { name: string }): string {
    return join(this.#extensionsRoot, entry.name);
  }

  #packageTargetDir(source: string): string {
    if (isNpmSource(source)) return join(this.#extensionsRoot, packageDirName(source.slice("npm:".length)));
    return join(this.#extensionsRoot, packageDirName(basename(resolve(source))));
  }

  async #installNpmPackage(spec: string, dir: string): Promise<void> {
    const { name, version } = parseNpmSpec(spec);
    const manifestBackup = existsSync(join(dir, "package.json")) ? await readFile(join(dir, "package.json")) : undefined;
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: `fitz-ext-${basename(dir)}`, private: true, dependencies: { [name]: version ?? "latest" } }, null, 2));
      await this.#runNpm(["install", "--prefix", dir, "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"]);
      const scoped = name.startsWith("@");
      const installed = scoped ? join(dir, "node_modules", ...name.split("/")) : join(dir, "node_modules", name);
      if (!existsSync(installed)) throw new Error(`npm install did not produce ${name} under ${dir}`);
      await cp(installed, dir, { recursive: true, force: true });
      await rm(installed, { recursive: true, force: true });
    } catch (error) {
      if (manifestBackup) await writeFile(join(dir, "package.json"), manifestBackup);
      else await rm(join(dir, "package.json"), { force: true });
      throw error;
    }
  }

  async #installLocalPackage(sourcePath: string, dir: string): Promise<void> {
    if (!existsSync(sourcePath)) throw new Error(`Path does not exist: ${sourcePath}`);
    await cp(sourcePath, dir, { recursive: true, force: true });
  }

  #runNpm(args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const [command, ...commandArgs] = this.#npmCommand;
      if (!command) { reject(new Error("npm command is not configured")); return; }
      const child = spawn(command, [...commandArgs, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`npm ${args[0] ?? "command"} failed (exit ${code}): ${output.slice(-2000)}`));
      });
    });
  }

  async #readRegistry(): Promise<{ version: number; packages: PiRegistryEntry[] }> {
    const fallback = { version: 1 as const, packages: [] as PiRegistryEntry[] };
    try {
      const parsed = JSON.parse(await readFile(this.#registryPath, "utf8")) as Partial<{ version: number; packages: unknown }>;
      if (!Array.isArray(parsed.packages)) return fallback;
      const packages = parsed.packages.filter((entry): entry is PiRegistryEntry =>
        Boolean(entry) && typeof entry === "object"
        && typeof (entry as PiRegistryEntry).source === "string"
        && typeof (entry as PiRegistryEntry).name === "string"
        && typeof (entry as PiRegistryEntry).enabled === "boolean");
      return { version: 1, packages };
    } catch {
      return fallback;
    }
  }

  async #writeRegistry(registry: { version: number; packages: PiRegistryEntry[] }): Promise<void> {
    await mkdir(this.#extensionsRoot, { recursive: true });
    await writeFile(this.#registryPath, JSON.stringify(registry, null, 2));
  }

  #ensureMigrated(): Promise<void> {
    if (!this.#migration) {
      this.#migration = (async () => {
        if (!existsSync(this.#registryPath)) await this.#migrateLegacyLayout();
      })().finally(() => { this.#migration = undefined; });
    }
    return this.#migration;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * One-time migration from the old layout: packages lived in `{agentDir}/npm/node_modules`
   * (installed via the Pi SDK package manager) and the enabled list lived in
   * `settings.json`'s `packages` array; a legacy `{agentDir}/extensions/<name>/config.json`
   * dir might also exist (Pi CLI convention). Everything is consolidated into
   * `extensions/<name>/` + `extensions/registry.json`. Idempotent and crash-safe: the old
   * `npm/` tree is only deleted after the registry is written and settings are cleared.
   */
  async #migrateLegacyLayout(): Promise<void> {
    const npmRoot = join(this.#agentDir, "npm");
    const settingsPath = join(this.#agentDir, "settings.json");
    const settings = await readJsonSafe(settingsPath);
    const oldPackages = Array.isArray(settings?.packages) ? settings.packages : [];
    const npmNodeModules = join(npmRoot, "node_modules");
    const hasNpmTree = existsSync(npmNodeModules);
    if (!hasNpmTree && oldPackages.length === 0 && !(await this.#hasLegacyExtensionDirs())) return;

    const entries: PiRegistryEntry[] = [];
    const seen = new Set<string>();

    // 1a. Packages listed in the old settings.json.
    for (const pkg of oldPackages) {
      const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
      const enabled = typeof pkg === "string" || (typeof pkg === "object" && pkg?.autoload !== false);
      if (seen.has(sourceStr)) continue;
      if (isNpmSource(sourceStr)) {
        const name = sourceStr.slice("npm:".length);
        const src = join(npmNodeModules, ...name.split("/"));
        if (!existsSync(src)) continue;
        const entryName = packageDirName(name);
        await this.#mergePackageInto(join(this.#extensionsRoot, entryName), src);
        const manifest = await packageManifest(src);
        entries.push({ source: sourceStr, name: entryName, enabled, ...(manifest?.version !== undefined ? { version: manifest.version } : {}) });
        seen.add(sourceStr);
      } else if (sourceStr) {
        const resolved = existsSync(sourceStr) ? sourceStr : join(this.#agentDir, sourceStr);
        if (!existsSync(resolved)) continue;
        const entryName = packageDirName(basename(resolve(resolved)));
        await this.#mergePackageInto(join(this.#extensionsRoot, entryName), resolved);
        const manifest = await packageManifest(resolved);
        entries.push({ source: sourceStr, name: entryName, enabled, ...(manifest?.version !== undefined ? { version: manifest.version } : {}) });
        seen.add(sourceStr);
      }
    }

    // 1b. Pi packages physically present in npm/node_modules but not in settings.json.
    if (hasNpmTree) {
      for (const name of await npmPackageNames(npmNodeModules)) {
        const sourceStr = `npm:${name}`;
        if (seen.has(sourceStr)) continue;
        const src = join(npmNodeModules, ...name.split("/"));
        const manifest = await packageManifest(src);
        if (!isPiPackageManifest(manifest)) continue;
        const entryName = packageDirName(name);
        await this.#mergePackageInto(join(this.#extensionsRoot, entryName), src);
        entries.push({ source: sourceStr, name: entryName, enabled: true, ...(manifest?.version !== undefined ? { version: manifest.version } : {}) });
        seen.add(sourceStr);
      }
    }

    // 1c. Legacy extension dirs under extensions/ that are not covered above.
    for (const name of await readdirSafe(this.#extensionsRoot)) {
      const dir = join(this.#extensionsRoot, name);
      const stats = await statSafe(dir);
      if (!stats?.isDirectory() || name === "node_modules" || name === "tmp") continue;
      if (entries.some((entry) => entry.name === name)) continue;
      const manifest = await packageManifest(dir);
      if (!isPiPackageManifest(manifest) && !existsSync(join(dir, "index.ts")) && !existsSync(join(dir, "index.js"))) continue;
      entries.push({ source: `local:${dir}`, name, enabled: true, ...(manifest?.version !== undefined ? { version: manifest.version } : {}) });
    }

    // 2. Reinstall per-package dependencies for migrated npm packages that declare any.
    for (const entry of entries) {
      if (!isNpmSource(entry.source)) continue;
      const dir = join(this.#extensionsRoot, entry.name);
      const manifest = await packageManifest(dir);
      if (!manifest || Object.keys(manifest.dependencies ?? {}).length === 0) continue;
      await this.#runNpm(["install", "--prefix", dir, "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"]);
    }

    // 3. Write the registry, then clear settings.json packages, then delete the old tree.
    await this.#writeRegistry({ version: 1, packages: entries });
    if (oldPackages.length > 0 && settings && typeof settings === "object" && !Array.isArray(settings)) {
      const { packages: _dropped, ...rest } = settings as Record<string, unknown> & { packages?: unknown };
      await writeFile(settingsPath, JSON.stringify(rest, null, 2));
    }
    if (hasNpmTree) await rm(npmRoot, { recursive: true, force: true });
  }

  async #mergePackageInto(targetDir: string, sourceDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true, force: true });
  }

  async #hasLegacyExtensionDirs(): Promise<boolean> {
    for (const name of await readdirSafe(this.#extensionsRoot)) {
      if (name === "node_modules" || name === "tmp" || name === "registry.json") continue;
      const dir = join(this.#extensionsRoot, name);
      const stats = await statSafe(dir);
      if (!stats?.isDirectory()) continue;
      if (existsSync(join(dir, "index.ts")) || existsSync(join(dir, "index.js"))) return true;
      const manifest = await packageManifest(dir);
      if (isPiPackageManifest(manifest)) return true;
    }
    return false;
  }
}

interface PiRegistryEntry { source: string; name: string; version?: string; enabled: boolean }

function catalogPackage(entry: Record<string, unknown>): PiCatalogPackage | undefined {
  const pkg = entry.package as Record<string, unknown> | undefined;
  if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string") return undefined;
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.filter((value): value is string => typeof value === "string") : [];
  return {
    name: pkg.name,
    description: typeof pkg.description === "string" ? pkg.description : "Pi package",
    version: pkg.version,
    publisher: typeof (pkg.publisher as Record<string, unknown> | undefined)?.username === "string" ? String((pkg.publisher as Record<string, unknown>).username) : "npm",
    ...(typeof pkg.date === "string" ? { updatedAt: pkg.date } : {}),
    keywords,
    types: packageTypes(keywords),
    links: Object.fromEntries(Object.entries((pkg.links as Record<string, unknown> | undefined) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  };
}

function packageTypes(keywords: string[]): PiPackageType[] {
  const joined = keywords.join(" ").toLowerCase();
  const types: PiPackageType[] = [];
  if (joined.includes("extension") || joined.includes("plugin")) types.push("extension");
  if (joined.includes("skill")) types.push("skill");
  if (joined.includes("prompt")) types.push("prompt");
  if (joined.includes("theme")) types.push("theme");
  return types.length ? types : ["extension"];
}

/** Newest-first by default; packages without a publish date sort last either way. */
function sortByUpdated(left: PiCatalogPackage, right: PiCatalogPackage, direction: CatalogSortDirection): number {
  const a = left.updatedAt ? Date.parse(left.updatedAt) : 0;
  const b = right.updatedAt ? Date.parse(right.updatedAt) : 0;
  return direction === "desc" ? b - a : a - b;
}

interface PackageManifest { name?: string; version?: string; description?: string; dependencies?: Record<string, string>; keywords?: string[]; pi?: Record<string, unknown> }
async function packageManifest(path: string): Promise<PackageManifest | undefined> {
  try { return JSON.parse(await readFile(`${path}/package.json`, "utf8")) as PackageManifest; }
  catch { return undefined; }
}
function isPiPackageManifest(manifest: PackageManifest | undefined): boolean { return Boolean(manifest?.pi || manifest?.keywords?.some((keyword) => keyword === "pi-package" || keyword.startsWith("pi-extension"))); }

function packageResourceCounts(manifest: PackageManifest | undefined, dir: string): InstalledPiPackage["resources"] {
  const pi = manifest?.pi;
  const extensions = Array.isArray(pi?.extensions) ? pi.extensions.length : (existsSync(join(dir, "index.ts")) || existsSync(join(dir, "index.js")) ? 1 : 0);
  const skills = Array.isArray(pi?.skills) ? pi.skills.length : 0;
  const prompts = Array.isArray(pi?.prompts) ? pi.prompts.length : 0;
  const themes = Array.isArray(pi?.themes) ? pi.themes.length : 0;
  return { extensions, skills, prompts, themes };
}

async function collectSkillFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await collectSkillFiles(full));
      else if (entry.isFile() && entry.name === "SKILL.md") found.push(full);
    }
  } catch { /* not a directory */ }
  return found;
}

function packageDirContaining(filePath: string, root: string): string | undefined {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!filePath.startsWith(normalizedRoot)) return undefined;
  const rest = filePath.slice(normalizedRoot.length);
  const firstSegment = rest.split(sep)[0];
  return firstSegment ? join(root, firstSegment) : undefined;
}

async function npmPackageNames(npmNodeModules: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const entries = await readdir(npmNodeModules, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        for (const sub of await readdirSafe(join(npmNodeModules, entry.name))) {
          const stats = await statSafe(join(npmNodeModules, entry.name, sub));
          if (stats?.isDirectory()) names.push(`${entry.name}/${sub}`);
        }
      } else {
        names.push(entry.name);
      }
    }
  } catch { /* not a directory */ }
  return names;
}

function isNpmSource(source: string): boolean { return source.startsWith("npm:"); }

/** `pi-web-access@0.18.0` → { name: "pi-web-access", version: "0.18.0" }; `@scope/pkg@1.2.3` → { name: "@scope/pkg", version: "1.2.3" }. */
function parseNpmSpec(spec: string): { name: string; version?: string } {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { name: trimmed };
  const name = trimmed.slice(0, at);
  const version = trimmed.slice(at + 1);
  return version ? { name, version } : { name };
}

/** Directory name under extensions/: scoped package names collapse to their basename. */
function packageDirName(name: string): string {
  const stripped = name.replace(/@[^@/]+$/, "");
  return basename(stripped) || "package";
}

function normalizeSource(source: string): string {
  const value = source.trim();
  if (!value) throw new TypeError("Package source is required");
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(value) ? value : `npm:${value}`;
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch { return undefined; }
}

async function readdirSafe(path: string): Promise<string[]> {
  try { return await readdir(path); } catch { return []; }
}

async function statSafe(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try { return await stat(path); } catch { return undefined; }
}
