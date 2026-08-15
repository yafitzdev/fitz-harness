// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementPageLayout, managementRefreshIcon } from "./management-page.js";

function section(): HTMLElement {
  const root = document.createElement("section");
  root.className = "management-page";
  document.body.append(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("ManagementPageLayout", () => {
  it("builds a header with tabs on the left and actions on the right", () => {
    const root = section();
    const layout = new ManagementPageLayout(root, {
      tabs: [{ id: "plugins-tab", label: "Plugins", active: true }, { id: "skills-tab", label: "Skills" }],
      actions: [{ id: "refresh-plugins", icon: managementRefreshIcon, label: "Refresh packages" }],
    });
    const header = root.querySelector<HTMLElement>(":scope > .management-page-header")!;
    expect(header).not.toBeNull();
    expect(header.firstElementChild?.classList.contains("management-page-tabs")).toBe(true);
    expect(header.lastElementChild?.classList.contains("management-actions")).toBe(true);
    expect(layout.tabs.textContent).toBe("PluginsSkills");
    expect(layout.getTab("plugins-tab")?.classList.contains("active")).toBe(true);
    expect(layout.getTab("skills-tab")?.classList.contains("active")).toBe(false);
    const action = layout.getAction("refresh-plugins")!;
    expect(action.getAttribute("aria-label")).toBe("Refresh packages");
    expect(action.querySelector("svg")).not.toBeNull();
  });

  it("switches the active tab and notifies listeners", () => {
    const root = section();
    const layout = new ManagementPageLayout(root, {
      tabs: [{ id: "a", label: "A", active: true }, { id: "b", label: "B" }],
    });
    const listener = vi.fn();
    const content = layout.addContent({ title: "Stale heading" });
    expect(content.querySelector("h1")?.textContent).toBe("A");
    layout.onTabSelect(listener);
    layout.getTab("b")!.click();
    expect(listener).toHaveBeenCalledWith("b");
    expect(layout.getTab("a")!.classList.contains("active")).toBe(false);
    expect(layout.getTab("b")!.classList.contains("active")).toBe(true);
    expect(content.querySelector("h1")?.textContent).toBe("B");
  });

  it("renders content columns with direct-child heading, description, and search", () => {
    const root = section();
    const layout = new ManagementPageLayout(root);
    const body = document.createElement("div");
    body.id = "playbook-list";
    layout.addContent({
      id: "management-browser",
      title: "Playbooks",
      titleId: "management-title",
      description: "Engine folders appear automatically.",
      descriptionId: "management-description",
      search: { id: "playbook-search", placeholder: "Search playbooks" },
      body: [body],
    });
    const column = root.querySelector<HTMLElement>(":scope > .management-page-content")!;
    expect(column.id).toBe("management-browser");
    const title = column.querySelector<HTMLElement>(":scope > h1")!;
    expect(title.id).toBe("management-title");
    expect(title.textContent).toBe("Playbooks");
    const description = column.querySelector<HTMLElement>(":scope > p")!;
    expect(description.id).toBe("management-description");
    expect(column.querySelector<HTMLElement>(":scope > .management-search input")?.id).toBe("playbook-search");
    expect(column.lastElementChild).toBe(body);
  });

  it("stacks multiple columns in order and keeps hidden columns hidden", () => {
    const root = section();
    const layout = new ManagementPageLayout(root);
    layout.addContent({ id: "plugins-view", title: "Plugins" });
    layout.addContent({ id: "skills-view", title: "Skills", hidden: true });
    const columns = [...root.querySelectorAll<HTMLElement>(":scope > .management-page-content")];
    expect(columns).toHaveLength(2);
    expect(columns[0]!.id).toBe("plugins-view");
    expect(columns[1]!.id).toBe("skills-view");
    expect(columns[1]!.hidden).toBe(true);
  });

  it("inserts a column before a given sibling", () => {
    const root = section();
    const editor = document.createElement("section");
    editor.id = "management-editor";
    root.append(editor);
    const layout = new ManagementPageLayout(root);
    layout.addContent({ id: "management-browser", title: "Playbooks", before: editor });
    expect(root.children[1]!.id).toBe("management-browser");
    expect(root.children[2]).toBe(editor);
  });

  it("renders text actions with their extra classes", () => {
    const root = section();
    const layout = new ManagementPageLayout(root, {
      actions: [{ id: "new-connection", label: "New connection", className: "quiet-button compact-button" }],
    });
    const action = layout.getAction("new-connection")!;
    expect(action.textContent).toBe("New connection");
    expect(action.classList.contains("quiet-button")).toBe(true);
    expect(action.classList.contains("compact-button")).toBe(true);
  });
});
