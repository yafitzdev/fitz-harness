// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../primitives/context-menu.js";
import { ProjectSidebarController, type ProjectSidebarElements, type ProjectSidebarOptions, type ProjectSidebarState } from "./project-sidebar.js";

function element<T extends HTMLElement>(tag: string, id?: string): T {
  const value = document.createElement(tag) as T;
  if (id) value.id = id;
  document.body.append(value);
  return value;
}

function setup() {
  const elements: ProjectSidebarElements = {
    tree: element("nav"),
    chatHoverCard: element("aside"),
    chatHoverTitle: element("strong"),
    chatHoverAge: element("time"),
    chatHoverProject: element("span"),
    projectHoverCard: element("aside"),
    projectHoverTitle: element("strong"),
    projectHoverTaskCount: element("span"),
    projectHoverPath: element<HTMLButtonElement>("button"),
    projectHoverPathLabel: element("span"),
    projectHoverPin: element<HTMLButtonElement>("button"),
    projectHoverEdit: element<HTMLButtonElement>("button"),
  };
  elements.chatHoverCard.hidden = true;
  elements.projectHoverCard.hidden = true;
  const menuElement = element("div");
  const calls = {
    selectProject: vi.fn(), selectSession: vi.fn(), newChat: vi.fn(), openProjectPath: vi.fn(), createWorktree: vi.fn(), editProject: vi.fn(), archiveProjectChats: vi.fn(), removeProject: vi.fn(), renameSession: vi.fn(), archiveSession: vi.fn(), copyValue: vi.fn(), continueSession: vi.fn(), closePopovers: vi.fn(),
  };
  const menu = new ContextMenu(menuElement, calls.closePopovers);
  const options: ProjectSidebarOptions = { elements, menu, ...calls };
  const controller = new ProjectSidebarController(options);
  return { controller, elements, menuElement, calls };
}

function state(): ProjectSidebarState {
  return {
    projects: [{ id: "alpha", name: "Alpha", rootPath: "C:\\code\\alpha" }, { id: "beta", name: "Beta" }],
    sessionsByProject: new Map([
      ["alpha", [{ id: "a1", title: "First chat", createdAt: "2026-08-03T00:00:00.000Z" }, { id: "a2", title: "Second chat" }]],
      ["beta", [{ id: "b1", title: "Beta chat" }]],
    ]),
    currentProjectId: "alpha",
    currentSessionId: "a1",
    newChat: false,
  };
}

function click(target: Element): void { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); }

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: createMemoryStorage() });

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("ProjectSidebarController", () => {
  it("renders projects and sessions while expanding each project independently", () => {
    const { controller, elements, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.ensureExpanded("beta");
    controller.render(state());

    const groups = elements.tree.querySelectorAll<HTMLElement>(".project-group");
    expect(groups).toHaveLength(2);
    expect([...groups].every((group) => group.classList.contains("expanded"))).toBe(true);
    expect(elements.tree.querySelectorAll(".task-row")).toHaveLength(3);

    click(groups[0]!.querySelector(".project-row")!);
    expect(groups[0]!.classList.contains("expanded")).toBe(false);
    expect(groups[1]!.classList.contains("expanded")).toBe(true);
    expect(calls.selectProject).not.toHaveBeenCalled();

    click(groups[1]!.querySelector(".project-row")!);
    expect(calls.selectProject).toHaveBeenCalledWith("beta");
  });

  it("routes project quick actions and session selection through callbacks", () => {
    const { controller, elements, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());

    click(elements.tree.querySelector(".tree-quick-action")!);
    expect(calls.newChat).toHaveBeenCalledWith("alpha");
    click(elements.tree.querySelector(".task-row")!);
    expect(calls.selectSession).toHaveBeenCalledWith("a1", "alpha");
  });

  it("persists unread state through the task menu and restores its indicator", () => {
    const { controller, elements, menuElement } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItem = elements.tree.querySelector(".task-row")!.closest(".tree-item")!;
    click(sessionItem.querySelector(".tree-menu-toggle")!);
    const unread = [...menuElement.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Mark as unread"));
    expect(unread).toBeDefined();
    click(unread!);

    expect(JSON.parse(localStorage.getItem("fitz-unread-sessions") ?? "[]")).toContain("a1");
    expect(elements.tree.querySelector(".task-row .activity-dot")).not.toBeNull();
    expect(controller.markSessionRead("a1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("fitz-unread-sessions") ?? "[]")).not.toContain("a1");
  });

  it("fills project and chat hover cards and exposes project actions", () => {
    const { controller, elements, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = elements.tree.querySelector(".project-row")!.closest(".tree-item")!;
    projectItem.dispatchEvent(new MouseEvent("mouseenter"));
    expect(elements.projectHoverCard.hidden).toBe(false);
    expect(elements.projectHoverTitle.textContent).toBe("Alpha");
    expect(elements.projectHoverTaskCount.textContent).toBe("2 tasks");
    expect(elements.projectHoverPathLabel.textContent).toBe("C:\\code\\alpha");
    click(elements.projectHoverPath);
    expect(calls.openProjectPath).toHaveBeenCalledWith("C:\\code\\alpha");

    const sessionItem = elements.tree.querySelector(".task-row")!.closest(".tree-item")!;
    sessionItem.dispatchEvent(new MouseEvent("mouseenter"));
    expect(elements.projectHoverCard.hidden).toBe(true);
    expect(elements.chatHoverCard.hidden).toBe(false);
    expect(elements.chatHoverTitle.textContent).toBe("First chat");
    expect(elements.chatHoverProject.textContent).toBe("Alpha");
  });
});
