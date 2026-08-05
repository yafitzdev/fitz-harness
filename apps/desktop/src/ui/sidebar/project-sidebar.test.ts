// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSidebarController, type ProjectSidebarElements, type ProjectSidebarOptions, type ProjectSidebarState } from "./project-sidebar.js";

function element<T extends HTMLElement>(tag: string, id?: string): T {
  const value = document.createElement(tag) as T;
  if (id) value.id = id;
  document.body.append(value);
  return value;
}

/** Flushes microtasks plus the next macrotask so commit callbacks settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  // The controller resolves its own elements from the shell by id, so the test
  // document must mirror the static markup in renderer/index.html.
  const tree = element<HTMLElement>("nav", "projects");
  const chatHoverCard = element<HTMLElement>("aside", "chat-hover-card");
  chatHoverCard.hidden = true;
  const chatHoverTitle = element<HTMLElement>("strong", "hover-chat-title");
  const chatHoverAge = element<HTMLElement>("time", "hover-chat-age");
  const chatHoverProject = element<HTMLElement>("span", "hover-project-name");
  const projectHoverCard = element<HTMLElement>("aside", "project-hover-card");
  projectHoverCard.hidden = true;
  const projectHoverTitle = element<HTMLElement>("strong", "hover-project-title");
  const projectHoverTaskCount = element<HTMLElement>("span", "hover-project-task-count");
  const projectHoverPath = element<HTMLButtonElement>("button", "hover-project-path");
  const projectHoverPathLabel = element<HTMLElement>("span", "hover-project-path-label");
  const projectHoverPin = element<HTMLButtonElement>("button", "hover-project-pin");
  const projectHoverEdit = element<HTMLButtonElement>("button", "hover-project-edit");
  const menuElement = element<HTMLElement>("div", "sidebar-context-menu");
  menuElement.hidden = true;
  const calls = {
    selectProject: vi.fn(), selectSession: vi.fn(), newChat: vi.fn(), openProjectPath: vi.fn(), createWorktree: vi.fn(), archiveProjectChats: vi.fn(), removeProject: vi.fn(), renameSession: vi.fn(), renameProject: vi.fn(), createProject: vi.fn(), chooseFolder: vi.fn(async () => undefined), archiveSession: vi.fn(), copyValue: vi.fn(), continueSession: vi.fn(), closePopovers: vi.fn(),
  };
  const controller = new ProjectSidebarController({ mount: tree, ...calls });
  const elements: ProjectSidebarElements = {
    tree, chatHoverCard, chatHoverTitle, chatHoverAge, chatHoverProject,
    projectHoverCard, projectHoverTitle, projectHoverTaskCount, projectHoverPath, projectHoverPathLabel, projectHoverPin, projectHoverEdit,
  };
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

function keydown(target: Element, key: string): void { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); }

function menuButton(menuElement: HTMLElement, label: string): HTMLButtonElement {
  const button = [...menuElement.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`No menu item "${label}"`);
  return button;
}

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

  it("shows a filled pin indicator on pinned chat rows and sorts them first", () => {
    const { controller, elements, menuElement } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItems = [...elements.tree.querySelectorAll<HTMLElement>(".task-row")].map((row) => row.closest(".tree-item")!);
    click(sessionItems[1]!.querySelector(".tree-menu-toggle")!);
    const pin = menuButton(menuElement, "Pin chat");
    click(pin);

    const rows = elements.tree.querySelectorAll<HTMLElement>(".task-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Second chat");
    const indicator = rows[0]!.querySelector(".pin-indicator");
    expect(indicator).not.toBeNull();
    expect(indicator!.getAttribute("aria-label")).toBe("Pinned");
    expect(rows[1]!.querySelector(".pin-indicator")).toBeNull();
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

  it("renames a chat inline from the context menu, committing on Enter", async () => {
    const { controller, elements, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItem = elements.tree.querySelector(".task-row")!.closest(".tree-item")!;
    click(sessionItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Rename chat"));

    const input = elements.tree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("First chat");

    input.value = "Renamed chat";
    keydown(input, "Enter");
    await flush();

    expect(calls.renameSession).toHaveBeenCalledWith("a1", "alpha", "Renamed chat");
    expect(elements.tree.querySelector(".tree-rename-input")).toBeNull();
  });

  it("cancels an inline rename on Escape without committing", () => {
    const { controller, elements, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItem = elements.tree.querySelector(".task-row")!.closest(".tree-item")!;
    click(sessionItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Rename chat"));

    keydown(elements.tree.querySelector(".tree-rename-input")!, "Escape");

    expect(calls.renameSession).not.toHaveBeenCalled();
    expect(elements.tree.querySelector(".tree-rename-input")).toBeNull();
  });

  it("begins renaming the selected session via the public API", () => {
    const { controller, elements } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());

    controller.beginRenameCurrentSession();

    const input = elements.tree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input.value).toBe("First chat");
  });

  it("renames a project inline from the hover card", async () => {
    const { controller, elements, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = elements.tree.querySelector(".project-row")!.closest(".tree-item")!;
    projectItem.dispatchEvent(new MouseEvent("mouseenter"));
    click(elements.projectHoverEdit);

    const input = elements.tree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input.value).toBe("Alpha");
    input.value = "Alpha Plus";
    keydown(input, "Enter");
    await flush();

    expect(calls.renameProject).toHaveBeenCalledWith("alpha", "Alpha Plus");
  });

  it("shows the inline create-project form and commits with the chosen folder", async () => {
    const { controller, elements, calls } = setup();
    calls.chooseFolder.mockResolvedValue("/home/user/my-app");
    controller.render(state());

    controller.beginCreateProject();
    expect(elements.tree.querySelector(".tree-create-form")).not.toBeNull();

    click(elements.tree.querySelector(".tree-create-folder")!);
    await flush();
    const folderLabel = elements.tree.querySelector<HTMLElement>(".tree-create-folder span")!;
    expect(folderLabel.textContent).toBe("/home/user/my-app");

    const name = elements.tree.querySelector<HTMLInputElement>(".tree-create-name")!;
    expect(name.value).toBe("my-app");
    click(elements.tree.querySelector(".tree-form-submit")!);
    await flush();

    expect(calls.createProject).toHaveBeenCalledWith("my-app", "/home/user/my-app");
    expect(elements.tree.querySelector(".tree-create-form")).toBeNull();
  });

  it("cancels the create form and keeps the tree intact", () => {
    const { controller, elements } = setup();
    controller.render(state());

    controller.beginCreateProject();
    click(elements.tree.querySelector(".tree-form-cancel")!);

    expect(elements.tree.querySelector(".tree-create-form")).toBeNull();
    expect(elements.tree.querySelectorAll(".project-group")).toHaveLength(2);
  });

  it("confirms project removal inline and commits on the danger button", async () => {
    const { controller, elements, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = elements.tree.querySelector(".project-row")!.closest(".tree-item")!;
    click(projectItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Remove"));

    const confirmRow = elements.tree.querySelector<HTMLElement>(".tree-confirm-row")!;
    expect(confirmRow.textContent).toContain('Remove "Alpha" and its chats?');
    click(confirmRow.querySelector(".tree-form-danger")!);
    await flush();

    expect(calls.removeProject).toHaveBeenCalledWith("alpha");
    expect(elements.tree.querySelector(".tree-confirm-row")).toBeNull();
  });

  it("cancels removal from the confirm row", () => {
    const { controller, elements, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = elements.tree.querySelector(".project-row")!.closest(".tree-item")!;
    click(projectItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Remove"));

    click(elements.tree.querySelector(".tree-confirm-cancel")!);

    expect(calls.removeProject).not.toHaveBeenCalled();
    expect(elements.tree.querySelector(".tree-confirm-row")).toBeNull();
  });

  it("hides the context menu and hover overlays through the public API", () => {
    const { controller, menuElement, elements } = setup();
    menuElement.hidden = false;
    elements.projectHoverCard.hidden = false;

    controller.hideMenu();
    controller.hideOverlays();

    expect(menuElement.hidden).toBe(true);
    expect(elements.projectHoverCard.hidden).toBe(true);
    expect(elements.chatHoverCard.hidden).toBe(true);
  });

  it("fails loudly when a hover card is missing from the shell", () => {
    const tree = element<HTMLElement>("nav", "projects");
    element<HTMLElement>("aside", "chat-hover-card");
    element<HTMLElement>("strong", "hover-chat-title");
    element<HTMLElement>("time", "hover-chat-age");
    element<HTMLElement>("span", "hover-project-name");
    // #project-hover-card is intentionally omitted.
    const options: ProjectSidebarOptions = {
      mount: tree,
      selectProject: vi.fn(), selectSession: vi.fn(), newChat: vi.fn(), openProjectPath: vi.fn(), createWorktree: vi.fn(), archiveProjectChats: vi.fn(), removeProject: vi.fn(), renameSession: vi.fn(), renameProject: vi.fn(), createProject: vi.fn(), chooseFolder: vi.fn(async () => undefined), archiveSession: vi.fn(), copyValue: vi.fn(), continueSession: vi.fn(), closePopovers: vi.fn(),
    };
    expect(() => new ProjectSidebarController(options)).toThrow("Missing #project-hover-card");
  });
});
