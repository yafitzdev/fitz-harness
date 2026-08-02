import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  loadSkills,
  type PackageSource,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";

export interface PiCatalogPackage {
  name: string;
  description: string;
  version: string;
  publisher: string;
  updatedAt?: string;
  downloads?: number;
  keywords: string[];
  types: Array<"extension" | "skill" | "prompt" | "theme">;
  links: Record<string, string>;
}

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

export class PiPackageService {
  readonly #agentDir: string;
  readonly #cwd: string;
  readonly #settings: SettingsManager;
  readonly #manager: DefaultPackageManager;
  readonly #fetch: typeof globalThis.fetch;
  #operation: Promise<unknown> = Promise.resolve();

  constructor(options: PiPackageServiceOptions) {
    this.#agentDir = options.agentDir;
    this.#cwd = options.cwd;
    this.#settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
    if (options.npmCommand?.length) this.#settings.setNpmCommand(options.npmCommand);
    this.#manager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: this.#settings });
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async catalog(query = "", offset = 0, limit = 50): Promise<{ total: number; packages: PiCatalogPackage[] }> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    const safeOffset = Math.max(0, Math.trunc(offset));
    const text = [query.trim(), "keywords:pi-package"].filter(Boolean).join(" ");
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", text);
    url.searchParams.set("size", String(safeLimit));
    url.searchParams.set("from", String(safeOffset));
    const response = await this.#fetch(url, { headers: { accept: "application/json", "user-agent": "Fitz-Codex" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Pi catalog request failed (${response.status})`);
    const payload = await response.json() as { total?: number; objects?: Array<Record<string, unknown>> };
    const packages = (payload.objects ?? []).map(catalogPackage).filter((value): value is PiCatalogPackage => Boolean(value));
    return { total: Number(payload.total ?? packages.length), packages };
  }

  async installed(): Promise<InstalledPiPackage[]> {
    await this.#settings.reload();
    const resolved = await this.#manager.resolve(async () => "skip");
    const configured = this.#manager.listConfiguredPackages().filter((entry) => entry.scope === "user");
    return Promise.all(configured.map(async (entry) => {
      const manifest = entry.installedPath ? await packageManifest(entry.installedPath) : undefined;
      return {
        source: entry.source,
        displayName: manifest?.name ?? sourceName(entry.source),
        ...(manifest?.version ? { version: manifest.version } : {}),
        ...(manifest?.description ? { description: manifest.description } : {}),
        enabled: packageEnabled(this.#settings.getGlobalSettings().packages ?? [], entry.source),
        ...(entry.installedPath ? { installedPath: entry.installedPath } : {}),
        resources: resourceCounts(resolved, entry.source),
      };
    }));
  }

  async skills(): Promise<PiSkillSummary[]> {
    await this.#settings.reload();
    const resolved = await this.#manager.resolve(async () => "skip");
    const result = loadSkills({ cwd: this.#cwd, agentDir: this.#agentDir, skillPaths: resolved.skills.map((resource) => resource.path), includeDefaults: true });
    return result.skills.map((skill) => {
      const resource = resolved.skills.find((candidate) => skill.filePath === candidate.path || skill.filePath.startsWith(dirname(candidate.path)));
      return { name: skill.name, description: skill.description, source: resource?.metadata.source ?? skill.sourceInfo.source, enabled: resource?.enabled ?? true, filePath: skill.filePath };
    });
  }

  install(source: string): Promise<void> { return this.#serialize(async () => { await this.#manager.installAndPersist(normalizeSource(source)); await this.#settings.flush(); }); }
  update(source: string): Promise<void> { return this.#serialize(async () => { await this.#manager.update(normalizeSource(source)); }); }
  remove(source: string): Promise<void> {
    return this.#serialize(async () => {
      await this.#settings.reload();
      const normalized = normalizeSource(source);
      const packages = this.#settings.getGlobalSettings().packages ?? [];
      if (!packages.some((entry) => packageSource(entry) === normalized)) throw new Error("Pi package is not installed");
      await this.#manager.remove(normalized);
      this.#settings.setPackages(packages.filter((entry) => packageSource(entry) !== normalized));
      await this.#settings.flush();
    });
  }
  setEnabled(source: string, enabled: boolean): Promise<void> {
    return this.#serialize(async () => {
      await this.#settings.reload();
      const packages = this.#settings.getGlobalSettings().packages ?? [];
      const normalized = normalizeSource(source);
      const next = packages.map((entry) => packageSource(entry) === normalized
        ? enabled ? normalized : { source: normalized, autoload: false, extensions: [], skills: [], prompts: [], themes: [] }
        : entry);
      if (!next.some((entry) => packageSource(entry) === normalized)) throw new Error("Pi package is not installed");
      this.#settings.setPackages(next);
      await this.#settings.flush();
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

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

function packageTypes(keywords: string[]): PiCatalogPackage["types"] {
  const joined = keywords.join(" ").toLowerCase();
  const types: PiCatalogPackage["types"] = [];
  if (joined.includes("extension") || joined.includes("plugin")) types.push("extension");
  if (joined.includes("skill")) types.push("skill");
  if (joined.includes("prompt")) types.push("prompt");
  if (joined.includes("theme")) types.push("theme");
  return types.length ? types : ["extension"];
}

async function packageManifest(path: string): Promise<{ name?: string; version?: string; description?: string } | undefined> {
  try { return JSON.parse(await readFile(`${path}/package.json`, "utf8")) as { name?: string; version?: string; description?: string }; }
  catch { return undefined; }
}

function resourceCounts(resolved: ResolvedPaths, source: string): InstalledPiPackage["resources"] {
  const count = (resources: ResolvedPaths[keyof ResolvedPaths]) => resources.filter((resource) => resource.metadata.source === source).length;
  return { extensions: count(resolved.extensions), skills: count(resolved.skills), prompts: count(resolved.prompts), themes: count(resolved.themes) };
}
function packageSource(source: PackageSource): string { return typeof source === "string" ? source : source.source; }
function packageEnabled(packages: PackageSource[], source: string): boolean { const entry = packages.find((value) => packageSource(value) === source); return typeof entry === "string" || entry?.autoload !== false; }
function normalizeSource(source: string): string { const value = source.trim(); if (!value) throw new TypeError("Package source is required"); return /^(npm:|git:|https?:\/\/|ssh:\/\/|\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(value) ? value : `npm:${value}`; }
function sourceName(source: string): string { return basename(source.replace(/^npm:/, "").replace(/@[^@/]+$/, "")) || source; }
