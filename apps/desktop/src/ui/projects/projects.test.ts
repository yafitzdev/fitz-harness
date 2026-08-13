// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsController, type ProjectsOptions } from "./projects.js";

type Json = Record<string, any>;

/** A small in-memory host: mutates on POST/PATCH/DELETE so reloads observe changes. */
function fakeApi(initial: { projects: Json[]; sessions: Record<string, Json[]>; chats?: Json[] }) {
  const state = {
    projects: initial.projects.map((project) => ({ ...project })),
    sessions: Object.fromEntries(Object.entries(initial.sessions).map(([projectId, sessions]) => [projectId, sessions.map((session) => ({ ...session }))])),
    chats: (initial.chats ?? []).map((chat) => ({ ...chat })),
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
    if (method === "POST" && path === "/api/v1/chats") {
      const record = { id: "chat-new", ...(body as Json) };
      state.chats.unshift(record);
      return { data: record };
    }
    if (method === "PATCH" && path.startsWith("/api/v1/sessions/")) {
      const sessionId = path.split("/").at(-1)!;
      for (const list of Object.values(state.sessions)) {
        const session = list.find((item) => item.id === sessionId);
        if (session) Object.assign(session, body);
      }
      const chat = state.chats.find((item) => item.id === sessionId);
      if (chat) Object.assign(chat, body);
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
    if (method === "DELETE" && path.startsWith("/api/v1/sessions/")) {
      const sessionId = path.split("/").at(-1)!;
      for (const projectId of Object.keys(state.sessions)) state.sessions[projectId] = state.sessions[projectId]!.filter((session) => session.id !== sessionId);
      state.chats = state.chats.filter((chat) => chat.id !== sessionId);
      return { data: {} };
    }
    if (path === "/api/v1/projects") return { data: state.projects };
    if (sessionsPath) return { data: (state.sessions[sessionsPath[1]!] ?? []).filter((session: Json) => session.status !== "archived") };
    if (path === "/api/v1/chats") return { data: state.chats.filter((chat: Json) => chat.status !== "archived") };
    return { data: {} };
  });
  return api;
}

function setup(initial?: { projects: Json[]; sessions: Record<string, Json[]>; chats?: Json[] }, apiOverride?: ProjectsOptions["api"]) {
  const api = apiOverride ? vi.fn(apiOverride) : fakeApi(initial ?? { projects: [], sessions: {} });
  const bridge = { openPath: vi.fn(async () => {}) };
  const calls = {
    sidebar: {
      ensureExpanded: vi.fn(),
      hasExpandedProjects: vi.fn(() => false),
      removeProjectState: vi.fn(),
    },
    showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
    closePopovers: vi.fn(),
    showConversationWorkspace: vi.fn(),
    leaveNewChat: vi.fn(),
    renderTree: vi.fn(),
    refreshComposerState: vi.fn(),
    rememberLocation: vi.fn(),
    onSessionSelected: vi.fn(async () => {}),
    onNoSession: vi.fn(async () => {}),
  };
  const controller = new ProjectsController({ api, bridge, ...calls } satisfies ProjectsOptions);
  return { controller, api, bridge, calls };
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

  it("commits only the newest overlapping project-tree load", async () => {
    let resolveOld: ((value: Json) => void) | undefined;
    const oldProjects = new Promise<Json>((resolve) => { resolveOld = resolve; });
    let projectRequests = 0;
    const api: ProjectsOptions["api"] = async (path) => {
      if (path === "/api/v1/projects") {
        projectRequests += 1;
        return projectRequests === 1
          ? oldProjects
          : { data: [{ id: "project-new", name: "Current" }] };
      }
      if (path === "/api/v1/projects/project-new/sessions") return { data: [{ id: "session-new", title: "Current task" }] };
      if (path === "/api/v1/projects/project-old/sessions") return { data: [{ id: "session-old", title: "Stale task" }] };
      if (path === "/api/v1/chats") return { data: [] };
      return { data: [] };
    };
    const { controller, calls } = setup(undefined, api);
    const staleLoad = controller.load();
    await Promise.resolve();

    await controller.load();
    resolveOld?.({ data: [{ id: "project-old", name: "Stale" }] });
    await staleLoad;

    expect(controller.projects.map((project) => project.id)).toEqual(["project-new"]);
    expect(controller.sessionsByProject.get("project-new")?.[0]?.id).toBe("session-new");
    expect(controller.sessionsByProject.has("project-old")).toBe(false);
    expect(controller.currentSessionId).toBe("session-new");
    expect(calls.onSessionSelected).toHaveBeenCalledTimes(1);
    expect(calls.onSessionSelected).toHaveBeenCalledWith("session-new");
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
    expect(calls.rememberLocation).toHaveBeenCalledWith({ view: "conversation", path: ["new"], context: { projectId: "project-a" } });
    expect(calls.onNoSession).toHaveBeenCalledTimes(2);
  });

  it("creates a project, resolves true, and selects it", async () => {
    const { controller, api, calls } = setup();

    const created = await controller.createProject("My Project", "/home/user/my-project");

    expect(created).toBe(true);
    expect(api).toHaveBeenCalledWith("/api/v1/projects", "POST", { name: "My Project", rootPath: "/home/user/my-project" });
    expect(calls.showStatus).toHaveBeenCalledWith("Created My Project", "success");
    expect(controller.currentProjectId).toBe("project-new");
    expect(controller.activeProject()?.name).toBe("My Project");
  });

  it("creates a project without a root path and resolves false on failure", async () => {
    const { controller, api, calls } = setup();
    api.mockRejectedValueOnce(new Error("boom"));

    const created = await controller.createProject("My Project");

    expect(created).toBe(false);
    expect(calls.showStatus).toHaveBeenCalledWith("boom", "error");
  });

  it("renames a session and reloads it into the tree", async () => {
    const { controller, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Old title" }] },
    });
    await controller.load();

    await controller.renameSession("session-1", "project-a", "Renamed title");

    expect(api).toHaveBeenCalledWith("/api/v1/sessions/session-1", "PATCH", { title: "Renamed title" });
    expect(calls.showStatus).toHaveBeenCalledWith("Renamed to Renamed title", "success");
    expect(controller.currentSessionRecord()?.title).toBe("Renamed title");
  });

  it("renames a project and keeps the active selection", async () => {
    const { controller, api } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Chat" }] },
    });
    await controller.load();

    await controller.renameProject("project-a", "Alpha Plus");

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a", "PATCH", { name: "Alpha Plus" });
    expect(controller.activeProject()?.name).toBe("Alpha Plus");
    expect(controller.currentSessionId).toBe("session-1");
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
    expect(calls.showStatus).toHaveBeenCalledWith("Archived Old chat", "success");
    expect(calls.onNoSession).toHaveBeenCalled();
  });

  it("permanently removes a chat and keeps its project selected", async () => {
    const { controller, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Disposable" }, { id: "session-2", title: "Keep" }] },
    });
    await controller.load("project-a", "session-1");

    await controller.removeSession("session-1", "project-a");

    expect(api).toHaveBeenCalledWith("/api/v1/sessions/session-1", "DELETE");
    expect(controller.currentProjectId).toBe("project-a");
    expect(controller.currentSessionId).toBe("session-2");
    expect(calls.showStatus).toHaveBeenCalledWith("Chat removed", "success");
  });

  it("removes a project and clears its sidebar state", async () => {
    const { controller, api, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-1", title: "Chat" }] },
    });
    await controller.load();

    await controller.removeProject("project-a");

    expect(api).toHaveBeenCalledWith("/api/v1/projects/project-a", "DELETE");
    expect(calls.sidebar.removeProjectState).toHaveBeenCalledWith("project-a");
    expect(controller.currentProjectId).toBeUndefined();
    expect(calls.showStatus).toHaveBeenCalledWith("Project removed", "success");
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
    expect(calls.showStatus).toHaveBeenCalledWith("Created continuation chat", "success");
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

  it("opens a project path through the bridge", async () => {
    const { controller, bridge } = setup();

    await controller.openProjectPath("/home/user/project");

    expect(bridge.openPath).toHaveBeenCalledWith("/home/user/project");
  });

  it("loads standalone chats alongside projects, preferring a project for the initial selection", async () => {
    const { controller } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [] },
      chats: [{ id: "chat-1", title: "Standalone" }],
    });

    await controller.load();

    expect(controller.chats).toHaveLength(1);
    expect(controller.chats[0]!.title).toBe("Standalone");
    expect(controller.currentProjectId).toBe("project-a");
  });

  it("selects the first standalone chat when no projects exist", async () => {
    const { controller, calls } = setup({
      projects: [],
      sessions: {},
      chats: [{ id: "chat-1", title: "Standalone" }],
    });

    await controller.load();

    expect(controller.currentProjectId).toBeUndefined();
    expect(controller.currentSessionId).toBe("chat-1");
    expect(calls.onSessionSelected).toHaveBeenCalledWith("chat-1");
  });

  it("selecting a standalone chat clears the current project", async () => {
    const { controller, calls } = setup({
      projects: [{ id: "project-a", name: "Alpha" }],
      sessions: { "project-a": [{ id: "session-a1", title: "First" }] },
      chats: [{ id: "chat-1", title: "Standalone" }],
    });
    await controller.load();

    await controller.selectSession("chat-1", true);

    expect(controller.currentProjectId).toBeUndefined();
    expect(controller.currentSessionId).toBe("chat-1");
    expect(calls.onSessionSelected).toHaveBeenCalledWith("chat-1");
  });

  it("registers a composer-created standalone chat", async () => {
    const { controller, calls } = setup();

    controller.startChat({ id: "chat-new", title: "New chat" });

    expect(controller.chats[0]?.id).toBe("chat-new");
    expect(controller.currentProjectId).toBeUndefined();
    expect(controller.currentSessionId).toBe("chat-new");
    expect(calls.renderTree).toHaveBeenCalled();
  });

  it("archives the current standalone chat and lands on the next chat", async () => {
    const { controller, api, calls } = setup({
      projects: [],
      sessions: {},
      chats: [{ id: "chat-1", title: "Standalone" }, { id: "chat-2", title: "Second" }],
    });
    await controller.load();

    await controller.archiveCurrentTask();

    expect(api).toHaveBeenCalledWith("/api/v1/sessions/chat-1", "PATCH", { status: "archived" });
    expect(controller.currentSessionId).toBe("chat-2");
    expect(calls.showStatus).toHaveBeenCalledWith("Archived Standalone", "success");
  });

  it("creates a continuation standalone chat when no project is attached", async () => {
    const { controller, api, calls } = setup({
      projects: [],
      sessions: {},
      chats: [{ id: "chat-1", title: "Standalone" }],
    });
    await controller.load();

    await controller.continueInNewChat({ id: "chat-1", title: "Standalone" });

    expect(api).toHaveBeenCalledWith("/api/v1/chats", "POST", { title: "Continue: Standalone" });
    expect(controller.currentSessionId).toBe("chat-new");
    expect(calls.showStatus).toHaveBeenCalledWith("Created continuation chat", "success");
  });

  it("renames a standalone chat and reloads it into the Chats tree", async () => {
    const { controller, api } = setup({
      projects: [],
      sessions: {},
      chats: [{ id: "chat-1", title: "Old title" }],
    });
    await controller.load();

    await controller.renameSession("chat-1", undefined, "Renamed title");

    expect(api).toHaveBeenCalledWith("/api/v1/sessions/chat-1", "PATCH", { title: "Renamed title" });
    expect(controller.currentSessionId).toBe("chat-1");
    expect(controller.currentSessionRecord()?.title).toBe("Renamed title");
  });
});
