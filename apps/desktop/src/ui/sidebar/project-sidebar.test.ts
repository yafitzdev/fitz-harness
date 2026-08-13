// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSidebarController, type ProjectSidebarOptions, type ProjectSidebarState } from "./project-sidebar.js";

function element<T extends HTMLElement>(tag: string, id?: string): T {
  const value = document.createElement(tag) as T;
  if (id) value.id = id;
  document.body.append(value);
  return value;
}

/** Flushes microtasks plus the next macrotask so commit callbacks settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  // The controller resolves the context menu from the shell by id, so the test
  // document must mirror the static markup in renderer/index.html. The
  // create-project dialog is appended to document.body by the controller.
  const tree = element<HTMLElement>("nav", "projects");
  const chatsTree = element<HTMLElement>("nav", "chats");
  const pinnedSection = element<HTMLElement>("section", "pinned-section");
  const pinnedTree = element<HTMLElement>("nav", "pinned");
  pinnedSection.append(pinnedTree);
  const menuElement = element<HTMLElement>("div", "sidebar-context-menu");
  menuElement.hidden = true;
  const calls = {
    selectProject: vi.fn(), selectSession: vi.fn(), newChat: vi.fn(), openProjectPath: vi.fn(), createWorktree: vi.fn(), archiveProjectChats: vi.fn(), removeProject: vi.fn(), renameSession: vi.fn(), renameProject: vi.fn(), createProject: vi.fn(), chooseFolder: vi.fn(async () => undefined), onError: vi.fn(), archiveSession: vi.fn(), removeSession: vi.fn(), copyValue: vi.fn(), continueSession: vi.fn(), closePopovers: vi.fn(),
  };
  const controller = new ProjectSidebarController({ mount: tree, pinnedMount: pinnedTree, pinnedSection, chatsMount: chatsTree, ...calls });
  return { controller, tree, chatsTree, pinnedTree, pinnedSection, menuElement, calls };
}

function state(): ProjectSidebarState {
  return {
    projects: [{ id: "alpha", name: "Alpha", rootPath: "C:\\code\\alpha" }, { id: "beta", name: "Beta" }],
    sessionsByProject: new Map([
      ["alpha", [{ id: "a1", title: "First chat", createdAt: "2026-08-03T00:00:00.000Z" }, { id: "a2", title: "Second chat" }]],
      ["beta", [{ id: "b1", title: "Beta chat" }]],
    ]),
    chats: [{ id: "c1", title: "Standalone chat", createdAt: "2026-08-05T00:00:00.000Z" }, { id: "c2", title: "Another chat" }],
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

function menuOrder(menuElement: HTMLElement): string[] {
  return [...menuElement.children].map((item) => item.tagName === "HR" ? "|" : item.textContent?.trim() ?? "");
}

function dialog(): HTMLElement {
  const value = document.querySelector<HTMLElement>(".create-project-backdrop");
  if (!value) throw new Error("Missing .create-project-backdrop");
  return value;
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
    const { controller, tree, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.ensureExpanded("beta");
    controller.render(state());

    const groups = tree.querySelectorAll<HTMLElement>(".project-group");
    expect(groups).toHaveLength(2);
    expect([...groups].every((group) => group.classList.contains("expanded"))).toBe(true);
    expect(tree.querySelectorAll(".task-row")).toHaveLength(3);

    click(groups[0]!.querySelector(".project-row")!);
    expect(groups[0]!.classList.contains("expanded")).toBe(false);
    expect(groups[1]!.classList.contains("expanded")).toBe(true);
    expect(calls.selectProject).not.toHaveBeenCalled();

    click(groups[1]!.querySelector(".project-row")!);
    expect(calls.selectProject).toHaveBeenCalledWith("beta");
  });

  it("routes project quick actions and session selection through callbacks", () => {
    const { controller, tree, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());

    click(tree.querySelector(".tree-quick-action")!);
    expect(calls.newChat).toHaveBeenCalledWith("alpha");
    click(tree.querySelector(".task-row")!);
    expect(calls.selectSession).toHaveBeenCalledWith("a1", "alpha");
  });

  it("collects pinned projects in the Pinned section and hides the section after unpinning", () => {
    const { controller, tree, pinnedTree, pinnedSection, menuElement } = setup();
    controller.render(state());
    expect(pinnedSection.hidden).toBe(true);

    click(tree.querySelector(".project-row")!.closest(".tree-item")!.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Pin project"));
    expect(pinnedSection.hidden).toBe(false);
    expect(pinnedTree.textContent).toContain("Alpha");
    expect(pinnedTree.textContent).toContain("First chat");
    expect(pinnedTree.textContent).toContain("Second chat");
    expect(pinnedTree.querySelectorAll(".pinned-project-group .task-row")).toHaveLength(2);
    expect(pinnedTree.querySelector(".tree-pin-action")?.getAttribute("aria-pressed")).toBe("true");
    expect(tree.textContent).not.toContain("Alpha");
    expect(tree.textContent).toContain("Beta");

    click(pinnedTree.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Unpin project"));
    expect(pinnedSection.hidden).toBe(true);
    expect(tree.textContent).toContain("Alpha");
  });

  it("moves pinned project chats out of their project and into the Pinned section", () => {
    const { controller, tree, pinnedTree, pinnedSection, menuElement } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItems = [...tree.querySelectorAll<HTMLElement>(".task-row")].map((row) => row.closest(".tree-item")!);
    click(sessionItems[1]!.querySelector(".tree-menu-toggle")!);
    const pin = menuButton(menuElement, "Pin chat");
    click(pin);

    const rows = tree.querySelectorAll<HTMLElement>(".task-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("First chat");
    expect([...rows].some((row) => row.textContent?.includes("Second chat"))).toBe(false);
    expect(pinnedSection.hidden).toBe(false);
    expect(pinnedTree.textContent).toContain("Second chat");
    expect(pinnedTree.querySelector(".tree-pin-action")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("deduplicates an individually pinned chat beneath its pinned project", () => {
    const { controller, tree, pinnedTree } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const alphaGroup = tree.querySelector<HTMLElement>('.project-group[data-project-id="alpha"]')!;
    const secondChat = alphaGroup.querySelectorAll<HTMLElement>(".tree-item")[2]!;
    click(secondChat.querySelector('.tree-pin-action[aria-label="Pin chat"]')!);
    click(tree.querySelector('.project-group[data-project-id="alpha"] .tree-pin-action[aria-label="Pin project"]')!);

    expect(pinnedTree.querySelectorAll(".pinned-project-group")).toHaveLength(1);
    expect(pinnedTree.querySelectorAll(".pinned-project-group .task-row")).toHaveLength(2);
    expect([...pinnedTree.querySelectorAll(".task-row")].filter((row) => row.textContent?.includes("Second chat"))).toHaveLength(1);
    expect(tree.querySelector('.project-group[data-project-id="alpha"]')).toBeNull();

    click(pinnedTree.querySelector('.tree-pin-action[aria-label="Unpin project"]')!);
    expect(pinnedTree.querySelectorAll(".pinned-project-group")).toHaveLength(0);
    expect(pinnedTree.textContent).toContain("Second chat");
    expect(tree.querySelector('.project-group[data-project-id="alpha"]')).not.toBeNull();
    expect(tree.textContent).not.toContain("Second chat");
  });

  it("opens a centered create-project dialog with name and folder controls", () => {
    const { controller } = setup();
    controller.render(state());

    controller.beginCreateProject();

    const backdrop = dialog();
    expect(backdrop.hidden).toBe(false);
    const panel = backdrop.querySelector<HTMLElement>(".create-project-dialog")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.querySelector<HTMLInputElement>(".create-project-name")).not.toBeNull();
    expect(panel.querySelector<HTMLButtonElement>(".create-project-choose")).not.toBeNull();
    expect(panel.querySelector<HTMLElement>(".create-project-folder-label")!.textContent).toBe("No folder selected");
  });

  it("creates a project from the dialog with the chosen folder", async () => {
    const { controller, calls } = setup();
    calls.chooseFolder.mockResolvedValue("/home/user/my-app");
    controller.render(state());

    controller.beginCreateProject();
    const backdrop = dialog();
    click(backdrop.querySelector(".create-project-choose")!);
    await flush();

    const folderLabel = backdrop.querySelector<HTMLElement>(".create-project-folder-label")!;
    expect(folderLabel.textContent).toBe("/home/user/my-app");
    const name = backdrop.querySelector<HTMLInputElement>(".create-project-name")!;
    expect(name.value).toBe("my-app");

    click(backdrop.querySelector(".tree-form-submit")!);
    await flush();

    expect(calls.createProject).toHaveBeenCalledWith("my-app", "/home/user/my-app");
    expect(backdrop.hidden).toBe(true);
  });

  it("reports a rejected folder picker and restores its control", async () => {
    const { controller, calls } = setup();
    const failure = new Error("Picker unavailable");
    calls.chooseFolder.mockRejectedValueOnce(failure);
    controller.render(state());
    controller.beginCreateProject();
    const choose = dialog().querySelector<HTMLButtonElement>(".create-project-choose")!;

    click(choose);
    expect(choose.disabled).toBe(true);
    await flush();

    expect(calls.onError).toHaveBeenCalledWith(failure);
    expect(choose.disabled).toBe(false);
    expect(dialog().hidden).toBe(false);
  });

  it("submits the dialog with Enter and keeps the chosen folder", async () => {
    const { controller, calls } = setup();
    calls.chooseFolder.mockResolvedValue("C:\\code\\alpha");
    controller.render(state());

    controller.beginCreateProject();
    const backdrop = dialog();
    click(backdrop.querySelector(".create-project-choose")!);
    await flush();

    const name = backdrop.querySelector<HTMLInputElement>(".create-project-name")!;
    name.value = "Alpha Folder";
    keydown(name, "Enter");
    await flush();

    expect(calls.createProject).toHaveBeenCalledWith("Alpha Folder", "C:\\code\\alpha");
    expect(backdrop.hidden).toBe(true);
  });

  it("does not create a project when the name is empty", async () => {
    const { controller, calls } = setup();
    controller.render(state());

    controller.beginCreateProject();
    const backdrop = dialog();
    click(backdrop.querySelector(".tree-form-submit")!);
    await flush();

    expect(calls.createProject).not.toHaveBeenCalled();
    expect(backdrop.hidden).toBe(false);
  });

  it("cancels the create dialog and keeps the tree intact", () => {
    const { controller, tree } = setup();
    controller.render(state());

    controller.beginCreateProject();
    click(dialog().querySelector(".tree-form-cancel")!);

    expect(dialog().hidden).toBe(true);
    expect(tree.querySelectorAll(".project-group")).toHaveLength(2);
  });

  it("closes the create dialog on Escape and on backdrop click", () => {
    const { controller } = setup();
    controller.render(state());

    controller.beginCreateProject();
    keydown(dialog().querySelector(".create-project-name")!, "Escape");
    expect(dialog().hidden).toBe(true);

    controller.beginCreateProject();
    click(dialog());
    expect(dialog().hidden).toBe(true);
  });

  it("toggles the create dialog closed when reopened", () => {
    const { controller } = setup();
    controller.render(state());

    controller.beginCreateProject();
    expect(dialog().hidden).toBe(false);

    controller.beginCreateProject();
    expect(dialog().hidden).toBe(true);
  });

  it("renames a chat inline from the context menu, committing on Enter", async () => {
    const { controller, tree, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItem = tree.querySelector(".task-row")!.closest(".tree-item")!;
    click(sessionItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Rename chat"));

    const input = tree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("First chat");

    input.value = "Renamed chat";
    keydown(input, "Enter");
    await flush();

    expect(calls.renameSession).toHaveBeenCalledWith("a1", "alpha", "Renamed chat");
    expect(tree.querySelector(".tree-rename-input")).toBeNull();
  });

  it("cancels an inline rename on Escape without committing", () => {
    const { controller, tree, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const sessionItem = tree.querySelector(".task-row")!.closest(".tree-item")!;
    click(sessionItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Rename chat"));

    keydown(tree.querySelector(".tree-rename-input")!, "Escape");

    expect(calls.renameSession).not.toHaveBeenCalled();
    expect(tree.querySelector(".tree-rename-input")).toBeNull();
  });

  it("begins renaming the selected session via the public API", () => {
    const { controller, tree } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());

    controller.beginRenameCurrentSession();

    const input = tree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input.value).toBe("First chat");
  });

  it("renames a project from the context menu, committing on Enter", async () => {
    const { controller, tree, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = tree.querySelector(".project-row")!.closest(".tree-item")!;
    click(projectItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Edit project"));

    const input = tree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input.value).toBe("Alpha");
    input.value = "Alpha Plus";
    keydown(input, "Enter");
    await flush();

    expect(calls.renameProject).toHaveBeenCalledWith("alpha", "Alpha Plus");
  });

  it("confirms project removal inline and commits on the danger button", async () => {
    const { controller, tree, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = tree.querySelector(".project-row")!.closest(".tree-item")!;
    click(projectItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Remove"));

    const confirmRow = tree.querySelector<HTMLElement>(".tree-confirm-row")!;
    expect(confirmRow.textContent).toContain('Remove "Alpha" and its chats?');
    click(confirmRow.querySelector(".tree-form-danger")!);
    await flush();

    expect(calls.removeProject).toHaveBeenCalledWith("alpha");
    expect(tree.querySelector(".tree-confirm-row")).toBeNull();
  });

  it("cancels removal from the confirm row", () => {
    const { controller, tree, menuElement, calls } = setup();
    controller.ensureExpanded("alpha");
    controller.render(state());
    const projectItem = tree.querySelector(".project-row")!.closest(".tree-item")!;
    click(projectItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Remove"));

    click(tree.querySelector(".tree-confirm-cancel")!);

    expect(calls.removeProject).not.toHaveBeenCalled();
    expect(tree.querySelector(".tree-confirm-row")).toBeNull();
  });

  it("hides the context menu through the public API", () => {
    const { controller, menuElement } = setup();
    menuElement.hidden = false;

    controller.hideMenu();

    expect(menuElement.hidden).toBe(true);
  });

  it("fails loudly when the context menu is missing from the shell", () => {
    const tree = element<HTMLElement>("nav", "projects");
    const options: ProjectSidebarOptions = {
      mount: tree,
      pinnedMount: element<HTMLElement>("nav", "pinned"),
      pinnedSection: element<HTMLElement>("section", "pinned-section"),
      chatsMount: element<HTMLElement>("nav", "chats"),
      selectProject: vi.fn(), selectSession: vi.fn(), newChat: vi.fn(), openProjectPath: vi.fn(), createWorktree: vi.fn(), archiveProjectChats: vi.fn(), removeProject: vi.fn(), renameSession: vi.fn(), renameProject: vi.fn(), createProject: vi.fn(), chooseFolder: vi.fn(async () => undefined), onError: vi.fn(), archiveSession: vi.fn(), removeSession: vi.fn(), copyValue: vi.fn(), continueSession: vi.fn(), closePopovers: vi.fn(),
    };
    expect(() => new ProjectSidebarController(options)).toThrow("Missing #sidebar-context-menu");
  });

  it("renders standalone chats in the Chats tree and selects them with no project", () => {
    const { controller, chatsTree, calls } = setup();
    controller.render(state());

    const rows = chatsTree.querySelectorAll<HTMLElement>(".chat-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Standalone chat");
    expect(rows[1]!.textContent).toContain("Another chat");

    click(rows[0]!);
    expect(calls.selectSession).toHaveBeenCalledWith("c1", undefined);
  });

  it("shows an empty message in the Chats tree when there are no chats", () => {
    const { controller, chatsTree } = setup();
    controller.render({ ...state(), chats: [] });
    expect(chatsTree.textContent).toContain("No chats yet");
  });

  it("marks a standalone chat as active only when no project is selected", () => {
    const { controller, chatsTree } = setup();
    controller.render({ ...state(), currentProjectId: undefined, currentSessionId: "c1" });

    const rows = chatsTree.querySelectorAll<HTMLElement>(".chat-row");
    expect(rows[0]!.classList.contains("active")).toBe(true);
    expect(rows[1]!.classList.contains("active")).toBe(false);
  });

  it("renders pinned standalone chats in the shared Pinned section", () => {
    const { controller, chatsTree, pinnedTree, pinnedSection, menuElement } = setup();
    controller.render(state());
    const chatItems = [...chatsTree.querySelectorAll<HTMLElement>(".chat-row")].map((row) => row.closest(".tree-item")!);
    click(chatItems[1]!.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Pin chat"));

    const rows = chatsTree.querySelectorAll<HTMLElement>(".chat-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Standalone chat");
    expect(chatsTree.textContent).not.toContain("Another chat");
    expect(pinnedSection.hidden).toBe(false);
    expect(pinnedTree.textContent).toContain("Another chat");
    expect(pinnedTree.querySelector(".tree-pin-action")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("renames a standalone chat inline, committing with an undefined project", async () => {
    const { controller, chatsTree, menuElement, calls } = setup();
    controller.render(state());
    const chatItem = chatsTree.querySelector(".chat-row")!.closest(".tree-item")!;
    click(chatItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Rename chat"));

    const input = chatsTree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input.value).toBe("Standalone chat");
    input.value = "Renamed chat";
    keydown(input, "Enter");
    await flush();

    expect(calls.renameSession).toHaveBeenCalledWith("c1", undefined, "Renamed chat");
    expect(chatsTree.querySelector(".tree-rename-input")).toBeNull();
  });

  it("archives a standalone chat with no project attached", () => {
    const { controller, chatsTree, menuElement, calls } = setup();
    controller.render(state());
    const chatItem = chatsTree.querySelector(".chat-row")!.closest(".tree-item")!;
    click(chatItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Archive chat"));

    expect(calls.archiveSession).toHaveBeenCalledWith("c1", undefined);
  });

  it("uses the canonical chat menu order and destructive styling", () => {
    const { controller, chatsTree, menuElement } = setup();
    controller.render(state());
    click(chatsTree.querySelector(".tree-menu-toggle")!);

    expect(menuOrder(menuElement)).toEqual([
      "Pin chat", "Rename chat", "Continue in new chat", "|",
      "Open in Explorer", "Copy working directory", "Copy session ID", "Copy deeplink", "|",
      "Archive chat", "Remove",
    ]);
    expect(menuButton(menuElement, "Archive chat").classList.contains("danger")).toBe(true);
    expect(menuButton(menuElement, "Remove").classList.contains("danger")).toBe(true);
  });

  it("removes a standalone chat through the durable callback", async () => {
    const { controller, chatsTree, menuElement, calls } = setup();
    controller.render(state());
    click(chatsTree.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Remove"));
    await flush();
    expect(calls.removeSession).toHaveBeenCalledWith("c1", undefined);
  });

  it("continues a standalone chat in a new chat", () => {
    const { controller, chatsTree, menuElement, calls } = setup();
    controller.render(state());
    const chatItem = chatsTree.querySelector(".chat-row")!.closest(".tree-item")!;
    click(chatItem.querySelector(".tree-menu-toggle")!);
    click(menuButton(menuElement, "Continue in new chat"));

    expect(calls.continueSession).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", title: "Standalone chat" }), undefined);
  });

  it("begins renaming a standalone chat via the public API", () => {
    const { controller, chatsTree } = setup();
    controller.render({ ...state(), currentProjectId: undefined, currentSessionId: "c1" });

    controller.beginRenameCurrentSession();

    const input = chatsTree.querySelector<HTMLInputElement>(".tree-rename-input")!;
    expect(input.value).toBe("Standalone chat");
  });
});
