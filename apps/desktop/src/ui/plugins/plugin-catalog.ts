import { svgIcon } from "../primitives/dom.js";
import { CollapsibleSection } from "../layout/collapsible-section.js";

export type PluginCatalogApi = (path: string, method?: string, body?: unknown) => Promise<Record<string, any>>;

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
  resources: Record<string, number>;
}

export interface PiSkillSummary {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  filePath: string;
}

export interface PluginCatalogElements {
  pluginsView: HTMLElement;
  skillsView: HTMLElement;
  pluginsTab: HTMLButtonElement;
  skillsTab: HTMLButtonElement;
  pluginSearch: HTMLInputElement;
  skillSearch: HTMLInputElement;
  installedPlugins: HTMLElement;
  pluginCatalog: HTMLElement;
  installedSkills: HTMLElement;
  loadMorePlugins: HTMLButtonElement;
  refresh: HTMLButtonElement;
}

export interface PluginCatalogOptions {
  api: PluginCatalogApi;
  openExternal: (url: string) => void | Promise<void>;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
  searchDelayMs?: number;
}

export class PluginCatalogController {
  readonly elements: PluginCatalogElements;
  private readonly options: PluginCatalogOptions;
  private readonly searchDelayMs: number;
  private installedPackages: InstalledPiPackage[] = [];
  private catalogPackages: PiCatalogPackage[] = [];
  private installedSkills: PiSkillSummary[] = [];
  private catalogTotal = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(elements: PluginCatalogElements, options: PluginCatalogOptions) {
    this.elements = elements;
    this.options = options;
    this.searchDelayMs = options.searchDelayMs ?? 250;
    CollapsibleSection.adoptAll(this.elements.pluginsView, { storageKey: "fitz-collapsed-plugin-sections" });
    this.bind();
  }

  showLoading(): void {
    this.elements.installedPlugins.replaceChildren(emptyState("Loading plugins…"));
  }

  setView(view: "plugins" | "skills"): void {
    const showPlugins = view === "plugins";
    this.elements.pluginsView.hidden = !showPlugins;
    this.elements.skillsView.hidden = showPlugins;
    this.elements.pluginsTab.classList.toggle("active", showPlugins);
    this.elements.skillsTab.classList.toggle("active", !showPlugins);
    if (!showPlugins) this.renderSkills();
  }

  async load(appendCatalog = false): Promise<void> {
    try {
      if (!appendCatalog) {
        const [packages, skills] = await Promise.all([
          this.options.api("/api/v1/management/pi/packages"),
          this.options.api("/api/v1/management/pi/skills"),
        ]);
        this.installedPackages = packages.data ?? [];
        this.installedSkills = skills.data ?? [];
        this.renderInstalledPackages();
        this.renderSkills();
      }
      await this.loadCatalog(appendCatalog);
    } catch (error) {
      const message = this.options.errorMessage(error);
      this.elements.installedPlugins.replaceChildren(emptyState(message));
      this.elements.pluginCatalog.replaceChildren();
      this.options.showToast(message);
    }
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.load(false));
    this.elements.pluginsTab.addEventListener("click", () => this.setView("plugins"));
    this.elements.skillsTab.addEventListener("click", () => this.setView("skills"));
    this.elements.pluginSearch.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.load(false), this.searchDelayMs);
    });
    this.elements.skillSearch.addEventListener("input", () => this.renderSkills());
    this.elements.loadMorePlugins.addEventListener("click", () => void this.loadCatalog(true));
  }

  private async loadCatalog(append: boolean): Promise<void> {
    const offset = append ? this.catalogPackages.length : 0;
    const query = encodeURIComponent(this.elements.pluginSearch.value.trim());
    const response = await this.options.api(`/api/v1/management/pi/catalog?query=${query}&offset=${offset}&limit=30`);
    this.catalogTotal = response.data?.total ?? 0;
    this.catalogPackages = append ? [...this.catalogPackages, ...(response.data?.packages ?? [])] : (response.data?.packages ?? []);
    this.renderCatalog();
  }

  private renderInstalledPackages(): void {
    this.elements.installedPlugins.replaceChildren();
    if (!this.installedPackages.length) {
      this.elements.installedPlugins.append(emptyState("No plugins installed"));
      return;
    }
    for (const entry of this.installedPackages) {
      const card = this.packageCard(entry.displayName, entry.description ?? entry.source, entry.version, sourceWebsite(entry.source));
      const counts = Object.entries(entry.resources).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`);
      if (counts.length) card.querySelector(".plugin-meta")?.append(document.createTextNode(` · ${counts.join(" · ")}`));
      const actions = card.querySelector(".plugin-actions") as HTMLElement;
      actions.append(
        this.action(entry.enabled ? "Disable" : "Enable", () => this.mutate("PUT", "/api/v1/management/pi/packages/enabled", { source: entry.source, enabled: !entry.enabled })),
        this.action("Update", () => this.mutate("POST", "/api/v1/management/pi/packages/update", { source: entry.source })),
        this.action("Remove", () => this.mutate("DELETE", "/api/v1/management/pi/packages", { source: entry.source }), true),
      );
      this.elements.installedPlugins.append(card);
    }
  }

  private renderCatalog(): void {
    this.elements.pluginCatalog.replaceChildren();
    const installed = new Set(this.installedPackages.map((entry) => packageNameFromSource(entry.source)).filter((name): name is string => Boolean(name)));
    if (!this.catalogPackages.length) this.elements.pluginCatalog.append(emptyState("No matching Pi packages"));
    for (const entry of this.catalogPackages) {
      const card = this.packageCard(entry.name, entry.description, entry.version, entry.links.homepage ?? entry.links.repository ?? entry.links.npm ?? npmPackageWebsite(entry.name));
      const actions = card.querySelector(".plugin-actions") as HTMLElement;
      if (installed.has(entry.name)) {
        const mark = document.createElement("span");
        mark.className = "plugin-installed-mark";
        mark.textContent = "✓ Installed";
        actions.append(mark);
      } else actions.append(this.installAction(entry.name));
      this.elements.pluginCatalog.append(card);
    }
    this.elements.loadMorePlugins.hidden = this.catalogPackages.length >= this.catalogTotal;
  }

  private renderSkills(): void {
    this.elements.installedSkills.replaceChildren();
    const query = this.elements.skillSearch.value.trim().toLowerCase();
    const visible = this.installedSkills.filter((skill) => !query || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query));
    if (!visible.length) {
      this.elements.installedSkills.append(emptyState("No matching skills"));
      return;
    }
    for (const skill of visible) {
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
        if (!(event.target as HTMLElement).closest(".plugin-actions")) void this.options.openExternal(website);
      });
      card.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest(".plugin-actions")) {
          event.preventDefault();
          void this.options.openExternal(website);
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
      try { await this.mutate("POST", "/api/v1/management/pi/packages/install", { source: `npm:${name}` }); }
      finally { button.disabled = false; button.dataset.confirm = "false"; button.textContent = "Install"; }
    });
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) { button.dataset.confirm = "false"; button.textContent = "Install"; }
    });
    return button;
  }

  private async mutate(method: string, path: string, body: unknown): Promise<void> {
    try {
      await this.options.api(path, method, body);
      await this.load(false);
      this.options.showToast("Plugin configuration updated");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }
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
