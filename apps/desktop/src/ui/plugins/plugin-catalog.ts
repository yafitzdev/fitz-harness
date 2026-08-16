import { svgIcon } from "../primitives/dom.js";
import { CollapsibleSection } from "../layout/collapsible-section.js";
import { CatalogFilterBar } from "../catalog/catalog-filter-bar.js";
import { catalogQueryString, type CatalogSortOption } from "../catalog/catalog-filters.js";
import type { ActionFeedback } from "../primitives/action-status.js";

/** Raw host request boundary used by the page adapter. */
export type PluginCatalogApi = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export interface PiCatalogPackage {
  name: string;
  description: string;
  version: string;
  publisher: string;
  keywords: string[];
  types: string[];
  links: Record<string, string>;
}

export interface InstalledPiPackage {
  source: string;
  displayName: string;
  version?: string;
  description?: string;
  enabled: boolean;
  resources: { extensions: number; skills: number; prompts: number; themes: number };
}

export interface PiSkillSummary {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  filePath: string;
}

export interface PluginCatalogPage {
  total: number;
  packages: PiCatalogPackage[];
}

/** Typed endpoint client consumed by the plugin controller. */
export interface PluginCatalogClient {
  listInstalledPackages(): Promise<InstalledPiPackage[]>;
  listSkills(): Promise<PiSkillSummary[]>;
  searchCatalog(path: string): Promise<PluginCatalogPage>;
  install(source: string): Promise<void>;
  update(source: string): Promise<void>;
  setEnabled(source: string, enabled: boolean): Promise<void>;
  remove(source: string): Promise<void>;
}

/**
 * Converts raw JSON responses into the endpoint-specific plugin contract.
 * The controller therefore deals only in validated package and skill models.
 */
export function createPluginCatalogClient(request: PluginCatalogApi): PluginCatalogClient {
  return {
    listInstalledPackages: async () => parseEnvelope(await request("/api/v1/management/pi/packages"), parseInstalledPackages),
    listSkills: async () => parseEnvelope(await request("/api/v1/management/pi/skills"), parseSkills),
    searchCatalog: async (path) => parseEnvelope(await request(path), parseCatalogPage),
    install: async (source) => { parseEnvelope(await request("/api/v1/management/pi/packages/install", "POST", { source }), parseSourceMutation); },
    update: async (source) => { parseEnvelope(await request("/api/v1/management/pi/packages/update", "POST", { source }), parseSourceMutation); },
    setEnabled: async (source, enabled) => { parseEnvelope(await request("/api/v1/management/pi/packages/enabled", "PUT", { source, enabled }), parseEnabledMutation); },
    remove: async (source) => { await request("/api/v1/management/pi/packages", "DELETE", { source }); },
  };
}

export interface PluginCatalogElements {
  /** The content column that owns the collapsible sections. */
  pluginsView: HTMLElement;
  /** The page h1; mirrors the active type tab's label. */
  title: HTMLElement;
  /** The Installed section; hidden on the Skills tab. */
  installedSection: HTMLElement;
  /** The Installed skills section; visible only on the Skills tab. */
  skillsSection: HTMLElement;
  pluginSearch: HTMLInputElement;
  installedPlugins: HTMLElement;
  pluginCatalog: HTMLElement;
  installedSkills: HTMLElement;
  loadMorePlugins: HTMLButtonElement;
  refresh: HTMLButtonElement;
  /** Header tabs that filter the catalog by package type (data-type). */
  typeTabs: HTMLButtonElement[];
}

export interface PluginCatalogOptions {
  api: PluginCatalogClient;
  openExternal: (url: string) => void | Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  searchDelayMs?: number;
}

/** "Most downloads" sorts by npm's popularity score (see PiPackageService.catalog). */
const PLUGIN_SORT_OPTIONS: CatalogSortOption[] = [
  { key: "downloads", direction: "desc", label: "Most popular" },
  { key: "updated", direction: "desc", label: "Recently updated" },
  { key: "name", direction: "asc", label: "Name A–Z" },
];

/** Installed-resource key per type tab (package resources are plural). */
const TYPE_RESOURCES: Record<string, keyof InstalledPiPackage["resources"]> = {
  extension: "extensions",
  skill: "skills",
  prompt: "prompts",
};

export class PluginCatalogController {
  readonly elements: PluginCatalogElements;
  private readonly options: PluginCatalogOptions;
  private readonly searchDelayMs: number;
  private readonly filterBar: CatalogFilterBar;
  private installedPackages: InstalledPiPackage[] = [];
  private catalogPackages: PiCatalogPackage[] = [];
  private installedSkills: PiSkillSummary[] = [];
  private catalogTotal = 0;
  private catalogType: string;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private loadGeneration = 0;

  constructor(elements: PluginCatalogElements, options: PluginCatalogOptions) {
    this.elements = elements;
    this.options = options;
    this.searchDelayMs = options.searchDelayMs ?? 250;
    const activeTab = elements.typeTabs.find((tab) => tab.classList.contains("active"));
    this.catalogType = activeTab?.dataset.type ?? "extension";
    if (activeTab) elements.title.textContent = activeTab.textContent?.trim() || elements.title.textContent;
    CollapsibleSection.adoptAll(this.elements.pluginsView, { storageKey: "fitz-collapsed-plugin-sections" });
    this.filterBar = new CatalogFilterBar({
      sortOptions: PLUGIN_SORT_OPTIONS,
      onChange: () => void this.load(false),
    });
    this.elements.pluginsView.insertBefore(this.filterBar.element, this.elements.pluginsView.querySelector(".collapsible-section"));
    this.bind();
  }

  showLoading(): void {
    this.elements.installedPlugins.replaceChildren(emptyState("Loading plugins…"));
  }

  async load(appendCatalog = false): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      if (!appendCatalog) {
        const [packages, skills] = await Promise.all([
          this.options.api.listInstalledPackages(),
          this.options.api.listSkills(),
        ]);
        if (generation !== this.loadGeneration) return;
        this.installedPackages = packages;
        this.installedSkills = skills;
        this.renderInstalledPackages();
        this.renderSkills();
      }
      await this.loadCatalog(appendCatalog, generation);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      const message = this.options.errorMessage(error);
      if (!appendCatalog) {
        this.elements.installedPlugins.replaceChildren(emptyState(message));
        this.elements.pluginCatalog.replaceChildren();
      }
      this.options.showStatus(message, "error");
    }
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.load(false));
    for (const tab of this.elements.typeTabs) {
      tab.addEventListener("click", () => {
        this.catalogType = tab.dataset.type ?? "extension";
        this.elements.title.textContent = tab.textContent?.trim() || this.elements.title.textContent;
        void this.load(false);
      });
    }
    this.elements.pluginSearch.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.load(false), this.searchDelayMs);
    });
    this.elements.loadMorePlugins.addEventListener("click", () => void this.load(true));
  }

  private async loadCatalog(append: boolean, generation: number): Promise<void> {
    const offset = append ? this.catalogPackages.length : 0;
    const query = encodeURIComponent(this.elements.pluginSearch.value.trim());
    // The active header tab's type is pushed into the npm query so the page
    // fills with matching packages instead of a blank client-side filter.
    const typeParam = this.catalogType ? `&type=${encodeURIComponent(this.catalogType)}` : "";
    const response = await this.options.api.searchCatalog(`/api/v1/management/pi/catalog?query=${query}&offset=${offset}&limit=30&${catalogQueryString(this.filterBar.filters)}${typeParam}`);
    if (generation !== this.loadGeneration) return;
    this.catalogTotal = response.total;
    this.catalogPackages = append ? [...this.catalogPackages, ...response.packages] : response.packages;
    this.renderCatalog();
  }

  private renderInstalledPackages(): void {
    const type = this.catalogType;
    // Each type tab owns its installed section: the Skills tab swaps in the
    // skills list, the other tabs show installed packages of that type.
    const isSkillTab = type === "skill";
    this.elements.installedSection.hidden = isSkillTab;
    this.elements.skillsSection.hidden = !isSkillTab;
    this.elements.installedPlugins.replaceChildren();
    const resourceKey = TYPE_RESOURCES[type];
    const visible = this.installedPackages.filter((entry) => resourceKey !== undefined && (entry.resources[resourceKey] ?? 0) > 0);
    if (!visible.length) {
      this.elements.installedPlugins.append(emptyState(`No ${type}s installed`));
      return;
    }
    for (const entry of visible) {
      const card = this.packageCard(entry.displayName, entry.description ?? entry.source, entry.version, sourceWebsite(entry.source));
      const counts = Object.entries(entry.resources).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`);
      if (counts.length) card.querySelector(".plugin-meta")?.append(document.createTextNode(` · ${counts.join(" · ")}`));
      const actions = card.querySelector(".plugin-actions") as HTMLElement;
      actions.append(
        this.action(entry.enabled ? "Disable" : "Enable", () => this.mutate(() => this.options.api.setEnabled(entry.source, !entry.enabled))),
        this.action("Update", () => this.mutate(() => this.options.api.update(entry.source))),
        this.action("Remove", () => this.mutate(() => this.options.api.remove(entry.source)), true),
      );
      this.elements.installedPlugins.append(card);
    }
  }

  private renderCatalog(): void {
    this.elements.pluginCatalog.replaceChildren();
    const installed = new Set(this.installedPackages.map((entry) => packageNameFromSource(entry.source)).filter((name): name is string => Boolean(name)));
    const visible = this.catalogPackages.filter((entry) => !installed.has(entry.name));
    if (!visible.length) this.elements.pluginCatalog.append(emptyState("No matching Pi packages"));
    for (const entry of visible) {
      const card = this.packageCard(entry.name, entry.description, entry.version, entry.links.homepage ?? entry.links.repository ?? entry.links.npm ?? npmPackageWebsite(entry.name));
      card.querySelector(".plugin-actions")?.append(this.installAction(entry.name));
      this.elements.pluginCatalog.append(card);
    }
    this.elements.loadMorePlugins.hidden = this.catalogPackages.length >= this.catalogTotal;
  }

  private renderSkills(): void {
    this.elements.installedSkills.replaceChildren();
    if (!this.installedSkills.length) {
      this.elements.installedSkills.append(emptyState("No skills installed"));
      return;
    }
    for (const skill of this.installedSkills) {
      const card = this.packageCard(skill.name, skill.description || skill.source, undefined, sourceWebsite(skill.source));
      card.classList.add("skill-card");
      const actions = card.querySelector(".plugin-actions") as HTMLElement;
      const mark = document.createElement("span");
      mark.className = "plugin-installed-mark";
      mark.textContent = skill.enabled ? "✓" : "Disabled";
      actions.append(mark);
      this.elements.installedSkills.append(card);
    }
  }

  private packageCard(name: string, description: string, version?: string, website?: string): HTMLElement {
    const card = document.createElement("article");
    card.className = "plugin-card";
    if (website) {
      card.classList.add("plugin-card-linked");
      card.tabIndex = 0;
      card.setAttribute("role", "link");
      card.title = "Open plugin website";
      card.addEventListener("click", (event) => {
        if (!(event.target as HTMLElement).closest(".plugin-actions")) void this.openWebsite(website);
      });
      card.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest(".plugin-actions")) {
          event.preventDefault();
          void this.openWebsite(website);
        }
      });
    }
    const icon = document.createElement("span");
    icon.className = "plugin-icon";
    icon.append(svgIcon('<path d="M10 2.8c.5 3.7 2.4 5.8 6.2 7.2-3.8 1.4-5.7 3.5-6.2 7.2-.5-3.7-2.4-5.8-6.2-7.2C7.6 8.6 9.5 6.5 10 2.8Z"></path>'));
    const copy = document.createElement("div");
    copy.className = "plugin-copy";
    const heading = document.createElement("strong");
    heading.textContent = name;
    const meta = document.createElement("span");
    meta.className = "plugin-meta";
    meta.textContent = `${description}${version ? ` · ${version}` : ""}`;
    copy.append(heading, meta);
    const actions = document.createElement("div");
    actions.className = "plugin-actions";
    card.append(icon, copy, actions);
    return card;
  }

  private async openWebsite(website: string): Promise<void> {
    try { await this.options.openExternal(website); }
    catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private action(label: string, action: () => Promise<void>, danger = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = danger ? "plugin-action danger" : "plugin-action";
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      const old = button.textContent;
      button.textContent = "Working…";
      try { await action(); }
      finally { button.disabled = false; button.textContent = old; }
    });
    return button;
  }

  private installAction(name: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "plugin-action";
    button.textContent = "Install";
    button.title = "Pi packages can run code with the same access as Fitz";
    button.addEventListener("click", async () => {
      if (button.dataset.confirm !== "true") {
        button.dataset.confirm = "true";
        button.textContent = "Install?";
        return;
      }
      button.disabled = true;
      button.textContent = "Installing…";
      try { await this.mutate(() => this.options.api.install(`npm:${name}`)); }
      finally { button.disabled = false; button.dataset.confirm = "false"; button.textContent = "Install"; }
    });
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) { button.dataset.confirm = "false"; button.textContent = "Install"; }
    });
    return button;
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      await this.load(false);
      this.options.showStatus("Plugin configuration updated", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }
}

function parseEnvelope<T>(value: unknown, parse: (value: unknown) => T): T {
  if (!isRecord(value) || !("data" in value)) throw invalidResponse("missing data envelope");
  return parse(value.data);
}

function parseCatalogPage(value: unknown): PluginCatalogPage {
  if (!isRecord(value) || !isFiniteNumber(value.total) || !Array.isArray(value.packages)) {
    throw invalidResponse("catalog page is invalid");
  }
  return { total: value.total, packages: value.packages.map(parseCatalogPackage) };
}

function parseCatalogPackage(value: unknown): PiCatalogPackage {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.description !== "string" || typeof value.version !== "string") {
    throw invalidResponse("catalog package is invalid");
  }
  return {
    name: value.name,
    description: value.description,
    version: value.version,
    publisher: typeof value.publisher === "string" ? value.publisher : "npm",
    keywords: stringArray(value.keywords),
    types: stringArray(value.types),
    links: stringMap(value.links),
  };
}

function parseInstalledPackages(value: unknown): InstalledPiPackage[] {
  if (!Array.isArray(value)) throw invalidResponse("installed packages are invalid");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.source !== "string" || typeof entry.displayName !== "string" || typeof entry.enabled !== "boolean") {
      throw invalidResponse("installed package is invalid");
    }
    return {
      source: entry.source,
      displayName: entry.displayName,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      enabled: entry.enabled,
      resources: resourceCounts(entry.resources),
    };
  });
}

function parseSkills(value: unknown): PiSkillSummary[] {
  if (!Array.isArray(value)) throw invalidResponse("skills are invalid");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.description !== "string"
      || typeof entry.source !== "string" || typeof entry.enabled !== "boolean" || typeof entry.filePath !== "string") {
      throw invalidResponse("skill is invalid");
    }
    return { name: entry.name, description: entry.description, source: entry.source, enabled: entry.enabled, filePath: entry.filePath };
  });
}

function parseSourceMutation(value: unknown): { source: string } {
  if (!isRecord(value) || typeof value.source !== "string") throw invalidResponse("package mutation is invalid");
  return { source: value.source };
}

function parseEnabledMutation(value: unknown): { source: string; enabled: boolean } {
  if (!isRecord(value) || typeof value.source !== "string" || typeof value.enabled !== "boolean") {
    throw invalidResponse("enabled mutation is invalid");
  }
  return { source: value.source, enabled: value.enabled };
}

function resourceCounts(value: unknown): InstalledPiPackage["resources"] {
  const record = isRecord(value) ? value : {};
  return {
    extensions: nonNegativeCount(record.extensions),
    skills: nonNegativeCount(record.skills),
    prompts: nonNegativeCount(record.prompts),
    themes: nonNegativeCount(record.themes),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function nonNegativeCount(value: unknown): number {
  return isFiniteNumber(value) && value >= 0 ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(detail: string): TypeError {
  return new TypeError(`The plugin catalog returned an invalid response: ${detail}`);
}

function emptyState(message: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "panel-empty";
  element.textContent = message;
  return element;
}

function sourceWebsite(source: string): string | undefined {
  const name = packageNameFromSource(source);
  return name ? npmPackageWebsite(name) : undefined;
}

function packageNameFromSource(source: string): string | undefined {
  return source.startsWith("npm:") ? source.slice(4).replace(/@[^@/]+$/, "") : undefined;
}

function npmPackageWebsite(name: string): string {
  return `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
}
