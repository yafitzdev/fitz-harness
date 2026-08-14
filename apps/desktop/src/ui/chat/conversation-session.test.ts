// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ConversationSessionController, type ConversationSessionOptions } from "./conversation-session.js";

function harness() {
  let currentSessionId: string | undefined;
  let currentProjectId: string | undefined = "project-1";
  const projects = {
    get currentSessionId() { return currentSessionId; },
    get currentProjectId() { return currentProjectId; },
    projects: [{ id: "project-1" }],
    activeProject: () => ({ name: "Fitz" }),
    currentSessionRecord: () => ({ routeId: "smart" }),
    setCurrentProject: vi.fn((id: string | undefined) => { currentProjectId = id; }),
    beginNewChat: vi.fn(() => { currentSessionId = undefined; }),
    startSessionInProject: vi.fn((_projectId: string, session: Record<string, any>) => { currentSessionId = session.id; }),
    startChat: vi.fn((session: Record<string, any>) => { currentSessionId = session.id; }),
  };
  const api = vi.fn(async (path: string) => {
    if (path === "/api/v1/chats") return { data: { id: "session-1" } };
    return { data: [] };
  });
  const options: ConversationSessionOptions = {
    api,
    projects,
    sidebar: { ensureExpanded: vi.fn(), beginCreateProject: vi.fn() },
    workspace: document.createElement("main"),
    messages: document.createElement("section"),
    composer: {
      resetContextStatus: vi.fn(), resetForNewChat: vi.fn(), setRoute: vi.fn(), enterNewChat: vi.fn(), exitNewChat: vi.fn(),
      refreshBranches: vi.fn(async () => {}), focus: vi.fn(),
    },
    inspector: { reset: vi.fn(), setChat: vi.fn() },
    context: { reset: vi.fn(), restore: vi.fn(), refresh: vi.fn() },
    transcript: { restore: vi.fn(() => 0), eventSequenceForRun: vi.fn(() => 0) },
    runs: { active: () => false, detach: vi.fn(), attach: vi.fn() },
    recovery: { clear: vi.fn(), show: vi.fn() },
    assistantPerformance: { reset: vi.fn() },
    mediaJobs: { reset: vi.fn(), watch: vi.fn(), failureMessage: vi.fn(async () => "failed") },
    mediaFeed: { reset: vi.fn(), render: vi.fn() },
    activity: { appendApproval: vi.fn(), finishWork: vi.fn() },
    artifacts: { load: vi.fn(async () => []) },
    showConversation: vi.fn(), showStatus: vi.fn(), errorMessage: (error) => String(error),
    renderTree: vi.fn(), showNewChatLanding: vi.fn(), showLanding: vi.fn(), prepareNewChat: vi.fn(),
    refreshControls: vi.fn(), resetWarmup: vi.fn(), remember: vi.fn(),
    loadingMessage: (text) => Object.assign(document.createElement("p"), { textContent: text }),
    appendSystem: vi.fn(),
  };
  return { controller: new ConversationSessionController(options), options, projects, setSessionId: (id: string | undefined) => { currentSessionId = id; } };
}

describe("ConversationSessionController", () => {
  it("owns new-chat entry and first-session materialization", async () => {
    const { controller, options, projects } = harness();
    controller.beginNewChat(false);
    expect(controller.newChat).toBe(true);
    expect(projects.setCurrentProject).toHaveBeenCalledWith(undefined);
    expect(options.workspace.classList.contains("new-chat-open")).toBe(true);
    expect(options.composer.focus).not.toHaveBeenCalled();
    expect(options.composer.resetForNewChat).toHaveBeenCalledOnce();
    expect(options.remember).toHaveBeenCalledWith({ view: "conversation", path: ["new"] });

    const sessionId = await controller.ensurePromptSession("Hello", "fast");
    expect(sessionId).toBe("session-1");
    expect(controller.newChat).toBe(false);
    expect(projects.startChat).toHaveBeenCalledWith({ id: "session-1" });
    expect(options.inspector.setChat).toHaveBeenLastCalledWith("session-1");
  });

  it("restores transcript, pending approvals, active run, and media lineage", async () => {
    const { controller, options, setSessionId } = harness();
    setSessionId("session-2");
    vi.mocked(options.api)
      .mockResolvedValueOnce({ data: [{ kind: "message" }], page: {} })
      .mockResolvedValueOnce({ data: [{ id: "approval-1" }] })
      .mockResolvedValueOnce({ data: { id: "run-1", status: "running" } })
      .mockResolvedValueOnce({ data: [{ id: "job-1", modality: "image", status: "completed" }] });
    vi.mocked(options.transcript.restore).mockReturnValue(42);

    await controller.selectSession("session-2");

    expect(options.context.restore).toHaveBeenCalledWith(42);
    expect(options.activity.appendApproval).toHaveBeenCalledWith({ id: "approval-1" });
    expect(options.runs.attach).toHaveBeenCalledWith({ id: "run-1", status: "running" }, 0);
    expect(options.mediaFeed.render).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }), undefined, undefined);
    expect(options.remember).toHaveBeenCalledWith({ view: "conversation", path: ["session", "session-2"], context: { projectId: "project-1" } });
  });
});
