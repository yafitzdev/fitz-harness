import { ContextMenu } from "../primitives/context-menu.js";
import { requiredElement, svgIcon } from "../primitives/dom.js";

export interface ProjectSidebarProject {
  id: string;
  name: string;
  rootPath?: string;
}

export interface ProjectSidebarSession {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectSidebarState {
  projects: readonly ProjectSidebarProject[];
  sessionsByProject: ReadonlyMap<string, readonly ProjectSidebarSession[]>;
  /** Standalone chats with no project attached (the Chats section). */
  chats: readonly ProjectSidebarSession[];
  currentProjectId: string | undefined;
  currentSessionId: string | undefined;
  newChat: boolean;
}

export interface ProjectSidebarElements {
  pinnedTree: HTMLElement;
  pinnedSection: HTMLElement;
  tree: HTMLElement;
  chatsTree: HTMLElement;
}

export interface ProjectSidebarOptions {
  /** The sidebar tree the controller renders projects and sessions into. */
  mount: HTMLElement;
  /** The flat collection of pinned projects and chats. */
  pinnedMount: HTMLElement;
  /** The section hidden when there are no valid pinned records. */
  pinnedSection: HTMLElement;
  /** The sidebar tree the controller renders standalone chats into. */
  chatsMount: HTMLElement;
  closePopovers: () => void;
  selectProject: (projectId: string) => void;
  selectSession: (sessionId: string, projectId?: string) => void;
  newChat: (projectId: string) => void;
  openProjectPath: (path: string) => void;
  createWorktree: (projectId: string) => void;
  archiveProjectChats: (projectId: string) => void;
  removeProject: (projectId: string) => Promise<void> | void;
  renameSession: (sessionId: string, projectId: string | undefined, title: string) => Promise<void> | void;
  renameProject: (projectId: string, name: string) => Promise<void> | void;
  createProject: (name: string, rootPath: string | undefined) => Promise<void> | void;
  chooseFolder: () => Promise<string | undefined>;
  onError: (error: unknown) => void;
  archiveSession: (sessionId: string, projectId: string | undefined) => void;
  removeSession: (sessionId: string, projectId: string | undefined) => Promise<void> | void;
  copyValue: (value: string, message: string) => void;
  continueSession: (session: ProjectSidebarSession, projectId?: string) => void;
}

interface SidebarEdit {
  kind: "session" | "project";
  id: string;
  projectId: string | undefined;
}

interface CreateProjectDialog {
  backdrop: HTMLElement;
  name: HTMLInputElement;
  folderRow: HTMLElement;
  folderButton: HTMLButtonElement;
  folderLabel: HTMLElement;
  create: HTMLButtonElement;
}

/** Owns the project/session tree, its persistent presentation state, menus, and the create-project dialog. */
export class ProjectSidebarController {
  readonly #options: ProjectSidebarOptions;
  readonly #elements: ProjectSidebarElements;
  readonly #menu: ContextMenu;
  readonly #menuElement: HTMLElement;
  readonly #createDialog: CreateProjectDialog;
  readonly #pinnedProjects = this.#storedSet("fitz-pinned-projects");
  readonly #pinnedSessions = this.#storedSet("fitz-pinned-sessions");
  readonly #expandedProjects = this.#storedSet("fitz-expanded-projects");
  #state: ProjectSidebarState = { projects: [], sessionsByProject: new Map(), chats: [], currentProjectId: undefined, currentSessionId: undefined, newChat: false };
  #editing: SidebarEdit | undefined;
  #creatingProject: { rootPath?: string } | undefined;
  #confirmingRemoval: { projectId: string; name: string } | undefined;

  constructor(options: ProjectSidebarOptions) {
    this.#options = options;
    // The context menu lives at shell level, so its lookup is global rather
    // than scoped to the tree.
    const elements: ProjectSidebarElements = { pinnedTree: options.pinnedMount, pinnedSection: options.pinnedSection, tree: options.mount, chatsTree: options.chatsMount };
    this.#elements = elements;
    this.#menuElement = requiredElement("sidebar-context-menu");
    this.#menu = new ContextMenu(this.#menuElement, options.closePopovers);
    this.#menuElement.addEventListener("click", (event) => event.stopPropagation());
    this.#createDialog = this.#buildCreateDialog();
    document.body.append(this.#createDialog.backdrop);
  }

  render(state: ProjectSidebarState): void {
    this.#state = state;
    this.#renderPinned();
    const chatsTree = this.#elements.chatsTree;
    chatsTree.replaceChildren();
    if (state.chats.length === 0) {
      chatsTree.append(this.#empty("No chats yet"));
    } else {
      for (const chat of state.chats) chatsTree.append(this.#chatItem(chat));
    }

    const tree = this.#elements.tree;
    tree.replaceChildren();
    if (state.projects.length === 0) {
      tree.append(this.#empty("No projects yet"));
      return;
    }

    for (const project of state.projects) {
      if (this.#confirmingRemoval?.projectId === project.id) tree.append(this.#confirmRemoveRow(project));
      else tree.append(this.#projectGroup(project));
    }
  }

  /** Opens the centered create-project dialog (closes it again when already open). */
  beginCreateProject(): void {
    if (this.#creatingProject) { this.#cancelCreate(); return; }
    this.#editing = undefined;
    this.#confirmingRemoval = undefined;
    this.#creatingProject = {};
    this.#options.closePopovers();
    this.#openCreateDialog();
    this.render(this.#state);
  }

  /** Begins inline rename of the currently selected chat (used by the header menu and shortcut). */
  beginRenameCurrentSession(): void {
    const projectId = this.#state.currentProjectId;
    const sessionId = this.#state.currentSessionId;
    if (!sessionId) return;
    const session = projectId
      ? (this.#state.sessionsByProject.get(projectId) ?? []).find((item) => item.id === sessionId)
      : this.#state.chats.find((item) => item.id === sessionId);
    if (session) this.#beginEdit("session", session.id, projectId);
  }

  hasExpandedProjects(): boolean { return this.#expandedProjects.size > 0; }

  ensureExpanded(projectId: string): void {
    if (this.#expandedProjects.has(projectId)) return;
    this.#expandedProjects.add(projectId);
    this.#saveSet("fitz-expanded-projects", this.#expandedProjects);
  }

  removeProjectState(projectId: string): void {
    this.#pinnedProjects.delete(projectId);
    this.#expandedProjects.delete(projectId);
    for (const session of this.#state.sessionsByProject.get(projectId) ?? []) this.#pinnedSessions.delete(session.id);
    this.#saveSet("fitz-pinned-projects", this.#pinnedProjects);
    this.#saveSet("fitz-pinned-sessions", this.#pinnedSessions);
    this.#saveSet("fitz-expanded-projects", this.#expandedProjects);
  }

  hideMenu(): void { this.#menuElement.hidden = true; }

  resetMenuToggles(): void {
    for (const toggle of this.#elements.pinnedTree.querySelectorAll(".tree-menu-toggle")) toggle.setAttribute("aria-expanded", "false");
    for (const toggle of this.#elements.tree.querySelectorAll(".tree-menu-toggle")) toggle.setAttribute("aria-expanded", "false");
    for (const toggle of this.#elements.chatsTree.querySelectorAll(".tree-menu-toggle")) toggle.setAttribute("aria-expanded", "false");
  }

  #renderPinned(): void {
    const pinnedTree = this.#elements.pinnedTree;
    pinnedTree.replaceChildren();
    for (const projectId of this.#pinnedProjects) {
      const project = this.#project(projectId);
      if (project) pinnedTree.append(this.#pinnedProjectItem(project));
    }
    for (const sessionId of this.#pinnedSessions) {
      const standalone = this.#state.chats.find((session) => session.id === sessionId);
      if (standalone) { pinnedTree.append(this.#pinnedSessionItem(standalone)); continue; }
      for (const project of this.#state.projects) {
        const session = (this.#state.sessionsByProject.get(project.id) ?? []).find((candidate) => candidate.id === sessionId);
        if (session) { pinnedTree.append(this.#pinnedSessionItem(session, project)); break; }
      }
    }
    this.#elements.pinnedSection.hidden = pinnedTree.childElementCount === 0;
  }

  #pinnedProjectItem(project: ProjectSidebarProject): HTMLElement {
    if (this.#editing?.kind === "project" && this.#editing.id === project.id) {
      return this.#editingRow("project-row pinned-row", project.name, 80, (value) => this.#commitEdit(value));
    }
    const item = this.#treeItem(project.name, "project-row pinned-row", this.#folderIcon(), () => this.#options.selectProject(project.id), (toggle, event) => this.#openMenu("project", project.id, undefined, toggle, event), () => this.#options.newChat(project.id));
    const button = item.querySelector<HTMLButtonElement>(".project-row")!;
    button.classList.toggle("active", project.id === this.#state.currentProjectId && !this.#state.currentSessionId && !this.#state.newChat);
    this.#appendPin(button);
    return item;
  }

  #pinnedSessionItem(session: ProjectSidebarSession, project?: ProjectSidebarProject): HTMLElement {
    if (this.#editing?.kind === "session" && this.#editing.id === session.id) {
      return this.#editingRow("chat-row pinned-row", session.title, 120, (value) => this.#commitEdit(value));
    }
    const item = this.#treeItem(session.title, "chat-row pinned-row", undefined, () => this.#options.selectSession(session.id, project?.id), (toggle, event) => this.#openMenu(project ? "task" : "chat", session.id, project?.id, toggle, event));
    const button = item.querySelector<HTMLButtonElement>(".chat-row")!;
    button.classList.toggle("active", session.id === this.#state.currentSessionId && project?.id === this.#state.currentProjectId);
    this.#appendPin(button);
    return item;
  }

  #projectGroup(project: ProjectSidebarProject): HTMLElement {
    if (this.#editing?.kind === "project" && this.#editing.id === project.id) {
      return this.#editingRow("project-row", project.name, 80, (value) => this.#commitEdit(value));
    }
    const expanded = this.#expandedProjects.has(project.id);
    const group = document.createElement("div");
    group.className = "project-group";
    group.classList.toggle("expanded", expanded);
    group.dataset.projectId = project.id;
    const projectItem = this.#treeItem(project.name, "project-row", this.#folderIcon(), () => {
      if (project.id === this.#state.currentProjectId) this.#toggleExpansion(project.id, group);
      else this.#options.selectProject(project.id);
    }, (toggle, event) => this.#openMenu("project", project.id, undefined, toggle, event), () => this.#options.newChat(project.id));
    const projectButton = projectItem.querySelector<HTMLButtonElement>(".project-row")!;
    projectButton.classList.toggle("active", project.id === this.#state.currentProjectId && !this.#state.currentSessionId && !this.#state.newChat);
    projectButton.setAttribute("aria-expanded", String(expanded));
    if (this.#pinnedProjects.has(project.id)) this.#appendPin(projectButton);
    group.append(projectItem);

    const children = document.createElement("div");
    children.className = "project-children";
    const childrenInner = document.createElement("div");
    childrenInner.className = "project-children-inner";
    children.append(childrenInner);
    group.append(children);
    const sessions = this.#state.sessionsByProject.get(project.id) ?? [];
    if (sessions.length === 0) childrenInner.append(this.#empty("No chats"));
    for (const session of sessions) childrenInner.append(this.#sessionItem(session, project));
    return group;
  }

  #sessionItem(session: ProjectSidebarSession, project: ProjectSidebarProject): HTMLElement {
    if (this.#editing?.kind === "session" && this.#editing.id === session.id) {
      return this.#editingRow("task-row", session.title, 120, (value) => this.#commitEdit(value));
    }
    const item = this.#treeItem(session.title, "task-row", undefined, () => this.#options.selectSession(session.id, project.id), (toggle, event) => this.#openMenu("task", session.id, project.id, toggle, event));
    const button = item.querySelector<HTMLButtonElement>(".task-row")!;
    button.classList.toggle("active", session.id === this.#state.currentSessionId);
    if (this.#pinnedSessions.has(session.id)) {
      this.#appendPin(button);
    }
    return item;
  }

  #chatItem(chat: ProjectSidebarSession): HTMLElement {
    if (this.#editing?.kind === "session" && this.#editing.id === chat.id) {
      return this.#editingRow("chat-row", chat.title, 120, (value) => this.#commitEdit(value));
    }
    const item = this.#treeItem(chat.title, "chat-row", undefined, () => this.#options.selectSession(chat.id, undefined), (toggle, event) => this.#openMenu("chat", chat.id, undefined, toggle, event));
    const button = item.querySelector<HTMLButtonElement>(".chat-row")!;
    button.classList.toggle("active", chat.id === this.#state.currentSessionId && !this.#state.currentProjectId);
    if (this.#pinnedSessions.has(chat.id)) {
      this.#appendPin(button);
    }
    return item;
  }

  #appendPin(button: HTMLButtonElement): void {
    const pin = svgIcon('<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>');
    pin.classList.add("pin-indicator");
    pin.setAttribute("role", "img");
    pin.setAttribute("aria-label", "Pinned");
    button.append(pin);
  }

  #treeItem(label: string, className: string, icon: SVGElement | undefined, action: () => void, menu: (toggle: HTMLButtonElement, event: MouseEvent) => void, quickAction?: () => void): HTMLElement {
    const item = document.createElement("div"); item.className = "tree-item";
    const value = document.createElement("button"); value.type = "button"; value.className = className;
    const text = document.createElement("span"); text.textContent = label;
    if (icon) value.append(icon);
    value.append(text);
    value.addEventListener("click", action);
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "tree-menu-toggle"; toggle.title = `${label} actions`; toggle.setAttribute("aria-label", `${label} actions`); toggle.setAttribute("aria-expanded", "false"); toggle.append(svgIcon('<circle cx="5" cy="10" r="1"></circle><circle cx="10" cy="10" r="1"></circle><circle cx="15" cy="10" r="1"></circle>'));
    toggle.addEventListener("click", (event) => menu(toggle, event));
    value.addEventListener("contextmenu", (event) => menu(toggle, event));
    item.append(value);
    if (quickAction) {
      const quick = document.createElement("button"); quick.type = "button"; quick.className = "tree-quick-action"; quick.title = `New chat in ${label}`; quick.setAttribute("aria-label", `New chat in ${label}`); quick.append(svgIcon('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path>', "0 0 24 24"));
      quick.addEventListener("click", (event) => { event.stopPropagation(); quickAction(); });
      item.append(quick);
    }
    item.append(toggle);
    return item;
  }

  #toggleExpansion(projectId: string, group: HTMLElement): void {
    const expanded = !this.#expandedProjects.has(projectId);
    if (expanded) this.#expandedProjects.add(projectId); else this.#expandedProjects.delete(projectId);
    this.#saveSet("fitz-expanded-projects", this.#expandedProjects);
    group.classList.toggle("expanded", expanded);
    group.querySelector<HTMLButtonElement>(".project-row")?.setAttribute("aria-expanded", String(expanded));
  }

  #openMenu(kind: "project" | "task" | "chat", id: string, projectId: string | undefined, toggle: HTMLButtonElement, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.#options.closePopovers();
    this.#menu.reset();
    if (kind === "project") this.#buildProjectMenu(id);
    else this.#buildSessionMenu(id, projectId);
    this.#menu.openBeside(toggle);
    toggle.setAttribute("aria-expanded", "true");
  }

  #buildProjectMenu(projectId: string): void {
    const project = this.#project(projectId);
    if (!project) return;
    const sessions = this.#state.sessionsByProject.get(projectId) ?? [];
    const menu = this.#menu;
    menu.add({ label: this.#pinnedProjects.has(projectId) ? "Unpin project" : "Pin project", action: () => this.#toggleStored(this.#pinnedProjects, projectId, "fitz-pinned-projects"), icon: '<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>' });
    menu.add({ label: "Edit project", action: () => this.#beginEdit("project", projectId), icon: '<circle cx="10" cy="10" r="3"></circle><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"></path>' });
    menu.add({ label: "Create permanent worktree", action: () => this.#options.createWorktree(projectId), icon: '<path d="M4 6h8M12 3l3 3-3 3M16 14H8M8 11l-3 3 3 3"></path>', disabled: !project.rootPath });
    menu.separator();
    menu.add({ label: "Open in Explorer", action: () => { if (project.rootPath) this.#options.openProjectPath(project.rootPath); }, icon: '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>', disabled: !project.rootPath });
    menu.add({ label: "Copy working directory", action: () => { if (project.rootPath) this.#options.copyValue(project.rootPath, "Working directory copied"); }, icon: '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>', disabled: !project.rootPath });
    menu.separator();
    menu.add({ label: "Archive chats", action: () => this.#options.archiveProjectChats(projectId), danger: true, icon: '<rect x="3" y="5" width="14" height="11" rx="2"></rect><path d="M3 8h14M8 11h4"></path>', disabled: sessions.length === 0 });
    menu.add({ label: "Remove", action: () => this.#beginRemove(projectId), danger: true, icon: '<path d="m5 5 10 10M15 5 5 15"></path>' });
  }

  #buildSessionMenu(sessionId: string, projectId: string | undefined): void {
    const session = projectId
      ? (this.#state.sessionsByProject.get(projectId) ?? []).find((item) => item.id === sessionId)
      : this.#state.chats.find((item) => item.id === sessionId);
    const project = projectId ? this.#project(projectId) : undefined;
    if (!session) return;
    const menu = this.#menu;
    menu.add({ label: this.#pinnedSessions.has(sessionId) ? "Unpin chat" : "Pin chat", action: () => this.#toggleStored(this.#pinnedSessions, sessionId, "fitz-pinned-sessions"), icon: '<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>' });
    menu.add({ label: "Rename chat", action: () => this.#beginEdit("session", sessionId, projectId), icon: '<path d="M4 14.5V17h2.5L15 8.5 11.5 5z"></path><path d="m10.5 6 3.5 3.5"></path>' });
    menu.add({ label: "Continue in new chat", action: () => this.#options.continueSession(session, projectId), icon: '<path d="M4 5h7a4 4 0 0 1 4 4v6"></path><path d="m12 12 3 3 3-3"></path>' });
    menu.separator();
    menu.add({ label: "Open in Explorer", action: () => { if (project?.rootPath) this.#options.openProjectPath(project.rootPath); }, icon: '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>', disabled: !project?.rootPath });
    menu.add({ label: "Copy working directory", action: () => { if (project?.rootPath) this.#options.copyValue(project.rootPath, "Working directory copied"); }, icon: '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>', disabled: !project?.rootPath });
    menu.add({ label: "Copy session ID", action: () => this.#options.copyValue(sessionId, "Session ID copied"), icon: '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>' });
    menu.add({ label: "Copy deeplink", action: () => this.#options.copyValue(`fitz://sessions/${sessionId}`, "Deeplink copied"), icon: '<path d="m8 12 4-4"></path><path d="M6.5 13.5 5 15a3 3 0 0 1-4-4l2.5-2.5a3 3 0 0 1 4.2 0"></path><path d="M13.5 6.5 15 5a3 3 0 0 1 4 4l-2.5 2.5a3 3 0 0 1-4.2 0"></path>' });
    menu.separator();
    menu.add({ label: "Archive chat", action: () => this.#options.archiveSession(sessionId, projectId), danger: true, icon: '<rect x="3" y="5" width="14" height="11" rx="2"></rect><path d="M3 8h14M8 11h4"></path>' });
    menu.add({ label: "Remove", action: () => this.#removeSession(sessionId, projectId), danger: true, icon: '<path d="m5 5 10 10M15 5 5 15"></path>' });
  }

  #removeSession(sessionId: string, projectId: string | undefined): void {
    const action = this.#options.removeSession(sessionId, projectId);
    void Promise.resolve(action).then(() => {
      this.#pinnedSessions.delete(sessionId);
      this.#saveSet("fitz-pinned-sessions", this.#pinnedSessions);
    }).catch(() => undefined);
  }

  #beginEdit(kind: "session" | "project", id: string, projectId?: string): void {
    this.#cancelCreate();
    this.#confirmingRemoval = undefined;
    this.#editing = { kind, id, projectId };
    this.#options.closePopovers();
    this.render(this.#state);
    const input = this.#elements.pinnedTree.querySelector<HTMLInputElement>(".tree-rename-input") ?? this.#elements.tree.querySelector<HTMLInputElement>(".tree-rename-input") ?? this.#elements.chatsTree.querySelector<HTMLInputElement>(".tree-rename-input");
    input?.focus();
    input?.select();
  }

  #beginRemove(projectId: string): void {
    const project = this.#project(projectId);
    if (!project) return;
    this.#editing = undefined;
    this.#cancelCreate();
    this.#confirmingRemoval = { projectId, name: project.name };
    this.#options.closePopovers();
    this.render(this.#state);
    this.#elements.tree.querySelector<HTMLButtonElement>(".tree-confirm-cancel")?.focus();
  }

  #cancelTransient(): void {
    if (!this.#editing && !this.#creatingProject && !this.#confirmingRemoval) return;
    this.#editing = undefined;
    this.#confirmingRemoval = undefined;
    this.#cancelCreate();
    this.render(this.#state);
  }

  #commitEdit(value: string): void {
    const editing = this.#editing;
    if (!editing) return;
    if (!value) { this.#cancelTransient(); return; }
    const action = editing.kind === "session"
      ? this.#options.renameSession(editing.id, editing.projectId, value)
      : editing.kind === "project"
        ? this.#options.renameProject(editing.id, value)
        : undefined;
    if (!action) { this.#cancelTransient(); return; }
    void Promise.resolve(action).then(
      () => this.#finishEdit(editing),
      () => this.#finishEdit(editing),
    );
  }

  #finishEdit(editing: SidebarEdit): void {
    if (this.#editing === editing) {
      this.#editing = undefined;
      this.render(this.#state);
    }
  }

  #commitCreate(name: string): void {
    const creating = this.#creatingProject;
    if (!creating) return;
    if (!name) { this.#createDialog.name.focus(); return; }
    this.#cancelCreate();
    void Promise.resolve(this.#options.createProject(name, creating.rootPath)).then(
      () => undefined,
      () => undefined,
    );
  }

  #commitRemove(projectId: string): void {
    const confirming = this.#confirmingRemoval;
    if (!confirming || confirming.projectId !== projectId) return;
    const action = this.#options.removeProject(projectId);
    void Promise.resolve(action).then(
      () => { if (this.#confirmingRemoval === confirming) { this.#confirmingRemoval = undefined; this.render(this.#state); } },
      () => { if (this.#confirmingRemoval === confirming) { this.#confirmingRemoval = undefined; this.render(this.#state); } },
    );
  }

  #editingRow(className: string, initial: string, maxLength: number, commit: (value: string) => void): HTMLElement {
    const item = document.createElement("div"); item.className = "tree-item tree-editing";
    const value = document.createElement("div"); value.className = className;
    value.append(this.#renameInput(initial, maxLength, commit));
    item.append(value);
    return item;
  }

  #renameInput(initial: string, maxLength: number, commit: (value: string) => void): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-rename-input";
    input.value = initial;
    input.maxLength = maxLength;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Rename");
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commit(input.value.trim()); }
      else if (event.key === "Escape") { event.preventDefault(); this.#cancelTransient(); }
    });
    input.addEventListener("blur", () => this.#cancelTransient());
    return input;
  }

  #buildCreateDialog(): CreateProjectDialog {
    const backdrop = document.createElement("div"); backdrop.className = "create-project-backdrop"; backdrop.hidden = true;
    const dialog = document.createElement("div"); dialog.className = "create-project-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "create-project-title");

    const title = document.createElement("h2"); title.id = "create-project-title"; title.textContent = "Create project";
    const hint = document.createElement("p"); hint.className = "create-project-hint"; hint.textContent = "Name the project and choose its source folder.";

    const nameLabel = document.createElement("label"); nameLabel.className = "create-project-field"; nameLabel.textContent = "Project name";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "create-project-name";
    name.placeholder = "e.g. my-app";
    name.maxLength = 80;
    name.spellcheck = false;
    name.setAttribute("aria-label", "Project name");
    nameLabel.append(name);

    const folderRow = document.createElement("div"); folderRow.className = "create-project-folder";
    const folderLabel = document.createElement("span"); folderLabel.className = "create-project-folder-label"; folderLabel.textContent = "No folder selected";
    const folderButton = document.createElement("button"); folderButton.type = "button"; folderButton.className = "create-project-choose"; folderButton.textContent = "Choose folder…";
    folderButton.addEventListener("click", async () => {
      folderButton.disabled = true;
      try {
        const path = await this.#options.chooseFolder();
        if (!path || !this.#creatingProject) return;
        this.#creatingProject.rootPath = path;
        folderLabel.textContent = path;
        folderLabel.title = path;
        folderRow.classList.add("has-folder");
        if (!name.value.trim()) name.value = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";
      } catch (error) {
        this.#options.onError(error);
      } finally {
        folderButton.disabled = false;
      }
    });
    folderRow.append(folderLabel, folderButton);

    const actions = document.createElement("div"); actions.className = "tree-form-actions create-project-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "tree-form-cancel"; cancel.textContent = "Cancel";
    const create = document.createElement("button"); create.type = "button"; create.className = "tree-form-submit"; create.textContent = "Create";
    cancel.addEventListener("click", () => this.#cancelCreate());
    create.addEventListener("click", () => this.#commitCreate(name.value.trim()));
    actions.append(cancel, create);

    dialog.append(title, hint, nameLabel, folderRow, actions);
    dialog.addEventListener("click", (event) => event.stopPropagation());
    dialog.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); this.#cancelCreate(); }
      else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); this.#commitCreate(name.value.trim()); }
    });
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) this.#cancelCreate(); });
    backdrop.append(dialog);

    return { backdrop, name, folderRow, folderButton, folderLabel, create };
  }

  #openCreateDialog(): void {
    const dialog = this.#createDialog;
    dialog.name.value = "";
    dialog.folderLabel.textContent = "No folder selected";
    dialog.folderLabel.title = "";
    dialog.folderRow.classList.remove("has-folder");
    dialog.backdrop.hidden = false;
    dialog.name.focus();
  }

  #cancelCreate(): void {
    if (!this.#creatingProject) return;
    this.#creatingProject = undefined;
    this.#createDialog.backdrop.hidden = true;
  }

  #confirmRemoveRow(project: ProjectSidebarProject): HTMLElement {
    const row = document.createElement("div"); row.className = "tree-confirm-row";
    const copy = document.createElement("span"); copy.className = "tree-confirm-copy";
    copy.textContent = `Remove "${project.name}" and its chats?`;
    const actions = document.createElement("div"); actions.className = "tree-form-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "tree-form-cancel tree-confirm-cancel"; cancel.textContent = "Cancel";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "tree-form-danger"; remove.textContent = "Remove";
    cancel.addEventListener("click", () => this.#cancelTransient());
    remove.addEventListener("click", () => this.#commitRemove(project.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.#cancelTransient(); }
    });
    actions.append(cancel, remove);
    row.append(copy, actions);
    return row;
  }

  #toggleStored(values: Set<string>, id: string, key: string): void {
    if (values.has(id)) values.delete(id); else values.add(id);
    this.#saveSet(key, values);
    this.#options.closePopovers();
    this.render(this.#state);
  }

  #project(id: string | undefined): ProjectSidebarProject | undefined { return id ? this.#state.projects.find((project) => project.id === id) : undefined; }
  #empty(text: string): HTMLElement { const value = document.createElement("div"); value.className = "tree-empty"; value.textContent = text; return value; }
  #folderIcon(): SVGElement { return svgIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>', "0 0 24 24"); }
  #storedSet(key: string): Set<string> { try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); } catch { return new Set(); } }
  #saveSet(key: string, values: Set<string>): void { localStorage.setItem(key, JSON.stringify([...values])); }
}
