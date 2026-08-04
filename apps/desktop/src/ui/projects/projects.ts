import type { ProjectSidebarProject, ProjectSidebarSession } from "../sidebar/project-sidebar.js";

type Json = Record<string, any>;

export type ProjectsApi = (path: string, method?: string, body?: unknown) => Promise<Json>;

export interface ProjectsBridge {
  chooseFolder(): Promise<string | undefined>;
  openPath(path: string): Promise<void>;
}

export type ProjectRecord = ProjectSidebarProject & Json;
export type SessionRecord = ProjectSidebarSession & Json;

export interface ProjectsElements {
  projectDialog: HTMLDialogElement;
  projectForm: HTMLFormElement;
  projectName: HTMLInputElement;
  projectRootPath: HTMLInputElement;
  projectFolderLabel: HTMLElement;
  chooseProjectFolder: HTMLButtonElement;
  taskDialog: HTMLDialogElement;
  taskForm: HTMLFormElement;
  taskProject: HTMLSelectElement;
  taskName: HTMLInputElement;
  renameDialog: HTMLDialogElement;
  renameForm: HTMLFormElement;
  renameTaskName: HTMLInputElement;
  renameHeading: HTMLElement;
  renameLabel: HTMLElement;
  removeProjectDialog: HTMLDialogElement;
  removeProjectForm: HTMLFormElement;
  removeProjectName: HTMLElement;
}

/** Sidebar collaborators the controller drives while mutating project state. */
export interface ProjectsSidebarView {
  ensureExpanded(projectId: string): void;
  hasExpandedProjects(): boolean;
  markSessionRead(sessionId: string): void;
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
  elements: ProjectsElements;
  sidebar: ProjectsSidebarView;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
  closePopovers: () => void;
  showConversationWorkspace: () => void;
  leaveNewChat: () => void;
  renderTree: () => void;
  refreshComposerState: () => void;
  rememberLocation: (location: ConversationLocation) => void;
  onStartNewChat: () => void;
  onSessionSelected: (sessionId: string) => Promise<void>;
  onNoSession: () => Promise<void>;
}

/**
 * Owns project and session state plus the CRUD dialogs: loading the project
 * tree, creating/renaming/archiving/removing projects and sessions, and
 * resolving the active selection. Rendering is delegated through callbacks so
 * the conversation view and sidebar stay renderer-side.
 */
export class ProjectsController {
  readonly elements: ProjectsElements;
  private readonly options: ProjectsOptions;
  private records: ProjectRecord[] = [];
  private readonly sessions = new Map<string, SessionRecord[]>();
  private currentProjectIdValue: string | undefined;
  private currentSessionIdValue: string | undefined;
  private pendingTaskAfterProject = false;
  private removeProjectTarget: string | undefined;
  private renameTarget: { kind: "project" | "task"; id: string } | undefined;

  constructor(options: ProjectsOptions) {
    this.options = options;
    this.elements = options.elements;
  }

  get projects(): ProjectRecord[] { return this.records; }
  get sessionsByProject(): Map<string, SessionRecord[]> { return this.sessions; }
  get currentProjectId(): string | undefined { return this.currentProjectIdValue; }
  get currentSessionId(): string | undefined { return this.currentSessionIdValue; }

  activeProject(): ProjectRecord | undefined {
    return this.records.find((project) => project.id === this.currentProjectIdValue);
  }

  currentSessionRecord(): SessionRecord | undefined {
    if (!this.currentProjectIdValue) return undefined;
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

    if (preferredProject && this.records.some((project) => project.id === preferredProject)) this.currentProjectIdValue = preferredProject;
    else if (!this.currentProjectIdValue || !this.records.some((project) => project.id === this.currentProjectIdValue)) this.currentProjectIdValue = this.records[0]?.id;
    if (this.currentProjectIdValue && !this.options.sidebar.hasExpandedProjects()) this.options.sidebar.ensureExpanded(this.currentProjectIdValue);

    if (preferredSession) this.currentSessionIdValue = preferredSession;
    const selectedSessions = this.currentProjectIdValue ? this.sessions.get(this.currentProjectIdValue) ?? [] : [];
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
      this.options.rememberLocation({ view: "conversation", projectId: id });
    }
    this.options.refreshComposerState();
  }

  /** Selects a session and asks the renderer to draw its transcript. */
  async selectSession(id: string, rerender = true, projectId?: string): Promise<void> {
    this.options.leaveNewChat();
    this.options.showConversationWorkspace();
    if (projectId) this.currentProjectIdValue = projectId;
    if (this.currentProjectIdValue) this.options.sidebar.ensureExpanded(this.currentProjectIdValue);
    this.currentSessionIdValue = id;
    this.options.sidebar.markSessionRead(id);
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

  openProjectDialog(afterCreateTask = false): void {
    this.options.showConversationWorkspace();
    this.pendingTaskAfterProject = afterCreateTask;
    this.elements.projectForm.reset();
    this.elements.projectRootPath.value = "";
    this.elements.projectFolderLabel.textContent = "Add a folder Fitz can read and edit";
    this.elements.chooseProjectFolder.classList.remove("has-folder");
    this.elements.projectDialog.showModal();
    this.elements.projectName.focus();
  }

  openTaskDialog(): void {
    this.options.showConversationWorkspace();
    if (this.records.length === 0) { this.openProjectDialog(true); return; }
    this.elements.taskForm.reset();
    this.elements.taskProject.replaceChildren();
    for (const project of this.records) this.elements.taskProject.add(new Option(project.name, project.id, false, project.id === this.currentProjectIdValue));
    this.elements.taskDialog.showModal();
    this.elements.taskName.focus();
  }

  async createProject(): Promise<void> {
    const name = this.elements.projectName.value.trim();
    if (!name) return;
    setFormBusy(this.elements.projectForm, true);
    try {
      const response = await this.options.api("/api/v1/projects", "POST", { name, ...(this.elements.projectRootPath.value ? { rootPath: this.elements.projectRootPath.value } : {}) });
      this.elements.projectDialog.close();
      await this.load(response.data.id);
      this.options.showToast(`Created ${name}`);
      if (this.pendingTaskAfterProject) { this.pendingTaskAfterProject = false; this.options.onStartNewChat(); }
    } catch (error) {
      this.options.showToast(this.options.errorMessage(error));
    } finally {
      setFormBusy(this.elements.projectForm, false);
    }
  }

  async createSession(): Promise<void> {
    const projectId = this.elements.taskProject.value;
    const title = this.elements.taskName.value.trim();
    if (!projectId || !title) return;
    setFormBusy(this.elements.taskForm, true);
    try {
      const response = await this.options.api(`/api/v1/projects/${projectId}/sessions`, "POST", { title, routeId: "default" });
      this.elements.taskDialog.close();
      await this.load(projectId, response.data.id);
      this.options.showToast(`Started ${title}`);
    } catch (error) {
      this.options.showToast(this.options.errorMessage(error));
    } finally {
      setFormBusy(this.elements.taskForm, false);
    }
  }

  async selectProjectFolder(): Promise<void> {
    const folder = await this.options.bridge.chooseFolder();
    if (!folder) return;
    this.elements.projectRootPath.value = folder;
    this.elements.projectFolderLabel.textContent = folder;
    this.elements.chooseProjectFolder.classList.add("has-folder");
    if (!this.elements.projectName.value.trim()) this.elements.projectName.value = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";
  }

  openRenameDialog(): void {
    this.options.closePopovers();
    const session = this.currentSessionRecord();
    if (!session) return;
    this.renameTarget = { kind: "task", id: session.id };
    this.elements.renameHeading.textContent = "Rename chat";
    this.elements.renameLabel.textContent = "Chat title";
    this.elements.renameTaskName.value = session.title;
    this.elements.renameDialog.showModal();
    this.elements.renameTaskName.select();
  }

  openProjectRenameDialog(id: string): void {
    this.options.closePopovers();
    const project = this.records.find((item) => item.id === id);
    if (!project) return;
    this.renameTarget = { kind: "project", id };
    this.elements.renameHeading.textContent = "Rename project";
    this.elements.renameLabel.textContent = "Project name";
    this.elements.renameTaskName.value = project.name;
    this.elements.renameDialog.showModal();
    this.elements.renameTaskName.select();
  }

  async renameCurrentTask(): Promise<void> {
    const title = this.elements.renameTaskName.value.trim();
    if (!this.renameTarget || !title) return;
    setFormBusy(this.elements.renameForm, true);
    try {
      const path = this.renameTarget.kind === "project" ? `/api/v1/projects/${this.renameTarget.id}` : `/api/v1/sessions/${this.renameTarget.id}`;
      const preferredProject = this.renameTarget.kind === "project" ? this.renameTarget.id : this.currentProjectIdValue;
      const preferredSession = this.renameTarget.kind === "task" ? this.renameTarget.id : this.currentSessionIdValue;
      await this.options.api(path, "PATCH", { [this.renameTarget.kind === "project" ? "name" : "title"]: title });
      this.elements.renameDialog.close();
      await this.load(preferredProject, preferredSession);
      this.options.showToast(`Renamed to ${title}`);
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.renameForm, false); }
  }

  async archiveCurrentTask(): Promise<void> {
    this.options.closePopovers();
    const session = this.currentSessionRecord();
    if (!session || !this.currentProjectIdValue) return;
    try {
      await this.options.api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" });
      this.currentSessionIdValue = undefined;
      await this.load(this.currentProjectIdValue);
      this.options.showToast(`Archived ${session.title}`);
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }

  async editProjectFolder(id: string): Promise<void> {
    const folder = await this.options.bridge.chooseFolder();
    if (!folder) return;
    try {
      await this.options.api(`/api/v1/projects/${id}`, "PATCH", { rootPath: folder });
      await this.load(id, this.currentSessionIdValue);
      this.options.showToast("Source folder updated");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }

  openRemoveProjectDialog(id: string): void {
    const project = this.records.find((item) => item.id === id);
    if (!project) return;
    this.removeProjectTarget = id;
    this.elements.removeProjectName.textContent = project.name;
    this.elements.removeProjectDialog.showModal();
  }

  async removeProject(): Promise<void> {
    if (!this.removeProjectTarget) return;
    const id = this.removeProjectTarget;
    setFormBusy(this.elements.removeProjectForm, true);
    try {
      await this.options.api(`/api/v1/projects/${id}`, "DELETE");
      this.options.sidebar.removeProjectState(id);
      this.elements.removeProjectDialog.close();
      this.removeProjectTarget = undefined;
      this.currentProjectIdValue = this.currentProjectIdValue === id ? undefined : this.currentProjectIdValue;
      this.currentSessionIdValue = undefined;
      await this.load(this.currentProjectIdValue);
      this.options.showToast("Project removed");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.removeProjectForm, false); }
  }

  async openProjectPath(path: string): Promise<void> {
    try { await this.options.bridge.openPath(path); } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }

  async archiveProjectChats(id: string): Promise<void> {
    const active = this.sessions.get(id) ?? [];
    try {
      await Promise.all(active.map((session) => this.options.api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" })));
      this.currentSessionIdValue = undefined;
      await this.load(id);
      this.options.showToast(`Archived ${active.length} chat${active.length === 1 ? "" : "s"}`);
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }

  async continueInNewChat(session: ProjectSidebarSession, projectId?: string): Promise<void> {
    if (projectId) this.currentProjectIdValue = projectId;
    if (!this.currentProjectIdValue) return;
    try {
      const response = await this.options.api(`/api/v1/projects/${this.currentProjectIdValue}/sessions`, "POST", { title: `Continue: ${session.title}` });
      await this.load(this.currentProjectIdValue, response.data.id);
      this.options.showToast("Created continuation chat");
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
  }
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}
