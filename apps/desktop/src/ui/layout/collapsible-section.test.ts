// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleSection } from "./collapsible-section.js";

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

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

beforeEach(() => {
  // happy-dom ships an empty localStorage stub without working methods; install a real one.
  globalThis.localStorage = memoryStorage();
  document.body.replaceChildren();
});

describe("CollapsibleSection", () => {
  it("builds a heading with chevron, title, actions, and body from options", () => {
    const action = document.createElement("button");
    action.textContent = "Edit";
    const section = CollapsibleSection.create({
      title: "Remote API",
      className: "consumer-card",
      actions: [action],
      body: [document.createElement("p")],
    });

    expect(section.root.className).toContain("collapsible-section");
    expect(section.root.className).toContain("consumer-card");
    expect(section.heading.className).toBe("collapsible-heading");
    expect(section.toggle.className).toBe("collapsible-toggle");
    expect(section.title.tagName).toBe("H3");
    expect(section.title.textContent).toBe("Remote API");
    expect(section.chevron.className).toBe("collapsible-chevron");
    expect(section.chevron.querySelector("svg")).not.toBeNull();
    expect(section.actions.className).toBe("collapsible-actions");
    expect(section.actions.textContent).toBe("Edit");
    expect(section.body.className).toBe("collapsible-body");
    expect(section.body.id).toMatch(/^collapsible-body-/);
    expect(section.toggle.getAttribute("aria-controls")).toBe(section.body.id);
    expect(section.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(section.root.classList.contains("collapsed")).toBe(false);
  });

  it("uses h2 for page sections and defaults the persistence key to the title", () => {
    const section = CollapsibleSection.create({ title: "Installed", titleLevel: 2 });
    expect(section.title.tagName).toBe("H2");
  });

  it("collapses on toggle, persists the key, and fires the callback", () => {
    const onToggle = vi.fn();
    const section = CollapsibleSection.create({ id: "remote-1", storageKey: "fitz-collapsed-connections", title: "Remote API", onToggle });

    click(section.toggle);

    expect(section.collapsed).toBe(true);
    expect(section.root.classList.contains("collapsed")).toBe(true);
    expect(section.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-connections") ?? "[]")).toContain("remote-1");
    expect(onToggle).toHaveBeenCalledWith(true);

    click(section.toggle);
    expect(section.collapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-connections") ?? "[]")).not.toContain("remote-1");
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("starts collapsed when persisted state says so and does not fire onToggle for no-ops", () => {
    localStorage.setItem("fitz-collapsed-playbooks", '["ninfer"]');
    const onToggle = vi.fn();
    const section = CollapsibleSection.create({ id: "ninfer", storageKey: "fitz-collapsed-playbooks", title: "NiNfer", onToggle });

    expect(section.collapsed).toBe(true);
    expect(section.root.classList.contains("collapsed")).toBe(true);
    expect(section.toggle.getAttribute("aria-expanded")).toBe("false");
    section.setCollapsed(true);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("stays stateless without a storage key", () => {
    const section = CollapsibleSection.create({ title: "Transient" });
    click(section.toggle);
    expect(section.collapsed).toBe(true);
    expect(localStorage.getItem("fitz-collapsed-plugin-sections")).toBeNull();
  });

  it("appends body content after creation", () => {
    const section = CollapsibleSection.create({ title: "Pair a device" });
    section.appendBody(document.createElement("p"));
    expect(section.body.querySelector("p")).not.toBeNull();
  });

  it("adopts existing shell markup and binds collapse behavior in place", () => {
    const root = document.createElement("section");
    root.className = "collapsible-section";
    root.innerHTML = '<div class="collapsible-heading"><button class="collapsible-toggle" type="button" data-collapsible-key="remote"><h2>Remote access</h2></button></div><div class="collapsible-body" id="admin-remote-body"></div>';
    document.body.append(root);

    const section = CollapsibleSection.adopt(root, { storageKey: "fitz-collapsed-admin-sections" });

    expect(section.title.textContent).toBe("Remote access");
    expect(section.chevron.className).toBe("collapsible-chevron");
    expect(section.actions.className).toBe("collapsible-actions");
    expect(section.toggle.getAttribute("aria-expanded")).toBe("true");

    click(section.toggle);
    expect(section.collapsed).toBe(true);
    expect(root.classList.contains("collapsed")).toBe(true);
    expect(JSON.parse(localStorage.getItem("fitz-collapsed-admin-sections") ?? "[]")).toContain("remote");
  });

  it("adopts only sections that carry a toggle", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<section class="collapsible-section"><div class="collapsible-heading"><button class="collapsible-toggle" type="button" data-collapsible-key="installed"><h2>Installed</h2></button></div><div class="collapsible-body"></div></section>',
      '<section class="collapsible-section"><div class="collapsible-heading"><h2>Skills</h2></div><div class="collapsible-body"></div></section>',
    ].join("");
    document.body.append(root);

    const sections = CollapsibleSection.adoptAll(root, { storageKey: "fitz-collapsed-plugin-sections" });

    expect(sections).toHaveLength(1);
    expect(sections[0]!.title.textContent).toBe("Installed");
  });
});
