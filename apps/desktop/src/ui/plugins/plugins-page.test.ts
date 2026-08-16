// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementPageLayout, managementRefreshIcon } from "../layout/management-page.js";
import { PluginsPageController, type PluginsPageOptions } from "./plugins-page.js";

function buildPage(): HTMLElement {
  const page = document.createElement("section");
  page.id = "plugins-page";
  page.className = "management-page";
  const layout = new ManagementPageLayout(page, {
    tabs: [
      { id: "extension-tab", label: "Extensions", dataset: { type: "extension" }, active: true },
      { id: "skill-tab", label: "Skills", dataset: { type: "skill" } },
      { id: "prompt-tab", label: "Prompts", dataset: { type: "prompt" } },
    ],
    actions: [{ id: "refresh-plugins", icon: managementRefreshIcon, label: "Refresh packages" }],
  });
  const installed = document.createElement("section");
  installed.id = "plugins-installed-section";
  installed.className = "collapsible-section";
  installed.innerHTML = '<div class="collapsible-heading"><button class="collapsible-toggle" id="installed-plugins-toggle" type="button" data-collapsible-key="installed" aria-expanded="true" aria-controls="installed-plugins-body"><h2>Installed</h2></button></div><div id="installed-plugins-body" class="collapsible-body"><div id="installed-plugins" class="plugin-grid"></div></div>';
  const skills = document.createElement("section");
  skills.id = "plugins-skills-section";
  skills.className = "collapsible-section";
  skills.innerHTML = '<div class="collapsible-heading"><button class="collapsible-toggle" id="installed-skills-toggle" type="button" data-collapsible-key="skills" aria-expanded="true" aria-controls="installed-skills-body"><h2>Installed</h2></button></div><div id="installed-skills-body" class="collapsible-body"><div id="installed-skills" class="plugin-grid"></div></div>';
  const discover = document.createElement("section");
  discover.id = "plugins-discover-section";
  discover.className = "collapsible-section";
  discover.innerHTML = '<div class="collapsible-heading"><button class="collapsible-toggle" id="plugin-catalog-toggle" type="button" data-collapsible-key="discover" aria-expanded="true" aria-controls="plugin-catalog-body"><h2>Discover</h2></button></div><div id="plugin-catalog-body" class="collapsible-body"><div id="plugin-catalog" class="plugin-grid"></div><button id="load-more-plugins" type="button" hidden>Load more</button></div>';
  layout.addContent({
    id: "plugins-view",
    title: "Extensions",
    titleId: "plugins-title",
    description: "Extend Pi with packages from the community catalog.",
    search: { id: "plugin-search", placeholder: "Search plugins" },
    body: [installed, skills, discover],
  });
  document.body.append(page);
  return page;
}

function setup(api: (path: string, method?: string, body?: unknown) => Promise<Record<string, any>>) {
  const page = buildPage();
  const calls = {
    openExternal: vi.fn(),
    showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
  };
  const controller = new PluginsPageController({ page, api, ...calls });
  return { controller, page, calls };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

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

describe("PluginsPageController", () => {
  it("loads the Pi catalog and skills into the page's scoped elements", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [{ source: "npm:pi-tools@1.0.0", displayName: "Pi Tools", version: "1.0.0", enabled: true, resources: { extensions: 1 } }] };
      if (path === "/api/v1/management/pi/skills") return { data: [{ name: "Review", description: "Review code", source: "npm:pi-tools@1.0.0", enabled: true, filePath: "SKILL.md" }] };
      return { data: { total: 2, packages: [
        { name: "pi-tools", description: "Toolbox", version: "1.0.0", links: { homepage: "https://example.com/pi-tools" } },
        { name: "pi-extra", description: "Extra tools", version: "2.0.0", links: { homepage: "https://example.com/pi-extra" } },
      ] } };
    });
    const { controller, page } = setup(api);

    await controller.load();

    expect(page.querySelector("#installed-plugins")?.textContent).toContain("Pi Tools");
    expect(page.querySelector("#installed-plugins")?.textContent).toContain("1 extensions");
    // Installed packages stay out of the Discover catalog.
    expect(page.querySelector("#plugin-catalog")?.querySelectorAll(".plugin-card")).toHaveLength(1);
    expect(page.querySelector("#plugin-catalog")?.textContent).toContain("pi-extra");
    expect(page.querySelector("#plugin-catalog")?.textContent).not.toContain("pi-tools");
    expect(page.querySelector("#installed-skills")?.textContent).toContain("Review");
  });

  it("shows a loading placeholder before a refresh", () => {
    const { controller, page } = setup(vi.fn(async () => ({ data: {} })));

    controller.showLoading();

    expect(page.querySelector("#installed-plugins")?.textContent).toContain("Loading plugins…");
  });

  it("passes website opening through to the page options", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages" || path === "/api/v1/management/pi/skills") return { data: [] };
      return { data: { total: 1, packages: [{ name: "pi-extra", description: "Extra", version: "2.0.0", links: { homepage: "https://example.com/pi-extra" } }] } };
    });
    const { controller, page, calls } = setup(api);

    await controller.load();
    click(page.querySelector("#plugin-catalog .plugin-card-linked")!);

    expect(calls.openExternal).toHaveBeenCalledWith("https://example.com/pi-extra");
  });

  it("filters the catalog by header type tabs without adding an Installed search", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [] };
      if (path === "/api/v1/management/pi/skills") return { data: [{ name: "Docs", description: "Read docs", source: "npm:docs", enabled: false, filePath: "docs.md" }] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=&offset=0&limit=30&sort=downloads&direction=desc&type=extension");

    // The page title mirrors the active type tab.
    expect(page.querySelector("#plugins-title")?.textContent).toBe("Extensions");

    // The default Extensions tab shows only extension packages.
    expect(page.querySelector("#plugins-installed-section")?.hasAttribute("hidden")).toBe(false);
    expect(page.querySelector("#plugins-skills-section")?.hasAttribute("hidden")).toBe(true);

    click(page.querySelector("#skill-tab")!);
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=&offset=0&limit=30&sort=downloads&direction=desc&type=skill"));
    expect(page.querySelector("#skill-tab")?.classList.contains("active")).toBe(true);
    expect(page.querySelector("#extension-tab")?.classList.contains("active")).toBe(false);
    expect(page.querySelector("#plugins-title")?.textContent).toBe("Skills");
    expect(page.querySelector("#plugins-installed-section")?.hasAttribute("hidden")).toBe(true);
    expect(page.querySelector("#plugins-skills-section")?.hasAttribute("hidden")).toBe(false);
    expect(page.querySelector("#skill-search")).toBeNull();
    expect(page.querySelector("#installed-skills-body .management-search")).toBeNull();
    expect(page.querySelector("#installed-skills")?.textContent).toContain("Docs");
  });

  it("collapses and expands the Installed and Discover sections", () => {
    const { page } = setup(vi.fn(async () => ({ data: {} })));

    const installedToggle = page.querySelector<HTMLButtonElement>("#installed-plugins-toggle")!;
    const installedSection = installedToggle.closest(".collapsible-section")!;
    click(installedToggle);
    expect(installedSection.classList.contains("collapsed")).toBe(true);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("false");
    click(installedToggle);
    expect(installedSection.classList.contains("collapsed")).toBe(false);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("true");

    const catalogToggle = page.querySelector<HTMLButtonElement>("#plugin-catalog-toggle")!;
    click(catalogToggle);
    expect(catalogToggle.closest(".collapsible-section")?.classList.contains("collapsed")).toBe(true);
  });

  it("fails loudly when the page is missing a required catalog control", () => {
    const page = document.createElement("section");
    page.id = "plugins-page";
    expect(() => new PluginsPageController({ page, api: vi.fn(), openExternal: vi.fn(), showStatus: vi.fn(), errorMessage: vi.fn() } satisfies PluginsPageOptions))
      .toThrow("Plugins page is missing type tabs");
  });
});
