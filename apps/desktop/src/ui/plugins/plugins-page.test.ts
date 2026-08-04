// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsPageController, type PluginsPageOptions } from "./plugins-page.js";

function buildPage(): HTMLElement {
  const page = document.createElement("section");
  page.id = "plugins-page";
  page.innerHTML = `
    <header class="management-page-header plugin-page-tabs">
      <div><button id="plugins-tab" class="active" type="button">Plugins</button><button id="skills-tab" type="button">Skills</button></div>
      <button id="refresh-plugins" class="icon-button" type="button"></button>
    </header>
    <div class="management-page-content plugin-content">
      <div id="plugins-view">
        <h1>Plugins</h1>
        <input id="plugin-search" type="search">
        <section class="plugin-section"><button id="installed-plugins-toggle" type="button" aria-expanded="true"></button><div id="installed-plugins" class="plugin-grid"></div></section>
        <section class="plugin-section"><button id="plugin-catalog-toggle" type="button" aria-expanded="true"></button><div id="plugin-catalog" class="plugin-grid"></div><button id="load-more-plugins" type="button" hidden>Load more</button></section>
      </div>
      <div id="skills-view" hidden>
        <h1>Skills</h1>
        <input id="skill-search" type="search">
        <section><div id="installed-skills" class="plugin-grid"></div></section>
      </div>
    </div>
  `;
  document.body.append(page);
  return page;
}

function setup(api: (path: string, method?: string, body?: unknown) => Promise<Record<string, any>>) {
  const page = buildPage();
  const calls = {
    openExternal: vi.fn(),
    showToast: vi.fn(),
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
      return { data: { total: 1, packages: [{ name: "pi-tools", description: "Toolbox", version: "1.0.0", links: { homepage: "https://example.com/pi-tools" } }] } };
    });
    const { controller, page } = setup(api);

    await controller.load();

    expect(page.querySelector("#installed-plugins")?.textContent).toContain("Pi Tools");
    expect(page.querySelector("#installed-plugins")?.textContent).toContain("1 extensions");
    expect(page.querySelector("#plugin-catalog")?.querySelectorAll(".plugin-card")).toHaveLength(1);
    expect(page.querySelector("#plugin-catalog")?.textContent).toContain("✓ Installed");
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

  it("keeps tab state and skills search working through the catalog", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/management/pi/packages") return { data: [] };
      if (path === "/api/v1/management/pi/skills") return { data: [{ name: "Docs", description: "Read docs", source: "npm:docs", enabled: false, filePath: "docs.md" }] };
      return { data: { total: 0, packages: [] } };
    });
    const { controller, page } = setup(api);
    await controller.load();

    click(page.querySelector("#skills-tab")!);
    expect(page.querySelector("#plugins-view")?.hidden).toBe(true);
    expect(page.querySelector("#skills-view")?.hidden).toBe(false);
    expect(page.querySelector("#skills-tab")?.classList.contains("active")).toBe(true);

    const search = page.querySelector<HTMLInputElement>("#skill-search")!;
    search.value = "docs";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(page.querySelector("#installed-skills")?.textContent).toContain("Docs");
  });

  it("collapses and expands the Installed and Discover sections", () => {
    const { page } = setup(vi.fn(async () => ({ data: {} })));

    const installedToggle = page.querySelector<HTMLButtonElement>("#installed-plugins-toggle")!;
    const installedSection = installedToggle.closest(".plugin-section")!;
    click(installedToggle);
    expect(installedSection.classList.contains("collapsed")).toBe(true);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("false");
    click(installedToggle);
    expect(installedSection.classList.contains("collapsed")).toBe(false);
    expect(installedToggle.getAttribute("aria-expanded")).toBe("true");

    const catalogToggle = page.querySelector<HTMLButtonElement>("#plugin-catalog-toggle")!;
    click(catalogToggle);
    expect(catalogToggle.closest(".plugin-section")?.classList.contains("collapsed")).toBe(true);
  });

  it("fails loudly when the page is missing a required catalog control", () => {
    const page = document.createElement("section");
    page.id = "plugins-page";
    expect(() => new PluginsPageController({ page, api: vi.fn(), openExternal: vi.fn(), showToast: vi.fn(), errorMessage: vi.fn() } satisfies PluginsPageOptions))
      .toThrow("Plugins page is missing #plugins-view");
  });
});
