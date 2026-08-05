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
  currentProjectId: string | undefined;
  currentSessionId: string | undefined;
  newChat: boolean;
}

export interface ProjectSidebarElements {
  tree: HTMLElement;
  chatHoverCard: HTMLElement;
  chatHoverTitle: HTMLElement;
  chatHoverAge: HTMLElement;
  chatHoverProject: HTMLElement;
  projectHoverCard: HTMLElement;
  projectHoverTitle: HTMLElement;
  projectHoverTaskCount: HTMLElement;
  projectHoverPath: HTMLButtonElement;
  projectHoverPathLabel: HTMLElement;
  projectHoverPin: HTMLButtonElement;
  projectHoverEdit: HTMLButtonElement;
}

export interface ProjectSidebarOptions {
  /** The sidebar tree the controller renders projects and sessions into. */
  mount: HTMLElement;
  closePopovers: () => void;
  selectProject: (projectId: string) => void;
  selectSession: (sessionId: string, projectId: string) => void;
  newChat: (projectId: string) => void;
  openProjectPath: (path: string) => void;
  createWorktree: (projectId: string) => void;
  archiveProjectChats: (projectId: string) => void;
  removeProject: (projectId: string) => Promise<void> | void;
  renameSession: (sessionId: string, projectId: string, title: string) => Promise<void> | void;
  renameProject: (projectId: string, name: string) => Promise<void> | void;
  createProject: (name: string, rootPath: string | undefined) => Promise<void> | void;
  chooseFolder: () => Promise<string | undefined>;
  archiveSession: (sessionId: string, projectId: string) => void;
  copyValue: (value: string, message: string) => void;
  continueSession: (session: ProjectSidebarSession, projectId: string) => void;
}

interface SidebarEdit {
  kind: "session" | "project";
  id: string;
  projectId: string | undefined;
}

/** Owns the project/session tree, its persistent presentation state, menus, and hover cards. */
export class ProjectSidebarController {
  readonly #options: ProjectSidebarOptions;
  readonly #elements: ProjectSidebarElements;
  readonly #menu: ContextMenu;
  readonly #menuElement: HTMLElement;
  readonly #pinnedProjects = this.#storedSet("fitz-pinned-projects");
  readonly #pinnedSessions = this.#storedSet("fitz-pinned-sessions");
  readonly #expandedProjects = this.#storedSet("fitz-expanded-projects");
  #state: ProjectSidebarState = { projects: [], sessionsByProject: new Map(), currentProjectId: undefined, currentSessionId: undefined, newChat: false };
  #hoveredProjectId: string | undefined;
  #projectHoverHideTimer: ReturnType<typeof setTimeout> | undefined;
  #editing: SidebarEdit | undefined;
  #creatingProject: { rootPath?: string } | undefined;
  #confirmingRemoval: { projectId: string; name: string } | undefined;

  constructor(options: ProjectSidebarOptions) {
    this.#options = options;
    // The hover cards and context menu live at shell level, so their lookup is
    // global rather than scoped to the tree.
    const elements: ProjectSidebarElements = {
      tree: options.mount,
      chatHoverCard: requiredElement("chat-hover-card"),
      chatHoverTitle: requiredElement("hover-chat-title"),
      chatHoverAge: requiredElement("hover-chat-age"),
      chatHoverProject: requiredElement("hover-project-name"),
      projectHoverCard: requiredElement("project-hover-card"),
      projectHoverTitle: requiredElement("hover-project-title"),
      projectHoverTaskCount: requiredElement("hover-project-task-count"),
      projectHoverPath: requiredElement("hover-project-path") as HTMLButtonElement,
      projectHoverPathLabel: requiredElement("hover-project-path-label"),
      projectHoverPin: requiredElement("hover-project-pin") as HTMLButtonElement,
      projectHoverEdit: requiredElement("hover-project-edit") as HTMLButtonElement,
    };
    this.#elements = elements;
    this.#menuElement = requiredElement("sidebar-context-menu");
    this.#menu = new ContextMenu(this.#menuElement, options.closePopovers);
    this.#menuElement.addEventListener("click", (event) => event.stopPropagation());
    elements.projectHoverCard.addEventListener("mouseenter", () => this.cancelProjectHoverHide());
    elements.projectHoverCard.addEventListener("mouseleave", () => this.scheduleProjectHoverHide());
    elements.projectHoverCard.addEventListener("click", (event) => event.stopPropagation());
    elements.projectHoverPin.addEventListener("click", () => {
      if (this.#hoveredProjectId) this.#toggleStored(this.#pinnedProjects, this.#hoveredProjectId, "fitz-pinned-projects");
    });
    elements.projectHoverPath.addEventListener("click", () => {
      const path = this.#project(this.#hoveredProjectId)?.rootPath;
      if (path) options.openProjectPath(path);
    });
    elements.projectHoverEdit.addEventListener("click", () => {
      if (this.#hoveredProjectId) this.#beginEdit("project", this.#hoveredProjectId);
    });
  }

  render(state: ProjectSidebarState): void {
    this.#state = state;
    const tree = this.#elements.tree;
    tree.replaceChildren();
    if (this.#creatingProject) tree.append(this.#createProjectForm());
    if (state.projects.length === 0) {
      tree.append(this.#empty("No projects yet"));
      return;
    }

    const projects = [...state.projects].sort((left, right) => Number(this.#pinnedProjects.has(right.id)) - Number(this.#pinnedProjects.has(left.id)));
    for (const project of projects) {
      if (this.#confirmingRemoval?.projectId === project.id) tree.append(this.#confirmRemoveRow(project));
      else tree.append(this.#projectGroup(project));
    }
  }

  /** Starts the inline create-project form at the top of the tree (toggles it off when already open). */
  beginCreateProject(): void {
    if (this.#creatingProject) { this.#creatingProject = undefined; this.render(this.#state); return; }
    this.#editing = undefined;
    this.#confirmingRemoval = undefined;
    this.#creatingProject = {};
    this.#options.closePopovers();
    this.render(this.#state);
    this.#elements.tree.querySelector<HTMLInputElement>(".tree-create-name")?.focus();
  }

  /** Begins inline rename of the currently selected chat (used by the header menu and shortcut). */
  beginRenameCurrentSession(): void {
    const projectId = this.#state.currentProjectId;
    const sessionId = this.#state.currentSessionId;
    if (!projectId || !sessionId) return;
    const session = (this.#state.sessionsByProject.get(projectId) ?? []).find((item) => item.id === sessionId);
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
    this.#saveSet("fitz-pinned-projects", this.#pinnedProjects);
    this.#saveSet("fitz-expanded-projects", this.#expandedProjects);
  }

  hideChatHover(): void { this.#elements.chatHoverCard.hidden = true; }

  hideProjectHover(): void {
    this.cancelProjectHoverHide();
    this.#elements.projectHoverCard.hidden = true;
    this.#hoveredProjectId = undefined;
  }

  hideOverlays(): void { this.hideProjectHover(); this.hideChatHover(); }

  hideMenu(): void { this.#menuElement.hidden = true; }

  resetMenuToggles(): void {
    for (const toggle of this.#elements.tree.querySelectorAll(".tree-menu-toggle")) toggle.setAttribute("aria-expanded", "false");
  }

  cancelProjectHoverHide(): void {
    if (this.#projectHoverHideTimer) clearTimeout(this.#projectHoverHideTimer);
    this.#projectHoverHideTimer = undefined;
  }

  scheduleProjectHoverHide(): void {
    this.cancelProjectHoverHide();
    this.#projectHoverHideTimer = setTimeout(() => this.hideProjectHover(), 120);
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
    projectItem.addEventListener("mouseenter", () => this.#showProjectHover(project, projectItem));
    projectItem.addEventListener("mouseleave", () => this.scheduleProjectHoverHide());
    projectButton.addEventListener("focus", () => this.#showProjectHover(project, projectItem));
    projectButton.addEventListener("blur", () => this.scheduleProjectHoverHide());
    group.append(projectItem);

    const children = document.createElement("div");
    children.className = "project-children";
    const childrenInner = document.createElement("div");
    childrenInner.className = "project-children-inner";
    children.append(childrenInner);
    group.append(children);
    const sessions = [...(this.#state.sessionsByProject.get(project.id) ?? [])].sort((left, right) => Number(this.#pinnedSessions.has(right.id)) - Number(this.#pinnedSessions.has(left.id)));
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
      const pin = svgIcon('<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>');
      pin.classList.add("pin-indicator");
      pin.setAttribute("role", "img");
      pin.setAttribute("aria-label", "Pinned");
      button.append(pin);
    }
    item.addEventListener("mouseenter", () => this.#showChatHover(session, project, item));
    item.addEventListener("mouseleave", () => this.hideChatHover());
    button.addEventListener("focus", () => this.#showChatHover(session, project, item));
    button.addEventListener("blur", () => this.hideChatHover());
    return item;
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

  #openMenu(kind: "project" | "task", id: string, projectId: string | undefined, toggle: HTMLButtonElement, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.#options.closePopovers();
    this.#menu.reset();
    if (kind === "project") this.#buildProjectMenu(id);
    else if (projectId) this.#buildSessionMenu(id, projectId);
    this.#menu.openBeside(toggle);
    toggle.setAttribute("aria-expanded", "true");
  }

  #buildProjectMenu(projectId: string): void {
    const project = this.#project(projectId);
    if (!project) return;
    const sessions = this.#state.sessionsByProject.get(projectId) ?? [];
    const menu = this.#menu;
    menu.add({ label: this.#pinnedProjects.has(projectId) ? "Unpin project" : "Pin project", action: () => this.#toggleStored(this.#pinnedProjects, projectId, "fitz-pinned-projects"), icon: '<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>' });
    menu.add({ label: "Open in Explorer", action: () => { if (project.rootPath) this.#options.openProjectPath(project.rootPath); }, icon: '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>', disabled: !project.rootPath });
    menu.add({ label: "Create permanent worktree", action: () => this.#options.createWorktree(projectId), icon: '<path d="M4 6h8M12 3l3 3-3 3M16 14H8M8 11l-3 3 3 3"></path>', disabled: !project.rootPath });
    menu.add({ label: "Edit project", action: () => this.#beginEdit("project", projectId), icon: '<circle cx="10" cy="10" r="3"></circle><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"></path>' });
    menu.separator();
    menu.add({ label: "Archive chats", action: () => this.#options.archiveProjectChats(projectId), icon: '<rect x="3" y="5" width="14" height="11" rx="2"></rect><path d="M3 8h14M8 11h4"></path>', disabled: sessions.length === 0 });
    menu.add({ label: "Remove", action: () => this.#beginRemove(projectId), icon: '<path d="m5 5 10 10M15 5 5 15"></path>' });
  }

  #buildSessionMenu(sessionId: string, projectId: string): void {
    const session = this.#state.sessionsByProject.get(projectId)?.find((item) => item.id === sessionId);
    const project = this.#project(projectId);
    if (!session) return;
    const menu = this.#menu;
    menu.add({ label: this.#pinnedSessions.has(sessionId) ? "Unpin chat" : "Pin chat", action: () => this.#toggleStored(this.#pinnedSessions, sessionId, "fitz-pinned-sessions"), icon: '<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>' });
    menu.add({ label: "Rename chat", action: () => this.#beginEdit("session", sessionId, projectId), icon: '<path d="M4 14.5V17h2.5L15 8.5 11.5 5z"></path><path d="m10.5 6 3.5 3.5"></path>' });
    menu.add({ label: "Archive chat", action: () => this.#options.archiveSession(sessionId, projectId), danger: true, icon: '<rect x="3" y="5" width="14" height="11" rx="2"></rect><path d="M3 8h14M8 11h4"></path>' });
    if (project?.rootPath) {
      menu.separator();
      menu.add({ label: "Open in Explorer", action: () => this.#options.openProjectPath(project.rootPath!), icon: '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>' });
      menu.add({ label: "Copy working directory", action: () => this.#options.copyValue(project.rootPath!, "Working directory copied"), icon: '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>' });
    }
    menu.add({ label: "Copy session ID", action: () => this.#options.copyValue(sessionId, "Session ID copied"), icon: '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>' });
    menu.add({ label: "Copy deeplink", action: () => this.#options.copyValue(`fitz://sessions/${sessionId}`, "Deeplink copied"), icon: '<path d="m8 12 4-4"></path><path d="M6.5 13.5 5 15a3 3 0 0 1-4-4l2.5-2.5a3 3 0 0 1 4.2 0"></path><path d="M13.5 6.5 15 5a3 3 0 0 1 4 4l-2.5 2.5a3 3 0 0 1-4.2 0"></path>' });
    menu.separator();
    menu.add({ label: "Continue in new chat", action: () => this.#options.continueSession(session, projectId), icon: '<path d="M4 5h7a4 4 0 0 1 4 4v6"></path><path d="m12 12 3 3 3-3"></path>' });
  }

  #showChatHover(session: ProjectSidebarSession, project: ProjectSidebarProject, anchor: HTMLElement): void {
    this.hideProjectHover();
    const updated = new Date(session.updatedAt ?? session.createdAt ?? Date.now()).getTime();
    const age = Math.max(0, Date.now() - updated);
    const days = Math.floor(age / 86_400_000);
    const hours = Math.floor(age / 3_600_000);
    const elements = this.#elements;
    elements.chatHoverTitle.textContent = session.title;
    elements.chatHoverAge.textContent = days ? `${days}d` : hours ? `${hours}h` : "now";
    elements.chatHoverProject.textContent = project.name;
    const bounds = anchor.getBoundingClientRect();
    elements.chatHoverCard.style.left = `${Math.min(window.innerWidth - 318, bounds.right + 10)}px`;
    elements.chatHoverCard.style.top = `${Math.max(52, Math.min(window.innerHeight - 145, bounds.top - 4))}px`;
    elements.chatHoverCard.hidden = false;
  }

  #showProjectHover(project: ProjectSidebarProject, anchor: HTMLElement): void {
    this.cancelProjectHoverHide();
    this.hideChatHover();
    this.#hoveredProjectId = project.id;
    const elements = this.#elements;
    const taskCount = (this.#state.sessionsByProject.get(project.id) ?? []).length;
    elements.projectHoverTitle.textContent = project.name;
    elements.projectHoverTaskCount.textContent = `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`;
    elements.projectHoverPathLabel.textContent = project.rootPath || "No source folder";
    elements.projectHoverPath.disabled = !project.rootPath;
    const pinned = this.#pinnedProjects.has(project.id);
    elements.projectHoverPin.setAttribute("aria-pressed", String(pinned));
    elements.projectHoverPin.setAttribute("aria-label", pinned ? "Unpin project" : "Pin project");
    elements.projectHoverPin.title = pinned ? "Unpin project" : "Pin project";
    const bounds = anchor.getBoundingClientRect();
    elements.projectHoverCard.hidden = false;
    const cardBounds = elements.projectHoverCard.getBoundingClientRect();
    elements.projectHoverCard.style.left = `${Math.max(8, Math.min(window.innerWidth - cardBounds.width - 8, bounds.right + 10))}px`;
    elements.projectHoverCard.style.top = `${Math.max(52, Math.min(window.innerHeight - cardBounds.height - 8, bounds.top))}px`;
  }

  #beginEdit(kind: "session" | "project", id: string, projectId?: string): void {
    this.#creatingProject = undefined;
    this.#confirmingRemoval = undefined;
    this.#editing = { kind, id, projectId };
    this.#options.closePopovers();
    this.hideProjectHover();
    this.render(this.#state);
    const input = this.#elements.tree.querySelector<HTMLInputElement>(".tree-rename-input");
    input?.focus();
    input?.select();
  }

  #beginRemove(projectId: string): void {
    const project = this.#project(projectId);
    if (!project) return;
    this.#editing = undefined;
    this.#creatingProject = undefined;
    this.#confirmingRemoval = { projectId, name: project.name };
    this.#options.closePopovers();
    this.render(this.#state);
    this.#elements.tree.querySelector<HTMLButtonElement>(".tree-confirm-cancel")?.focus();
  }

  #cancelTransient(): void {
    if (!this.#editing && !this.#creatingProject && !this.#confirmingRemoval) return;
    this.#editing = undefined;
    this.#creatingProject = undefined;
    this.#confirmingRemoval = undefined;
    this.render(this.#state);
  }

  #commitEdit(value: string): void {
    const editing = this.#editing;
    if (!editing) return;
    if (!value) { this.#cancelTransient(); return; }
    const action = editing.kind === "session" && editing.projectId
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
    if (!name) { this.#cancelTransient(); return; }
    const action = this.#options.createProject(name, creating.rootPath);
    void Promise.resolve(action).then(
      () => { if (this.#creatingProject === creating) { this.#creatingProject = undefined; this.render(this.#state); } },
      () => { if (this.#creatingProject === creating) { this.#creatingProject = undefined; this.render(this.#state); } },
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

  #createProjectForm(): HTMLElement {
    const form = document.createElement("div"); form.className = "tree-create-form";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "tree-create-name";
    name.placeholder = "Project name";
    name.maxLength = 80;
    name.spellcheck = false;
    name.setAttribute("aria-label", "Project name");
    const folder = document.createElement("button"); folder.type = "button"; folder.className = "tree-create-folder";
    const folderLabel = document.createElement("span"); folderLabel.textContent = "Add folder";
    folder.append(folderLabel);
    folder.addEventListener("click", async () => {
      const path = await this.#options.chooseFolder();
      if (!path || !this.#creatingProject) return;
      this.#creatingProject.rootPath = path;
      folderLabel.textContent = path;
      folder.classList.add("has-folder");
      folder.title = path;
      if (!name.value.trim()) name.value = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";
    });
    const actions = document.createElement("div"); actions.className = "tree-form-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "tree-form-cancel"; cancel.textContent = "Cancel";
    const create = document.createElement("button"); create.type = "button"; create.className = "tree-form-submit"; create.textContent = "Create";
    cancel.addEventListener("click", () => this.#cancelTransient());
    create.addEventListener("click", () => this.#commitCreate(name.value.trim()));
    name.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); this.#commitCreate(name.value.trim()); }
      else if (event.key === "Escape") { event.preventDefault(); this.#cancelTransient(); }
    });
    actions.append(cancel, create);
    form.append(name, folder, actions);
    return form;
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
