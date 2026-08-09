import type { ProjectSidebarProject, ProjectSidebarSession } from "../sidebar/project-sidebar.js";
import type { ActionFeedback } from "../primitives/action-status.js";

type Json = Record<string, any>;

export type ProjectsApi = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface ProjectsBridge {
  openPath(path: string): Promise<void>;
}

export type ProjectRecord = ProjectSidebarProject & Json;
export type SessionRecord = ProjectSidebarSession & Json;

/** Sidebar collaborators the controller drives while mutating project state. */
export interface ProjectsSidebarView {
  ensureExpanded(projectId: string): void;
  hasExpandedProjects(): boolean;
  removeProjectState(projectId: string): void;
}

/** A conversation-scoped navigation entry the controller can remember. */
export interface ConversationLocation {
  view: "conversation";
  projectId?: string;
  sessionId?: string;
  newChat?: boolean;
}

export interface ProjectsOptions {
  api: ProjectsApi;
  bridge: ProjectsBridge;
  sidebar: ProjectsSidebarView;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  closePopovers: () => void;
  showConversationWorkspace: () => void;
  leaveNewChat: () => void;
  renderTree: () => void;
  refreshComposerState: () => void;
  rememberLocation: (location: ConversationLocation) => void;
  onSessionSelected: (sessionId: string) => Promise<void>;
  onNoSession: () => Promise<void>;
}

/**
 * Owns project and session state plus the CRUD mutations: loading the project
 * tree, creating/renaming/archiving/removing projects and sessions, and
 * resolving the active selection. Rendering is delegated through callbacks so
 * the conversation view and sidebar stay renderer-side.
 */
export class ProjectsController {
  private readonly options: ProjectsOptions;
  private records: ProjectRecord[] = [];
  private readonly sessions = new Map<string, SessionRecord[]>();
  private chatRecords: SessionRecord[] = [];
  private currentProjectIdValue: string | undefined;
  private currentSessionIdValue: string | undefined;

  constructor(options: ProjectsOptions) {
    this.options = options;
  }

  get projects(): ProjectRecord[] { return this.records; }
  get sessionsByProject(): Map<string, SessionRecord[]> { return this.sessions; }
  get chats(): SessionRecord[] { return this.chatRecords; }
  get currentProjectId(): string | undefined { return this.currentProjectIdValue; }
  get currentSessionId(): string | undefined { return this.currentSessionIdValue; }

  activeProject(): ProjectRecord | undefined {
    return this.records.find((project) => project.id === this.currentProjectIdValue);
  }

  currentSessionRecord(): SessionRecord | undefined {
    if (!this.currentProjectIdValue) return this.chatRecords.find((chat) => chat.id === this.currentSessionIdValue);
    return (this.sessions.get(this.currentProjectIdValue) ?? []).find((session) => session.id === this.currentSessionIdValue);
  }

  setCurrentProject(projectId: string | undefined): void { this.currentProjectIdValue = projectId; }
  setCurrentSession(sessionId: string | undefined): void { this.currentSessionIdValue = sessionId; }
  beginNewChat(): void { this.currentSessionIdValue = undefined; }

  /** Fetches projects and their sessions, resolves the active selection, and renders. */
  async load(preferredProject?: string, preferredSession?: string): Promise<void> {
    const response = await this.options.api("/api/v1/projects");
    this.records = response.data ?? [];
    this.sessions.clear();
    await Promise.all(this.records.map(async (project) => {
      const sessions = await this.options.api(`/api/v1/projects/${project.id}/sessions`);
      this.sessions.set(project.id, (sessions.data ?? []).filter((session: Json) => session.status !== "archived"));
    }));
    const chatsResponse = await this.options.api("/api/v1/chats");
    this.chatRecords = (chatsResponse.data ?? []).filter((session: Json) => session.status !== "archived");

    if (preferredProject && this.records.some((project) => project.id === preferredProject)) this.currentProjectIdValue = preferredProject;
    else if (this.currentProjectIdValue === undefined) {
      // No project selected. Keep a valid standalone-chat selection (e.g. while
      // renaming or archiving a chat); otherwise prefer the first project, and
      // fall back to standalone chats only when no projects exist.
      if (!(this.currentSessionIdValue && this.chatRecords.some((chat) => chat.id === this.currentSessionIdValue))) this.currentProjectIdValue = this.records[0]?.id;
    } else if (!this.records.some((project) => project.id === this.currentProjectIdValue)) {
      this.currentProjectIdValue = this.records[0]?.id;
    }
    if (this.currentProjectIdValue && !this.options.sidebar.hasExpandedProjects()) this.options.sidebar.ensureExpanded(this.currentProjectIdValue);

    if (preferredSession) this.currentSessionIdValue = preferredSession;
    const selectedSessions = this.currentProjectIdValue ? (this.sessions.get(this.currentProjectIdValue) ?? []) : this.chatRecords;
    if (!this.currentSessionIdValue || !selectedSessions.some((session) => session.id === this.currentSessionIdValue)) this.currentSessionIdValue = selectedSessions[0]?.id;

    this.options.renderTree();
    if (this.currentSessionIdValue) await this.selectSession(this.currentSessionIdValue, false);
    else await this.options.onNoSession();
  }

  /** Selects a project and its first session (or the project landing). */
  async selectProject(id: string): Promise<void> {
    this.options.showConversationWorkspace();
    this.options.leaveNewChat();
    this.currentProjectIdValue = id;
    this.options.sidebar.ensureExpanded(id);
    const projectSessions = this.sessions.get(id) ?? [];
    this.currentSessionIdValue = projectSessions[0]?.id;
    this.options.renderTree();
    if (this.currentSessionIdValue) await this.selectSession(this.currentSessionIdValue, false);
    else {
      await this.options.onNoSession();
      this.options.rememberLocation({ view: "conversation", projectId: id, newChat: true });
    }
    this.options.refreshComposerState();
  }

  /** Selects a session and asks the renderer to draw its transcript. */
  async selectSession(id: string, rerender = true, projectId?: string): Promise<void> {
    this.options.leaveNewChat();
    this.options.showConversationWorkspace();
    if (projectId) this.currentProjectIdValue = projectId;
    else if (this.chatRecords.some((chat) => chat.id === id)) this.currentProjectIdValue = undefined;
    if (this.currentProjectIdValue) this.options.sidebar.ensureExpanded(this.currentProjectIdValue);
    this.currentSessionIdValue = id;
    if (rerender) this.options.renderTree();
    await this.options.onSessionSelected(id);
  }

  /** Registers a freshly created session (from the composer) in the current project. */
  startSessionInProject(projectId: string, session: SessionRecord): void {
    const sessions = this.sessions.get(projectId) ?? [];
    sessions.unshift(session);
    this.sessions.set(projectId, sessions);
    this.currentSessionIdValue = session.id;
    this.options.renderTree();
  }

  /** Registers a freshly created standalone chat (no project attached). */
  startChat(session: SessionRecord): void {
    this.chatRecords.unshift(session);
    this.currentProjectIdValue = undefined;
    this.currentSessionIdValue = session.id;
    this.options.renderTree();
  }

  /** Creates a project and loads it; resolves true on success so callers can chain a follow-up action. */
  async createProject(name: string, rootPath?: string): Promise<boolean> {
    if (!name) return false;
    try {
      const response = await this.options.api("/api/v1/projects", "POST", { name, ...(rootPath ? { rootPath } : {}) });
      await this.load(response.data.id);
      this.options.showStatus(`Created ${name}`, "success");
      return true;
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
      return false;
    }
  }

  /** Renames a session and reloads it into the tree. */
  async renameSession(id: string, projectId: string | undefined, title: string): Promise<void> {
    try {
      await this.options.api(`/api/v1/sessions/${id}`, "PATCH", { title });
      await this.load(projectId, id);
      this.options.showStatus(`Renamed to ${title}`, "success");
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  /** Renames a project and reloads it, keeping the active session when it belongs to the project. */
  async renameProject(id: string, name: string): Promise<void> {
    try {
      await this.options.api(`/api/v1/projects/${id}`, "PATCH", { name });
      await this.load(id, this.currentSessionIdValue);
      this.options.showStatus(`Renamed to ${name}`, "success");
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  /** Deletes a project, clears its sidebar state, and reloads the tree. */
  async removeProject(id: string): Promise<void> {
    try {
      await this.options.api(`/api/v1/projects/${id}`, "DELETE");
      this.options.sidebar.removeProjectState(id);
      this.currentProjectIdValue = this.currentProjectIdValue === id ? undefined : this.currentProjectIdValue;
      this.currentSessionIdValue = undefined;
      await this.load(this.currentProjectIdValue);
      this.options.showStatus("Project removed", "success");
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  async archiveCurrentTask(): Promise<void> {
    this.options.closePopovers();
    const session = this.currentSessionRecord();
    if (!session) return;
    try {
      await this.options.api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" });
      this.currentSessionIdValue = undefined;
      await this.load(this.currentProjectIdValue);
      this.options.showStatus(`Archived ${session.title}`, "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  async openProjectPath(path: string): Promise<void> {
    try { await this.options.bridge.openPath(path); } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  async archiveProjectChats(id: string): Promise<void> {
    const active = this.sessions.get(id) ?? [];
    try {
      await Promise.all(active.map((session) => this.options.api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" })));
      this.currentSessionIdValue = undefined;
      await this.load(id);
      this.options.showStatus(`Archived ${active.length} chat${active.length === 1 ? "" : "s"}`, "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  async continueInNewChat(session: ProjectSidebarSession, projectId?: string): Promise<void> {
    if (projectId) this.currentProjectIdValue = projectId;
    try {
      const response = this.currentProjectIdValue
        ? await this.options.api(`/api/v1/projects/${this.currentProjectIdValue}/sessions`, "POST", { title: `Continue: ${session.title}` })
        : await this.options.api("/api/v1/chats", "POST", { title: `Continue: ${session.title}` });
      await this.load(this.currentProjectIdValue, response.data.id);
      this.options.showStatus("Created continuation chat", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }
}
