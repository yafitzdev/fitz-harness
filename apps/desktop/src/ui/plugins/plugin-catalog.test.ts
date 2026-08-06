// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginCatalogController, type PluginCatalogApi, type PluginCatalogElements } from "./plugin-catalog.js";

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function section(key: string, toggleId: string, regionId: string): { section: HTMLElement; toggle: HTMLButtonElement; region: HTMLElement } {
  const section = document.createElement("section");
  section.className = "collapsible-section";
  const heading = document.createElement("div");
  heading.className = "collapsible-heading";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "collapsible-toggle";
  toggle.id = toggleId;
  toggle.dataset.collapsibleKey = key;
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-controls", regionId);
  toggle.append(Object.assign(document.createElement("h2"), { textContent: key }));
  heading.append(toggle);
  const region = document.createElement("div");
  region.className = "collapsible-body";
  region.id = regionId;
  section.append(heading, region);
  document.body.append(section);
  return { section, toggle, region };
}

function setup(api: PluginCatalogApi, searchDelayMs = 250) {
  const installed = section("installed", "installed-plugins-toggle", "installed-plugins-body");
  const catalog = section("discover", "plugin-catalog-toggle", "plugin-catalog-body");
  const pluginsView = node("section");
  pluginsView.append(installed.section, catalog.section);
  const installedPlugins = document.createElement("div"); installedPlugins.id = "installed-plugins"; installedPlugins.className = "plugin-grid";
  const pluginCatalog = document.createElement("div"); pluginCatalog.id = "plugin-catalog"; pluginCatalog.className = "plugin-grid";
  const loadMorePlugins = document.createElement("button"); loadMorePlugins.id = "load-more-plugins"; loadMorePlugins.hidden = true;
  installed.region.append(installedPlugins);
  catalog.region.append(pluginCatalog, loadMorePlugins);
  const elements: PluginCatalogElements = {
    pluginsView, skillsView: node("section"), pluginsTab: node("button"), skillsTab: node("button"),
    pluginSearch: node("input"), skillSearch: node("input"), installedPlugins, pluginCatalog, installedSkills: node("div"),
    loadMorePlugins, refresh: node("button"),
  };
  elements.skillsView.hidden = true;
  const calls = { openExternal: vi.fn(), showToast: vi.fn(), errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)) };
  const controller = new PluginCatalogController(elements, { api, ...calls, searchDelayMs });
  return { controller, elements, calls };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  } as Storage;
}

beforeEach(() => {
  // happy-dom ships an empty localStorage stub without working methods; install a real one.
  globalThis.localStorage = memoryStorage();
  document.body.replaceChildren();
});
afterEach(() => vi.useRealTimers());

describe("PluginCatalogController", () => {
  it("loads installed packages, catalog entries, skills, and opens package websites", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [{ source: "npm:pi-tools@1.0.0", displayName: "Pi Tools", version: "1.0.0", enabled: true, resources: { extensions: 1 } }] };
      if (path === "/api/v1/management/pi/skills") return { data: [{ name: "Review", description: "Review code", source: "npm:pi-tools@1.0.0", enabled: true, filePath: "SKILL.md" }] };
      return { data: { total: 2, packages: [
        { name: "pi-tools", description: "Toolbox", version: "1.0.0", links: { homepage: "https://example.com/pi-tools" } },
        { name: "pi-extra", description: "Extra", version: "2.0.0", links: {} },
      ] } };
    });
    const { controller, elements, calls } = setup(api);

    await controller.load();

    expect(elements.installedPlugins.querySelector("strong")?.textContent).toBe("Pi Tools");
    expect(elements.installedPlugins.querySelector(".plugin-meta")?.textContent).toContain("1 extensions");
    // Installed packages stay out of the Discover catalog.
    expect(elements.pluginCatalog.querySelectorAll(".plugin-card")).toHaveLength(1);
    expect(elements.pluginCatalog.textContent).toContain("pi-extra");
    expect(elements.pluginCatalog.textContent).not.toContain("pi-tools");
    expect(elements.installedSkills.textContent).toContain("Review");
    click(elements.pluginCatalog.querySelector(".plugin-card-linked")!);
    expect(calls.openExternal).toHaveBeenCalledWith("https://www.npmjs.com/package/pi-extra");
  });

  it("requires confirmation before installing and refreshes the shared package state", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [] };
      if (path === "/api/v1/management/pi/skills") return { data: [] };
      if (path.includes("/catalog?")) return { data: { total: 1, packages: [{ name: "pi-extra", description: "Extra", version: "2.0.0", links: {} }] } };
      return { data: {} };
    });
    const { controller, elements, calls } = setup(api);
    await controller.load();
    const install = elements.pluginCatalog.querySelector<HTMLButtonElement>(".plugin-action")!;

    click(install);
    expect(install.textContent).toBe("Install?");
    expect(api).not.toHaveBeenCalledWith("/api/v1/management/pi/packages/install", "POST", expect.anything());

    click(install);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/pi/packages/install", "POST", { source: "npm:pi-extra" }));
    await vi.waitFor(() => expect(calls.showToast).toHaveBeenCalledWith("Plugin configuration updated"));
  });

  it("debounces catalog search and appends the next catalog page", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      if (path.includes("offset=0")) return { data: { total: 2, packages: [{ name: "one", description: "One", version: "1", links: {} }] } };
      return { data: { total: 2, packages: [{ name: "two", description: "Two", version: "1", links: {} }] } };
    });
    const { controller, elements } = setup(api, 25);
    await controller.load();
    elements.pluginSearch.value = "pi tools";
    elements.pluginSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(25);
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=pi%20tools&offset=0&limit=30&sort=downloads&direction=desc");

    click(elements.loadMorePlugins);
    await settle();
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=pi%20tools&offset=1&limit=30&sort=downloads&direction=desc");
    expect(elements.pluginCatalog.querySelectorAll(".plugin-card")).toHaveLength(2);
  });

  it("owns Plugins and Skills tab state and skill filtering", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [] };
      if (path === "/api/v1/management/pi/skills") return { data: [
        { name: "Review", description: "Review code", source: "npm:review", enabled: true, filePath: "review.md" },
        { name: "Docs", description: "Read docs", source: "npm:docs", enabled: false, filePath: "docs.md" },
      ] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, elements } = setup(api);
    await controller.load();

    click(elements.skillsTab);
    expect(elements.pluginsView.hidden).toBe(true);
    expect(elements.skillsView.hidden).toBe(false);
    expect(elements.skillsTab.classList.contains("active")).toBe(true);

    elements.skillSearch.value = "docs";
    elements.skillSearch.dispatchEvent(new Event("input", { bubbles: true }));
    expect(elements.installedSkills.querySelectorAll(".plugin-card")).toHaveLength(1);
    expect(elements.installedSkills.textContent).toContain("Docs");
    expect(elements.installedSkills.textContent).toContain("Disabled");
  });

  it("collapses and expands the Installed and Discover sections from their toggles", () => {
    const { elements } = setup(vi.fn(async () => ({ data: {} })));
    const installedToggle = elements.pluginsView.querySelector<HTMLButtonElement>("#installed-plugins-toggle")!;
    const catalogToggle = elements.pluginsView.querySelector<HTMLButtonElement>("#plugin-catalog-toggle")!;

    expect(installedToggle.getAttribute("aria-expanded")).toBe("true");
    click(installedToggle);
    expect(installedToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(true);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("false");
    click(installedToggle);
    expect(installedToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(false);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("true");

    click(catalogToggle);
    expect(catalogToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(true);
    expect(catalogToggle.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-plugin-sections") ?? "[]")).toEqual(["discover"]);
  });

  it("restores previously collapsed sections from storage on construction", () => {
    localStorage.setItem("fitz-collapsed-plugin-sections", '["discover"]');
    const { elements } = setup(vi.fn(async () => ({ data: {} })));
    const installedToggle = elements.pluginsView.querySelector<HTMLButtonElement>("#installed-plugins-toggle")!;
    const catalogToggle = elements.pluginsView.querySelector<HTMLButtonElement>("#plugin-catalog-toggle")!;

    expect(installedToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(false);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(catalogToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(true);
    expect(catalogToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("re-queries the catalog with the shared sort when the filter bar changes", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, elements } = setup(api);
    await controller.load();

    const select = elements.pluginsView.querySelector<HTMLSelectElement>(".catalog-filter-select")!;
    select.value = "updated:desc";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=&offset=0&limit=30&sort=updated&direction=desc"));
  });

  it("filters the catalog rows by the selected type facets", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      return { data: { total: 3, packages: [
        { name: "pi-extension", description: "Ext", version: "1.0.0", keywords: ["pi-package", "pi-extension"], types: ["extension"], links: {} },
        { name: "pi-skill", description: "Skill", version: "1.0.0", keywords: ["pi-package", "skill"], types: ["skill"], links: {} },
        { name: "pi-both", description: "Both", version: "1.0.0", keywords: ["pi-package", "pi-extension", "skill"], types: ["extension", "skill"], links: {} },
      ] } };
    });
    const { controller, elements } = setup(api);
    await controller.load();

    const chip = elements.pluginsView.querySelector<HTMLButtonElement>('[data-facet="skill"]')!;
    click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    await vi.waitFor(() => expect(elements.pluginCatalog.querySelectorAll(".plugin-card")).toHaveLength(2));
    expect(elements.pluginCatalog.textContent).toContain("pi-skill");
    expect(elements.pluginCatalog.textContent).toContain("pi-both");
    expect(elements.pluginCatalog.textContent).not.toContain("pi-extension");
  });
});
