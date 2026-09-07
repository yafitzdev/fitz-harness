// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCatalogClient, PluginCatalogController, type PluginCatalogApi, type PluginCatalogElements } from "./plugin-catalog.js";

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

function typeTab(id: string, label: string, type: string, active = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.textContent = label;
  button.dataset.type = type;
  button.classList.toggle("active", active);
  return button;
}

function setup(api: PluginCatalogApi, searchDelayMs = 250) {
  const installed = section("installed", "installed-plugins-toggle", "installed-plugins-body");
  const skills = section("skills", "installed-skills-toggle", "installed-skills-body");
  const catalog = section("discover", "plugin-catalog-toggle", "plugin-catalog-body");
  const custom = section("custom", "custom-tools-toggle", "custom-tools-body");
  const pluginsView = node("section");
  const title = document.createElement("h1");
  title.textContent = "Extensions";
  pluginsView.prepend(title, installed.section, skills.section, catalog.section, custom.section);
  const installedPlugins = document.createElement("div"); installedPlugins.id = "installed-plugins"; installedPlugins.className = "plugin-grid";
  const pluginCatalog = document.createElement("div"); pluginCatalog.id = "plugin-catalog"; pluginCatalog.className = "plugin-grid";
  const installedSkills = document.createElement("div"); installedSkills.id = "installed-skills"; installedSkills.className = "plugin-grid";
  const customTools = document.createElement("div"); customTools.id = "custom-tools"; customTools.className = "plugin-grid";
  const loadMorePlugins = document.createElement("button"); loadMorePlugins.id = "load-more-plugins"; loadMorePlugins.hidden = true;
  installed.region.append(installedPlugins);
  skills.region.append(installedSkills);
  catalog.region.append(pluginCatalog, loadMorePlugins);
  custom.region.append(customTools);
  const typeTabs = [
    typeTab("extension-tab", "Extensions", "extension", true),
    typeTab("skill-tab", "Skills", "skill"),
    typeTab("prompt-tab", "Prompts", "prompt"),
    typeTab("custom-tab", "Custom", "custom"),
  ];
  const elements: PluginCatalogElements = {
    pluginsView,
    title,
    installedSection: installed.section,
    skillsSection: skills.section,
    discoverSection: catalog.section,
    customSection: custom.section,
    customTools,
    pluginSearch: node("input"),
    installedPlugins, pluginCatalog, installedSkills, loadMorePlugins, refresh: node("button"),
    typeTabs,
  };
  const calls = { openExternal: vi.fn(), showStatus: vi.fn(), errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)) };
  const controller = new PluginCatalogController(elements, { api: createPluginCatalogClient(api), ...calls, searchDelayMs });
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
  it("rejects malformed catalog envelopes at the typed API boundary", async () => {
    const client = createPluginCatalogClient(async () => ({ data: { packages: [] } }));
    await expect(client.searchCatalog("/api/v1/management/pi/catalog")).rejects.toThrow("catalog page is invalid");
  });

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

  it("reports a rejected website bridge call without leaking it", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      return { data: { total: 1, packages: [{ name: "pi-extra", description: "Extra", version: "2.0.0", links: {} }] } };
    });
    const { controller, elements, calls } = setup(api);
    calls.openExternal.mockRejectedValueOnce(new Error("Browser unavailable"));
    await controller.load();

    click(elements.pluginCatalog.querySelector(".plugin-card-linked")!);

    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Browser unavailable", "error"));
  });

  it("requires confirmation before installing and refreshes the shared package state", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [] };
      if (path === "/api/v1/management/pi/skills") return { data: [] };
      if (path.includes("/catalog?")) return { data: { total: 1, packages: [{ name: "pi-extra", description: "Extra", version: "2.0.0", links: {} }] } };
      return { data: { source: "npm:pi-extra" } };
    });
    const { controller, elements, calls } = setup(api);
    await controller.load();
    const install = elements.pluginCatalog.querySelector<HTMLButtonElement>(".plugin-action")!;

    click(install);
    expect(install.textContent).toBe("Install?");
    expect(api).not.toHaveBeenCalledWith("/api/v1/management/pi/packages/install", "POST", expect.anything());

    click(install);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/pi/packages/install", "POST", { source: "npm:pi-extra" }));
    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Plugin configuration updated", "success"));
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
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=pi%20tools&offset=0&limit=30&sort=downloads&direction=desc&type=extension");

    click(elements.loadMorePlugins);
    await settle();
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=pi%20tools&offset=1&limit=30&sort=downloads&direction=desc&type=extension");
    expect(elements.pluginCatalog.querySelectorAll(".plugin-card")).toHaveLength(2);
    expect(elements.loadMorePlugins.hidden).toBe(true);
  });

  it("does not let a slow stale search replace newer catalog results", async () => {
    let resolveOld: ((value: Record<string, any>) => void) | undefined;
    const oldResponse = new Promise<Record<string, any>>((resolve) => { resolveOld = resolve; });
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      if (path.includes("query=old")) return oldResponse;
      if (path.includes("query=new")) return { data: { total: 1, packages: [{ name: "new-result", description: "New", version: "1", links: {} }] } };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, elements } = setup(api);
    elements.pluginSearch.value = "old";
    const oldLoad = controller.load();
    await settle();
    elements.pluginSearch.value = "new";

    await controller.load();
    resolveOld?.({ data: { total: 1, packages: [{ name: "old-result", description: "Old", version: "1", links: {} }] } });
    await oldLoad;

    expect(elements.pluginCatalog.textContent).toContain("new-result");
    expect(elements.pluginCatalog.textContent).not.toContain("old-result");
  });

  it("contains a rejected catalog pagination request", async () => {
    let page = 0;
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      if (page++ === 0) return { data: { total: 2, packages: [{ name: "one", description: "One", version: "1", links: {} }] } };
      throw new Error("Catalog unavailable");
    });
    const { controller, elements, calls } = setup(api);
    await controller.load();

    click(elements.loadMorePlugins);

    await vi.waitFor(() => expect(calls.showStatus).toHaveBeenCalledWith("Catalog unavailable", "error"));
    expect(elements.pluginCatalog.textContent).toContain("one");
  });

  it("renders all installed skills without a second search control", async () => {
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

    // The skills section only appears on the Skill tab.
    expect(elements.skillsSection.hidden).toBe(true);
    click(elements.typeTabs.find((tab) => tab.dataset.type === "skill")!);
    await vi.waitFor(() => expect(elements.skillsSection.hidden).toBe(false));

    expect(elements.installedSkills.querySelectorAll(".plugin-card")).toHaveLength(2);
    expect(elements.skillsSection.querySelector(".management-search")).toBeNull();
    expect(elements.installedSkills.textContent).toContain("Review");
    expect(elements.installedSkills.textContent).toContain("Docs");
    expect(elements.installedSkills.textContent).toContain("Disabled");
  });

  it("shows per-type installed sections on each tab", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [
        { source: "npm:pi-ext@1.0.0", displayName: "Ext", version: "1.0.0", enabled: true, resources: { extensions: 1, skills: 0, prompts: 0, themes: 0 } },
        { source: "npm:pi-prompt@1.0.0", displayName: "Prompt", version: "1.0.0", enabled: true, resources: { extensions: 0, skills: 0, prompts: 1, themes: 0 } },
      ] };
      if (path === "/api/v1/management/pi/skills") return { data: [] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, elements } = setup(api);
    await controller.load();

    // The default Extensions tab shows only extension packages.
    expect(elements.installedSection.hidden).toBe(false);
    expect(elements.skillsSection.hidden).toBe(true);
    expect(elements.installedPlugins.querySelectorAll(".plugin-card")).toHaveLength(1);
    expect(elements.installedPlugins.textContent).toContain("Ext");
    expect(elements.installedPlugins.textContent).not.toContain("Prompt");

    // The Skills tab swaps in the skills section.
    click(elements.typeTabs.find((tab) => tab.dataset.type === "skill")!);
    await vi.waitFor(() => expect(elements.installedSection.hidden).toBe(true));
    expect(elements.skillsSection.hidden).toBe(false);

    // The Prompts tab filters the installed section again.
    click(elements.typeTabs.find((tab) => tab.dataset.type === "prompt")!);
    await vi.waitFor(() => expect(elements.installedPlugins.textContent).toContain("Prompt"));
    expect(elements.installedSection.hidden).toBe(false);
    expect(elements.skillsSection.hidden).toBe(true);
    expect(elements.installedPlugins.textContent).not.toContain("Ext");
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

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=&offset=0&limit=30&sort=updated&direction=desc&type=extension"));
  });

  it("re-queries the catalog when a type tab is clicked", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      return { data: { total: 2, packages: [
        { name: "pi-extension", description: "Ext", version: "1.0.0", keywords: ["pi-package", "pi-extension"], types: ["extension"], links: {} },
        { name: "pi-skill", description: "Skill", version: "1.0.0", keywords: ["pi-package", "skill"], types: ["skill"], links: {} },
      ] } };
    });
    const { controller, elements } = setup(api);
    await controller.load();
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=&offset=0&limit=30&sort=downloads&direction=desc&type=extension");
    expect(elements.title.textContent).toBe("Extensions");

    // The active type tab's value is pushed into the npm query so the first
    // page is not a blank client-side filter of extension-heavy pages.
    click(elements.typeTabs.find((tab) => tab.dataset.type === "skill")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=&offset=0&limit=30&sort=downloads&direction=desc&type=skill"));
    // The page title mirrors the active type tab.
    expect(elements.title.textContent).toBe("Skills");
    // The render shows exactly what the server returned for the active type.
    expect(elements.pluginCatalog.querySelectorAll(".plugin-card")).toHaveLength(2);
  });

  it("shows the read-only Custom tab with the host's built-in tools", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      if (path === "/api/v1/management/pi/custom-tools") return { data: [
        { name: "fitz_trash", label: "Move to trash", description: "Recoverable deletes" },
        { name: "lsp", label: "Language server", description: "Read-only editor queries" },
      ] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, elements, calls } = setup(api);
    await controller.load();

    // Package views are the default; the Custom section starts hidden.
    expect(elements.customSection.hidden).toBe(true);
    expect(elements.discoverSection.hidden).toBe(false);

    click(elements.typeTabs.find((tab) => tab.dataset.type === "custom")!);
    await vi.waitFor(() => expect(elements.customTools.textContent).toContain("fitz_trash"));
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/custom-tools");
    expect(elements.title.textContent).toBe("Custom");
    expect(elements.customSection.hidden).toBe(false);
    expect(elements.installedSection.hidden).toBe(true);
    expect(elements.skillsSection.hidden).toBe(true);
    expect(elements.discoverSection.hidden).toBe(true);
    expect(elements.customTools.querySelectorAll(".plugin-card")).toHaveLength(2);
    expect(elements.customTools.textContent).toContain("fitz_trash");
    expect(elements.customTools.textContent).toContain("lsp");
    expect(elements.customTools.textContent).toContain("Move to trash");
    // Built-in tools are read-only: no install/remove actions, no status toast.
    expect(elements.customTools.querySelector(".plugin-action")).toBeNull();
    expect(calls.showStatus).not.toHaveBeenCalled();

    // Returning to a package tab hides the Custom section again.
    click(elements.typeTabs.find((tab) => tab.dataset.type === "extension")!);
    await vi.waitFor(() => expect(elements.customSection.hidden).toBe(true));
    expect(elements.discoverSection.hidden).toBe(false);
    expect(elements.installedSection.hidden).toBe(false);
  });

  it("shows an empty state on the Custom tab when no tools are registered", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/custom-tools") return { data: [] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, elements } = setup(api);
    await controller.load();
    click(elements.typeTabs.find((tab) => tab.dataset.type === "custom")!);
    await vi.waitFor(() => expect(elements.customTools.textContent).toContain("No custom tools registered"));
  });
});
