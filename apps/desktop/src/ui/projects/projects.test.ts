// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsController, type ProjectsElements, type ProjectsOptions } from "./projects.js";

// happy-dom does not ship the global `Option` constructor used by the task
// dialog; polyfill it with real option elements so select.add() and value
// binding behave like the browser.
if (typeof globalThis.Option === "undefined") {
  (globalThis as any).Option = function Option(this: HTMLOptionElement, text = "", value?: string, defaultSelected = false, selected = false) {
    const option = document.createElement("option");
    option.text = text;
    if (value !== undefined) option.value = value;
    option.defaultSelected = defaultSelected;
    option.selected = selected;
    return option;
  };
}

type Json = Record<string, any>;

function buildElements(): ProjectsElements {
  const projectDialog = document.createElement("dialog");
  const projectForm = document.createElement("form");
  const projectName = document.createElement("input");
  const projectRootPath = document.createElement("input");
  const projectFolderLabel = document.createElement("span");
  const chooseProjectFolder = document.createElement("button");
  const taskDialog = document.createElement("dialog");
  const taskForm = document.createElement("form");
  const taskProject = document.createElement("select");
  const taskName = document.createElement("input");
  const renameDialog = document.createElement("dialog");
  const renameForm = document.createElement("form");
  const renameTaskName = document.createElement("input");
  const renameHeading = document.createElement("h2");
  const renameLabel = document.createElement("label");
  const removeProjectDialog = document.createElement("dialog");
  const removeProjectForm = document.createElement("form");
  const removeProjectName = document.createElement("span");
  document.body.append(
    projectDialog, projectForm, projectName, projectRootPath, projectFolderLabel, chooseProjectFolder,
    taskDialog, taskForm, taskProject, taskName,
    renameDialog, renameForm, renameTaskName, renameHeading, renameLabel,
    removeProjectDialog, removeProjectForm, removeProjectName,
  );
  return {
    projectDialog, projectForm, projectName, projectRootPath, projectFolderLabel, chooseProjectFolder,
    taskDialog, taskForm, taskProject, taskName,
    renameDialog, renameForm, renameTaskName, renameHeading, renameLabel,
    removeProjectDialog, removeProjectForm, removeProjectName,
  };
}

/** A small in-memory host: mutates on POST/PATCH/DELETE so reloads observe changes. */
function fakeApi(initial: { projects: Json[]; sessions: Record<string, Json[]> }) {
  const state = {
    projects: initial.projects.map((project) => ({ ...project })),
    sessions: Object.fromEntries(Object.entries(initial.sessions).map(([projectId, sessions]) => [projectId, sessions.map((session) => ({ ...session }))])),
  };
  const api = vi.fn(async (path: string, method = "GET", body?: unknown) => {
    const sessionsPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/sessions$/);
    if (method === "POST" && path === "/api/v1/projects") {
      const record = { id: "project-new", ...(body as Json) };
      state.projects.push(record);
      return { data: record };
    }
    if (method === "POST" && sessionsPath) {
      const record = { id: "session-new", ...(body as Json) };
      (state.sessions[sessionsPath[1]!] ??= []).unshift(record);
      return { data: record };
    }
    if (method === "PATCH" && path.startsWith("/api/v1/sessions/")) {
      const sessionId = path.split("/").at(-1)!;
      for (const list of Object.values(state.sessions)) {
        const session = list.find((item) => item.id === sessionId);
        if (session) Object.assign(session, body);
      }
      return { data: body };
    }
    if (method === "PATCH" && path.startsWith("/api/v1/projects/")) {
      const projectId = path.split("/").at(-1)!;
      const project = state.projects.find((item) => item.id === projectId);
      if (project) Object.assign(project, body);
      return { data: body };
    }
    if (method === "DELETE" && path.startsWith("/api/v1/projects/")) {
      const projectId = path.split("/").at(-1)!;
      state.projects = state.projects.filter((item) => item.id !== projectId);
      delete state.sessions[projectId];
      return { data: {} };
    }
    if (path === "/api/v1/projects") return { data: state.projects };
    if (sessionsPath) return { data: (state.sessions[sessionsPath[1]!] ?? []).filter((session: Json) => session.status !== "archived") };
    return { data: {} };
  });
  return api;
}

function setup(initial?: { projects: Json[]; sessions: Record<string, Json[]> }) {
  const elements = buildElements();
  const api = fakeApi(initial ?? { projects: [], sessions: {} });
  const bridge = { chooseFolder: vi.fn(async () => undefined), openPath: vi.fn(async () => {}) };
  const calls = {
    sidebar: {
      ensureExpanded: vi.fn(),
      hasExpandedProjects: vi.fn(() => false),
      markSessionRead: vi.fn(),
      removeProjectState: vi.fn(),
    },
    showToast: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
    closePopovers: vi.fn(),
    showConversationWorkspace: vi.fn(),
    leaveNewChat: vi.fn(),
    renderTree: vi.fn(),
    refreshComposerState: vi.fn(),
    rememberLocation: vi.fn(),
    onStartNewChat: vi.fn(),
    onSessionSelected: vi.fn(async () => {}),
    onNoSession: vi.fn(async () => {}),
  };
  const controller = new ProjectsController({ api, bridge, elements, ...calls } satisfies ProjectsOptions);
  return { controller, elements, api, bridge, calls };
}

beforeEach(() => document.body.replaceChildren());

describe("ProjectsController", () => {
  it("loads projects with their sessions and selects the first project and session", async () => {
    const { controller, calls } = setup({
      projects: [
        { id: "project-a", name: "Alpha", rootPath: "/alpha" },
        { id: "project-b", name: "Beta" },
      ],
      sessions: {
        "project-a": [{ id: "session-a1", title: "First" }, { id: "session-a2", title: "Second" }],
        "project-b": [{ id: "session-b1", title: "Only" }],
      },
    });

    await controller.load();

    expect(controller.projects).toHaveLength(2);
    expect(controller.currentProjectId).toBe("project-a");
    expect(controller.currentSessionId).toBe("session-a1");
    expect(controller.activeProject()?.name).toBe("Alpha");
    expect(controller.currentSessionRecord()?.title).toBe("First");
    expect(calls.sidebar.ensureExpanded).toHaveBeenCalledWith("project-a");
    expect(calls.renderTree).toHaveBeenCalled();
    expect(calls.onSessionSelected).toHaveBeenCalledWith("session-a1");
  });

  it("lands on the project itself when it has no sessions", async () => {
    const { controller, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [] },
    });

    await controller.load();

    expect(controller.currentProjectId).toBe("project-a");
    expect(controller.currentSessionId).toBeUndefined();
    expect(calls.onNoSession).toHaveBeenCalledOnce();
    expect(calls.onSessionSelected).not.toHaveBeenCalled();
  });

  it("selects a project and remembers the conversation location when it has no sessions", async () => {
    const { controller, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [] },
    });
    await controller.load();

    await controller.selectProject("project-a");

    expect(calls.leaveNewChat).toHaveBeenCalled();
    expect(calls.showConversationWorkspace).toHaveBeenCalled();
    expect(calls.rememberLocation).toHaveBeenCalledWith({ view: "conversation", projectId: "project-a" });
    expect(calls.onNoSession).toHaveBeenCalledTimes(2);
  });

  it("creates a project and starts a new chat when one was pending", async () => {
    const { controller, elements, api, calls } = setup();

    controller.openProjectDialog(true);
    expect(elements.projectDialog.hasAttribute("open")).toBe(true);

    elements.projectName.value = "My Project";
    elements.projectRootPath.value = "/home/user/my-project";
    await controller.createProject();

    expect(api).toHaveBeenCalledWith("/api/v1/projects", "POST", { name: "My Project", rootPath: "/home/user/my-project" });
    expect(elements.projectDialog.hasAttribute("open")).toBe(false);
    expect(calls.showToast).toHaveBeenCalledWith("Created My Project");
    expect(calls.onStartNewChat).toHaveBeenCalledOnce();
    expect(controller.currentProjectId).toBe("project-new");
    expect(controller.activeProject()?.name).toBe("My Project");
  });

  it("fills the task dialog project select and opens it", async () => {
    const { controller, elements } = setup({
      projects: [{ id: "project-a", name: "Alpha" }, { id: "project-b", name: "Beta" }],
      sessions: { "project-a": [], "project-b": [] },
    });
    await controller.load();

    controller.openTaskDialog();

    expect(elements.taskProject.options).toHaveLength(2);
    expect(elements.taskProject.value).toBe("project-a");
    expect(elements.taskDialog.hasAttribute("open")).toBe(true);
  });

  it("creates a session in the chosen project and selects it", async () => {
    const { controller, elements, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [] },
    });
    await controller.load();

    elements.taskProject.add(new Option("Alpha", "project-a", false, true));
    elements.taskName.value = "New chat";
    await controller.createSession();

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a/sessions", "POST", { title: "New chat", routeId: "default" });
    expect(controller.currentSessionId).toBe("session-new");
    expect(controller.sessionsByProject.get("project-a")?.[0]?.title).toBe("New chat");
    expect(elements.taskDialog.hasAttribute("open")).toBe(false);
    expect(calls.showToast).toHaveBeenCalledWith("Started New chat");
  });

  it("renames the current session through the shared dialog", async () => {
    const { controller, elements, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Old title" }] },
    });
    await controller.load();

    controller.openRenameDialog();
    expect(elements.renameHeading.textContent).toBe("Rename chat");
    expect(elements.renameLabel.textContent).toBe("Chat title");
    expect(elements.renameTaskName.value).toBe("Old title");
    expect(elements.renameDialog.hasAttribute("open")).toBe(true);

    elements.renameTaskName.value = "Renamed title";
    await controller.renameCurrentTask();

    expect(api).toHaveBeenCalledWith("/api/v1/sessions/session-1", "PATCH", { title: "Renamed title" });
    expect(elements.renameDialog.hasAttribute("open")).toBe(false);
    expect(calls.showToast).toHaveBeenCalledWith("Renamed to Renamed title");
    expect(controller.currentSessionRecord()?.title).toBe("Renamed title");
  });

  it("renames a project through the same dialog", async () => {
    const { controller, elements, api } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [] },
    });
    await controller.load();

    controller.openProjectRenameDialog("project-a");
    expect(elements.renameHeading.textContent).toBe("Rename project");
    expect(elements.renameTaskName.value).toBe("Alpha");

    elements.renameTaskName.value = "Alpha Plus";
    await controller.renameCurrentTask();

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a", "PATCH", { name: "Alpha Plus" });
    expect(controller.activeProject()?.name).toBe("Alpha Plus");
  });

  it("archives the current session and lands on the project", async () => {
    const { controller, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Old chat" }] },
    });
    await controller.load();

    await controller.archiveCurrentTask();

    expect(api).toHaveBeenCalledWith("/api/v1/sessions/session-1", "PATCH", { status: "archived" });
    expect(controller.currentSessionId).toBeUndefined();
    expect(calls.showToast).toHaveBeenCalledWith("Archived Old chat");
    expect(calls.onNoSession).toHaveBeenCalled();
  });

  it("removes a project and clears its sidebar state", async () => {
    const { controller, elements, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Chat" }] },
    });
    await controller.load();

    controller.openRemoveProjectDialog("project-a");
    expect(elements.removeProjectName.textContent).toBe("Alpha");
    expect(elements.removeProjectDialog.hasAttribute("open")).toBe(true);

    await controller.removeProject();

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a", "DELETE");
    expect(calls.sidebar.removeProjectState).toHaveBeenCalledWith("project-a");
    expect(elements.removeProjectDialog.hasAttribute("open")).toBe(false);
    expect(controller.currentProjectId).toBeUndefined();
    expect(calls.showToast).toHaveBeenCalledWith("Project removed");
  });

  it("creates a continuation chat for a session", async () => {
    const { controller, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Chat" }] },
    });
    await controller.load();

    await controller.continueInNewChat({ id: "session-1", title: "Chat" }, "project-a");

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a/sessions", "POST", { title: "Continue: Chat" });
    expect(controller.currentSessionId).toBe("session-new");
    expect(calls.showToast).toHaveBeenCalledWith("Created continuation chat");
  });

  it("registers a composer-created session in the current project", async () => {
    const { controller, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [] },
    });
    await controller.load();

    controller.startSessionInProject("project-a", { id: "session-new", title: "New" });

    expect(controller.currentSessionId).toBe("session-new");
    expect(controller.sessionsByProject.get("project-a")?.[0]?.id).toBe("session-new");
    expect(calls.renderTree).toHaveBeenCalled();
  });

  it("fills the project dialog from a chosen folder", async () => {
    const { controller, elements, bridge } = setup();
    bridge.chooseFolder.mockResolvedValue("/home/user/my-app");

    await controller.selectProjectFolder();

    expect(elements.projectRootPath.value).toBe("/home/user/my-app");
    expect(elements.projectFolderLabel.textContent).toBe("/home/user/my-app");
    expect(elements.chooseProjectFolder.classList.contains("has-folder")).toBe(true);
    expect(elements.projectName.value).toBe("my-app");
  });

  it("updates a project's source folder through the bridge", async () => {
    const { controller, bridge, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Chat" }] },
    });
    await controller.load();
    bridge.chooseFolder.mockResolvedValue("/new/path");

    await controller.editProjectFolder("project-a");

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a", "PATCH", { rootPath: "/new/path" });
    expect(calls.showToast).toHaveBeenCalledWith("Source folder updated");
  });

  it("opens a project path through the bridge", async () => {
    const { controller, bridge } = setup();

    await controller.openProjectPath("/home/user/project");

    expect(bridge.openPath).toHaveBeenCalledWith("/home/user/project");
  });
});
