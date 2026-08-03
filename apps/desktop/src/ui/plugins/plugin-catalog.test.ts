// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginCatalogController, type PluginCatalogApi, type PluginCatalogElements } from "./plugin-catalog.js";

function node<T extends HTMLElement>(tag: string): T {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  return element;
}

function setup(api: PluginCatalogApi, searchDelayMs = 250) {
  const elements: PluginCatalogElements = {
    pluginsView: node("section"), skillsView: node("section"), pluginsTab: node("button"), skillsTab: node("button"),
    pluginSearch: node("input"), skillSearch: node("input"), installedPlugins: node("div"), pluginCatalog: node("div"), installedSkills: node("div"),
    loadMorePlugins: node("button"), refresh: node("button"),
  };
  elements.skillsView.hidden = true;
  elements.loadMorePlugins.hidden = true;
  const calls = { openExternal: vi.fn(), showToast: vi.fn(), errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)) };
  const controller = new PluginCatalogController(elements, { api, ...calls, searchDelayMs });
  return { controller, elements, calls };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => document.body.replaceChildren());
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
    expect(elements.pluginCatalog.querySelectorAll(".plugin-card")).toHaveLength(2);
    expect(elements.pluginCatalog.textContent).toContain("✓ Installed");
    expect(elements.installedSkills.textContent).toContain("Review");
    click(elements.pluginCatalog.querySelector(".plugin-card-linked")!);
    expect(calls.openExternal).toHaveBeenCalledWith("https://example.com/pi-tools");
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
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=pi%20tools&offset=0&limit=30");

    click(elements.loadMorePlugins);
    await settle();
    expect(api).toHaveBeenCalledWith("/api/v1/management/pi/catalog?query=pi%20tools&offset=1&limit=30");
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
});
