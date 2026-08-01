import { reconnectDelay } from "@fitz/connectivity/reconnect";

type Json = Record<string, any>;
type FixedRouteId = "fast" | "default" | "smart";

const FIXED_ROUTES: readonly { id: FixedRouteId; label: string; icon: string }[] = [
  { id: "fast", label: "Fast", icon: '<path class="route-icon-outline" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path><path class="route-icon-filled" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path>' },
  { id: "default", label: "Default", icon: '<g class="route-icon-outline"><circle cx="10" cy="10" r="6"></circle><circle cx="10" cy="10" r="1.6"></circle></g><path class="route-icon-filled" fill-rule="evenodd" d="M10 3.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Zm0 4a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"></path>' },
  { id: "smart", label: "Smart", icon: '<g class="route-icon-outline"><path d="M8.75 2.75A3.25 3.25 0 0 0 4.3 5.7 3.2 3.2 0 0 0 3 8.3a3.5 3.5 0 0 0 2.1 3.2V14a3.25 3.25 0 0 0 3.65 3.2M11.25 2.75a3.25 3.25 0 0 1 4.45 2.95A3.2 3.2 0 0 1 17 8.3a3.5 3.5 0 0 1-2.1 3.2V14a3.25 3.25 0 0 1-3.65 3.2M8.75 2.75V17.2M11.25 2.75V17.2M5.1 8h3.65M11.25 8h3.65M5.1 12h3.65M11.25 12h3.65"></path></g><g class="route-icon-filled"><path d="M8.8 2.35A3.65 3.65 0 0 0 4 5.55 3.55 3.55 0 0 0 2.65 8.3c0 1.6.8 3 2.15 3.85V14a3.75 3.75 0 0 0 4 3.65V2.35Zm2.4 0v15.3A3.75 3.75 0 0 0 15.2 14v-1.85a4.35 4.35 0 0 0 2.15-3.85A3.55 3.55 0 0 0 16 5.55a3.65 3.65 0 0 0-4.8-3.2Z"></path><path class="route-icon-cut" d="M8.8 6.35H6.6l-1.15-1M8.8 10H5.9l-1.15 1M8.8 13.65H6.7l-1 1M11.2 6.35h2.2l1.15-1M11.2 10h2.9l1.15 1M11.2 13.65h2.1l1 1"></path></g>' },
];

let projectRecords: Json[] = [];
const sessionsByProject = new Map<string, Json[]>();
let currentProject: string | undefined;
let currentSession: string | undefined;
let currentRun: string | undefined;
let lastSequence = 0;
let pendingTaskAfterProject = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTokenEstimate = 0;
let contextTokenLimit = 131_072;
let managementConfiguration: Json | undefined;
let newChatMode = false;
let editingRecipe: Json | undefined;
let renameTarget: { kind: "project" | "task"; id: string } | undefined;
const pinnedProjects = storedSet("fitz-pinned-projects");
const pinnedSessions = storedSet("fitz-pinned-sessions");
const unreadSessions = storedSet("fitz-unread-sessions");
const expandedProjects = storedSet("fitz-expanded-projects");

const shell = query(".app-shell");
const workspaceHeader = query(".workspace-header");
const composerDock = query(".composer-dock");
const projects = element("projects");
const messages = element("messages");
const model = element("model") as HTMLSelectElement;
const effort = element("effort") as HTMLSelectElement;
const speed = element("speed") as HTMLSelectElement;
const modelToggle = element("model-toggle") as HTMLButtonElement;
const modelMenu = element("model-menu");
const modelSummary = element("model-summary");
const modelValue = element("model-value");
const effortValue = element("effort-value");
const speedValue = element("speed-value");
const settingsSubmenu = element("settings-submenu");
const contextMeter = element("context-meter");
const contextUsagePopover = element("context-usage-popover");
const contextPercent = element("context-percent");
const contextTokens = element("context-tokens");
const form = element("composer") as HTMLFormElement;
const workspace = query(".workspace");
const prompt = element("prompt") as HTMLTextAreaElement;
const newChatContext = element("new-chat-context");
const newChatProject = element("new-chat-project");
const status = element("status");
const sendButton = element("send") as HTMLButtonElement;
const attachButton = element("attach") as HTMLButtonElement;
const connectionStatus = element("connection-status") as HTMLButtonElement;
const connectionDetail = element("connection-detail");
const projectTitle = element("project-title");
const taskTitle = element("task-title");
const engineState = element("engine-state");
const routeState = element("route-state");
const contextPanel = element("context-panel") as HTMLElement;
const contextToggle = element("context-toggle") as HTMLButtonElement;
const artifacts = element("artifacts");
const artifactPreview = element("artifact-preview");
const artifactFile = element("artifact-file") as HTMLInputElement;
const composerAttachments = element("composer-attachments");
const addArtifactButton = element("add-artifact") as HTMLButtonElement;
const updateButton = element("update") as HTMLButtonElement;
const projectDialog = element("project-dialog") as HTMLDialogElement;
const projectForm = element("project-form") as HTMLFormElement;
const projectName = element("project-name") as HTMLInputElement;
const projectRootPath = element("project-root-path") as HTMLInputElement;
const projectFolderLabel = element("project-folder-label");
const chooseProjectFolder = element("choose-project-folder") as HTMLButtonElement;
const taskDialog = element("task-dialog") as HTMLDialogElement;
const taskForm = element("task-form") as HTMLFormElement;
const taskProject = element("task-project") as HTMLSelectElement;
const taskName = element("task-name") as HTMLInputElement;
const taskMenuToggle = element("task-menu-toggle") as HTMLButtonElement;
const taskMenu = element("task-menu");
const sidebarContextMenu = element("sidebar-context-menu");
const sidebarResizer = element("sidebar-resizer");
const renameDialog = element("rename-dialog") as HTMLDialogElement;
const renameForm = element("rename-form") as HTMLFormElement;
const renameTaskName = element("rename-task-name") as HTMLInputElement;
const renameHeading = element("rename-heading");
const renameLabel = element("rename-label");
const playbookPage = element("playbook-page");
const playbookList = element("playbook-list");
const playbookSearch = element("playbook-search") as HTMLInputElement;
const managementTitle = element("management-title");
const managementDescription = element("management-description");
const managementBrowser = element("management-browser");
const managementEditor = element("management-editor");
const engineForm = element("engine-form") as HTMLFormElement;
const recipeForm = element("recipe-form") as HTMLFormElement;
const chatHoverCard = element("chat-hover-card");
const hoverChatTitle = element("hover-chat-title");
const hoverChatAge = element("hover-chat-age");
const hoverProjectName = element("hover-project-name");
const toast = element("toast");

restoreSidebarWidth();
void initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentRun) void cancelRun();
  else void sendPrompt();
});
prompt.addEventListener("input", () => { resizePrompt(); updateContextMeter(); refreshComposerState(); });
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewChat(); }
  if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); openRenameDialog(); }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); void archiveCurrentTask(); }
  if (event.key === "Escape") { if (!managementEditor.hidden) closeManagementEditor(); else closePopovers(); }
});

element("new-project").addEventListener("click", () => openProjectDialog());
element("new-session").addEventListener("click", openNewChat);
element("manage-playbooks").addEventListener("click", () => void openPlaybookPage());
element("refresh-playbooks").addEventListener("click", () => void loadManagementConfiguration(true));
element("close-management-editor").addEventListener("click", closeManagementEditor);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-management-editor]")) button.addEventListener("click", closeManagementEditor);
playbookSearch.addEventListener("input", renderManagementPage);
element("sidebar-menu").addEventListener("click", toggleSidebar);
element("sidebar-restore").addEventListener("click", toggleSidebar);
for (const menuButton of document.querySelectorAll<HTMLButtonElement>("[data-app-menu]")) menuButton.addEventListener("click", () => { const rect = menuButton.getBoundingClientRect(); void window.fitz.showMenu(menuButton.dataset.appMenu ?? "", Math.round(rect.left), Math.round(rect.bottom)); });
for (const windowButton of document.querySelectorAll<HTMLButtonElement>("[data-window-action]")) windowButton.addEventListener("click", () => void window.fitz.windowAction(windowButton.dataset.windowAction as "minimize" | "maximize" | "close"));
window.fitz.onMenuCommand((command) => { if (command === "new-chat") openNewChat(); else if (command === "new-project") openProjectDialog(); else if (command === "toggle-sidebar") toggleSidebar(); else if (command === "toggle-environment") setContextPanel(contextPanel.hasAttribute("hidden")); });
sidebarResizer.addEventListener("pointerdown", beginSidebarResize);
sidebarResizer.addEventListener("keydown", resizeSidebarWithKeyboard);
connectionStatus.addEventListener("click", () => void initialize());
contextToggle.addEventListener("click", () => setContextPanel(contextPanel.hasAttribute("hidden")));
element("context-add").addEventListener("click", chooseArtifact);
attachButton.addEventListener("click", chooseArtifact);
addArtifactButton.addEventListener("click", chooseArtifact);
artifactFile.addEventListener("change", () => void uploadArtifact());
chooseProjectFolder.addEventListener("click", () => void selectProjectFolder());
model.addEventListener("change", updateModelControls);
effort.addEventListener("change", updateModelControls);
speed.addEventListener("change", applySpeedSelection);
modelToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(modelMenu, modelToggle); });
contextMeter.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(contextUsagePopover, contextMeter as HTMLButtonElement); });
contextUsagePopover.addEventListener("click", (event) => event.stopPropagation());
for (const row of document.querySelectorAll<HTMLButtonElement>("[data-setting]")) row.addEventListener("click", (event) => { event.stopPropagation(); openSettingsSubmenu(row.dataset.setting as "model" | "effort" | "speed", row); });
element("advanced-settings").addEventListener("click", () => showToast("Advanced recipe and routing controls are available in Playbooks"));
taskMenuToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(taskMenu, taskMenuToggle); });
modelMenu.addEventListener("click", (event) => event.stopPropagation());
taskMenu.addEventListener("click", (event) => event.stopPropagation());
sidebarContextMenu.addEventListener("click", (event) => event.stopPropagation());
element("rename-task").addEventListener("click", openRenameDialog);
element("archive-task").addEventListener("click", () => void archiveCurrentTask());
renameForm.addEventListener("submit", (event) => { event.preventDefault(); void renameCurrentTask(); });
updateButton.addEventListener("click", () => void window.fitz.installUpdate());
window.fitz.onUpdateStatus((updateStatus) => {
  updateButton.hidden = updateStatus !== "downloaded";
});
projectForm.addEventListener("submit", (event) => { event.preventDefault(); void createProject(); });
taskForm.addEventListener("submit", (event) => { event.preventDefault(); void createSession(); });
recipeForm.addEventListener("submit", (event) => { event.preventDefault(); void saveRecipe(); });
engineForm.addEventListener("submit", (event) => { event.preventDefault(); void saveEngine(); });
(element("engine-folder") as HTMLSelectElement).addEventListener("change", applyEngineFolderChoice);
(element("engine-connection") as HTMLSelectElement).addEventListener("change", updateEngineFieldVisibility);
(element("engine-runtime") as HTMLSelectElement).addEventListener("change", updateEngineFieldVisibility);
for (const closeButton of document.querySelectorAll<HTMLElement>("[data-close-dialog]")) {
  closeButton.addEventListener("click", () => {
    const dialog = document.getElementById(closeButton.dataset.closeDialog ?? "") as HTMLDialogElement | null;
    dialog?.close();
  });
}
document.addEventListener("click", closePopovers);

async function initialize(): Promise<void> {
  try {
    setConnection("Connecting…", "loading");
    setStatus("Connecting", "loading");
    const [health, models] = await Promise.all([api("/health"), api("/v1/models")]);
    model.replaceChildren();
    for (const card of models.data ?? []) model.add(new Option(card.display_name ?? card.id, card.id));
    updateModelControls();
    engineState.textContent = health.engine?.state ?? "UNLOADED";
    routeState.textContent = model.selectedOptions[0]?.textContent ?? "—";
    setConnection("127.0.0.1:8787", "active");
    setStatus(health.engine?.state ?? "Ready", "idle");
    await loadProjects();
    void loadManagementConfiguration(false);
  } catch (error) {
    setConnection("Click to retry", "error");
    setStatus("Offline", "error");
    showConnectionFailure(errorMessage(error));
  } finally {
    refreshComposerState();
  }
}

async function loadProjects(preferredProject?: string, preferredSession?: string): Promise<void> {
  const response = await api("/api/v1/projects");
  projectRecords = response.data ?? [];
  sessionsByProject.clear();
  await Promise.all(projectRecords.map(async (project) => {
    const sessions = await api(`/api/v1/projects/${project.id}/sessions`);
    sessionsByProject.set(project.id, (sessions.data ?? []).filter((session: Json) => session.status !== "archived"));
  }));

  if (preferredProject && projectRecords.some((project) => project.id === preferredProject)) currentProject = preferredProject;
  else if (!currentProject || !projectRecords.some((project) => project.id === currentProject)) currentProject = projectRecords[0]?.id;
  if (currentProject && expandedProjects.size === 0) { expandedProjects.add(currentProject); saveSet("fitz-expanded-projects", expandedProjects); }

  if (preferredSession) currentSession = preferredSession;
  const selectedSessions = currentProject ? sessionsByProject.get(currentProject) ?? [] : [];
  if (!currentSession || !selectedSessions.some((session) => session.id === currentSession)) currentSession = selectedSessions[0]?.id;

  renderProjectTree();
  if (currentSession) await selectSession(currentSession, false);
  else { sessionTokenEstimate = 0; updateContextMeter(); showLanding(); await loadArtifacts(); }
}

function renderProjectTree(): void {
  projects.replaceChildren();
  if (projectRecords.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "tree-empty";
    emptyState.textContent = "No projects yet";
    projects.append(emptyState);
    return;
  }

  const orderedProjects = [...projectRecords].sort((left, right) => Number(pinnedProjects.has(right.id)) - Number(pinnedProjects.has(left.id)));
  for (const project of orderedProjects) {
    const group = document.createElement("div");
    group.className = "project-group"; group.classList.toggle("expanded", expandedProjects.has(project.id)); group.dataset.projectId = project.id;
    const projectItem = treeItem(project.name, "project-row", folderIcon(), () => {
      if (project.id === currentProject) toggleProjectExpansion(project.id, group);
      else void selectProject(project.id);
    }, (toggle, event) => openSidebarMenu("project", project.id, toggle, event));
    const projectButton = projectItem.querySelector(".project-row") as HTMLButtonElement;
    projectButton.classList.toggle("active", project.id === currentProject && !currentSession && !newChatMode);
    projectButton.setAttribute("aria-expanded", String(expandedProjects.has(project.id)));
    group.append(projectItem);
    const children = document.createElement("div"); children.className = "project-children"; const childrenInner = document.createElement("div"); childrenInner.className = "project-children-inner"; children.append(childrenInner); group.append(children);
    const projectSessions = [...(sessionsByProject.get(project.id) ?? [])].sort((left, right) => Number(pinnedSessions.has(right.id)) - Number(pinnedSessions.has(left.id)));
      if (projectSessions.length === 0) {
        const emptyState = document.createElement("div"); emptyState.className = "tree-empty"; emptyState.textContent = "No chats"; childrenInner.append(emptyState);
      }
      for (const session of projectSessions) {
        const sessionItem = treeItem(session.title, "task-row", chatIcon(), () => void selectSession(session.id, true, project.id), (toggle, event) => openSidebarMenu("task", session.id, toggle, event));
        const sessionButton = sessionItem.querySelector(".task-row") as HTMLButtonElement;
        sessionButton.classList.toggle("active", session.id === currentSession);
        if (unreadSessions.has(session.id)) { const dot = document.createElement("span"); dot.className = "activity-dot"; dot.setAttribute("aria-label", "Unread"); sessionButton.append(dot); }
        sessionItem.addEventListener("mouseenter", () => showChatHover(session, project, sessionItem)); sessionItem.addEventListener("mouseleave", hideChatHover); sessionButton.addEventListener("focus", () => showChatHover(session, project, sessionItem)); sessionButton.addEventListener("blur", hideChatHover);
        childrenInner.append(sessionItem);
      }
    projects.append(group);
  }
  updateTitles();
}

async function selectProject(id: string): Promise<void> {
  showConversationWorkspace();
  newChatMode = false;
  currentProject = id;
  expandedProjects.add(id); saveSet("fitz-expanded-projects", expandedProjects);
  const projectSessions = sessionsByProject.get(id) ?? [];
  currentSession = projectSessions[0]?.id;
  renderProjectTree();
  if (currentSession) await selectSession(currentSession, false);
  else { sessionTokenEstimate = 0; updateContextMeter(); showLanding(); await loadArtifacts(); }
  refreshComposerState();
}

async function selectSession(id: string, rerender = true, projectId?: string): Promise<void> {
  hideChatHover();
  showConversationWorkspace();
  newChatMode = false;
  workspace.classList.remove("new-chat-open");
  newChatContext.hidden = true;
  if (projectId) currentProject = projectId;
  if (currentProject) { expandedProjects.add(currentProject); saveSet("fitz-expanded-projects", expandedProjects); }
  currentSession = id;
  if (unreadSessions.delete(id)) saveSet("fitz-unread-sessions", unreadSessions);
  lastSequence = 0;
  if (rerender) renderProjectTree();
  updateTitles();
  messages.replaceChildren(loadingMessage("Loading conversation…"));
  try {
    const transcript = await api(`/api/v1/sessions/${id}/transcript`);
    messages.replaceChildren();
    sessionTokenEstimate = 0;
    for (const entry of transcript.data ?? []) {
      if (entry.kind === "message") { const text = entry.content?.text ?? ""; sessionTokenEstimate += estimateTokens(text); appendMessage(entry.role ?? "system", text); }
    }
    updateContextMeter();
    if (!messages.childElementCount) showLanding(true);
    await loadArtifacts();
  } catch (error) {
    messages.replaceChildren();
    appendMessage("system", errorMessage(error));
  }
  refreshComposerState();
  prompt.focus();
}

function toggleProjectExpansion(id: string, group: HTMLElement): void {
  const expanded = !expandedProjects.has(id);
  if (expanded) expandedProjects.add(id); else expandedProjects.delete(id);
  saveSet("fitz-expanded-projects", expandedProjects);
  group.classList.toggle("expanded", expanded);
  group.querySelector<HTMLButtonElement>(".project-row")?.setAttribute("aria-expanded", String(expanded));
}

function openNewChat(): void {
  if (currentRun) { showToast("Stop the current response before starting a new chat"); return; }
  showConversationWorkspace();
  setContextPanel(false);
  if (projectRecords.length === 0) { openProjectDialog(true); return; }
  currentProject ??= projectRecords[0]?.id;
  if (!currentProject) return;
  newChatMode = true;
  currentSession = undefined;
  sessionTokenEstimate = 0;
  expandedProjects.add(currentProject);
  saveSet("fitz-expanded-projects", expandedProjects);
  workspace.classList.add("new-chat-open");
  newChatProject.textContent = projectRecords.find((project) => project.id === currentProject)?.name ?? "Project";
  newChatContext.hidden = false;
  prompt.value = "";
  composerAttachments.replaceChildren();
  composerAttachments.hidden = true;
  renderProjectTree();
  showNewChatLanding();
  updateContextMeter();
  refreshComposerState();
  prompt.focus();
}

function showNewChatLanding(): void {
  messages.replaceChildren();
  const project = projectRecords.find((item) => item.id === currentProject);
  const landing = document.createElement("div"); landing.className = "new-chat-landing";
  const mark = document.createElement("div"); mark.className = "landing-mark"; mark.append(sparkIcon());
  const heading = document.createElement("h1"); heading.textContent = `What should we build in ${project?.name ?? "this project"}?`;
  const suggestions = [
    ["Explore and understand code", '<path d="M4 15 7 5l4 3 5-4-3 11-4-3z"></path>'],
    ["Build a new feature, app, or tool", '<path d="m5 15 5-10 5 10M7 11h6"></path>'],
    ["Review code and suggest changes", '<path d="M15 6a6 6 0 1 0 1 7"></path><path d="m13 3 3 3-3 3"></path>'],
    ["Fix issues and failures", '<path d="M7 7 5 4M13 7l2-3M6 10h8v5H6z"></path><path d="M3 11h3M14 11h3"></path>'],
  ];
  const grid = document.createElement("div"); grid.className = "starter-grid";
  for (const [label, iconPath] of suggestions) {
    const button = document.createElement("button"); button.type = "button"; button.className = "starter-card"; button.append(svg(iconPath!), Object.assign(document.createElement("span"), { textContent: label }));
    button.addEventListener("click", () => { prompt.value = label!; resizePrompt(); updateContextMeter(); refreshComposerState(); prompt.focus(); });
    grid.append(button);
  }
  landing.append(mark, heading, grid); messages.append(landing); updateTitles();
}

function openProjectDialog(afterCreateTask = false): void {
  showConversationWorkspace();
  pendingTaskAfterProject = afterCreateTask;
  projectForm.reset();
  projectRootPath.value = "";
  projectFolderLabel.textContent = "Add a folder Fitz can read and edit";
  chooseProjectFolder.classList.remove("has-folder");
  projectDialog.showModal();
  projectName.focus();
}

function openTaskDialog(): void {
  showConversationWorkspace();
  if (projectRecords.length === 0) { openProjectDialog(true); return; }
  taskForm.reset();
  taskProject.replaceChildren();
  for (const project of projectRecords) taskProject.add(new Option(project.name, project.id, false, project.id === currentProject));
  taskDialog.showModal();
  taskName.focus();
}

async function createProject(): Promise<void> {
  const name = projectName.value.trim();
  if (!name) return;
  setFormBusy(projectForm, true);
  try {
    const response = await api("/api/v1/projects", "POST", { name, ...(projectRootPath.value ? { rootPath: projectRootPath.value } : {}) });
    projectDialog.close();
    await loadProjects(response.data.id);
    showToast(`Created ${name}`);
    if (pendingTaskAfterProject) { pendingTaskAfterProject = false; openNewChat(); }
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    setFormBusy(projectForm, false);
  }
}

async function createSession(): Promise<void> {
  const projectId = taskProject.value;
  const title = taskName.value.trim();
  if (!projectId || !title) return;
  setFormBusy(taskForm, true);
  try {
    const response = await api(`/api/v1/projects/${projectId}/sessions`, "POST", { title });
    taskDialog.close();
    await loadProjects(projectId, response.data.id);
    showToast(`Started ${title}`);
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    setFormBusy(taskForm, false);
  }
}

async function selectProjectFolder(): Promise<void> {
  const folder = await window.fitz.chooseFolder();
  if (!folder) return;
  projectRootPath.value = folder;
  projectFolderLabel.textContent = folder;
  chooseProjectFolder.classList.add("has-folder");
  if (!projectName.value.trim()) projectName.value = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "Project";
}

function openRenameDialog(): void {
  closePopovers();
  const session = currentSessionRecord();
  if (!session) return;
  renameTarget = { kind: "task", id: session.id };
  renameHeading.textContent = "Rename chat";
  renameLabel.textContent = "Chat title";
  renameTaskName.value = session.title;
  renameDialog.showModal();
  renameTaskName.select();
}

function openProjectRenameDialog(id: string): void {
  closePopovers();
  const project = projectRecords.find((item) => item.id === id);
  if (!project) return;
  renameTarget = { kind: "project", id };
  renameHeading.textContent = "Rename project";
  renameLabel.textContent = "Project name";
  renameTaskName.value = project.name;
  renameDialog.showModal();
  renameTaskName.select();
}

async function renameCurrentTask(): Promise<void> {
  const title = renameTaskName.value.trim();
  if (!renameTarget || !title) return;
  setFormBusy(renameForm, true);
  try {
    const path = renameTarget.kind === "project" ? `/api/v1/projects/${renameTarget.id}` : `/api/v1/sessions/${renameTarget.id}`;
    const preferredProject = renameTarget.kind === "project" ? renameTarget.id : currentProject;
    const preferredSession = renameTarget.kind === "task" ? renameTarget.id : currentSession;
    await api(path, "PATCH", { [renameTarget.kind === "project" ? "name" : "title"]: title });
    renameDialog.close();
    await loadProjects(preferredProject, preferredSession);
    showToast(`Renamed to ${title}`);
  } catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(renameForm, false); }
}

async function archiveCurrentTask(): Promise<void> {
  closePopovers();
  const session = currentSessionRecord();
  if (!session || !currentProject) return;
  try {
    await api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" });
    currentSession = undefined;
    await loadProjects(currentProject);
    showToast(`Archived ${session.title}`);
  } catch (error) { showToast(errorMessage(error)); }
}

function currentSessionRecord(): Json | undefined {
  return currentProject ? (sessionsByProject.get(currentProject) ?? []).find((session) => session.id === currentSession) : undefined;
}

function openSidebarMenu(kind: "project" | "task", id: string, toggle: HTMLButtonElement, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  closePopovers();
  sidebarContextMenu.replaceChildren();
  if (kind === "project") buildProjectMenu(id);
  else buildTaskMenu(id);
  const rect = toggle.getBoundingClientRect();
  sidebarContextMenu.hidden = false;
  const menuRect = sidebarContextMenu.getBoundingClientRect();
  sidebarContextMenu.style.left = `${Math.min(rect.right + 4, window.innerWidth - menuRect.width - 8)}px`;
  sidebarContextMenu.style.top = `${Math.min(rect.top, window.innerHeight - menuRect.height - 8)}px`;
  toggle.setAttribute("aria-expanded", "true");
}

function buildProjectMenu(id: string): void {
  const project = projectRecords.find((item) => item.id === id);
  if (!project) return;
  addMenuItem(pinnedProjects.has(id) ? "Unpin project" : "Pin project", () => toggleStored(pinnedProjects, id, "fitz-pinned-projects"));
  addMenuItem("Rename project", () => openProjectRenameDialog(id));
  addMenuItem("Edit source folder", () => void editProjectFolder(id));
  if (project.rootPath) {
    addMenuItem("Open in Explorer", () => void openProjectPath(project.rootPath));
    addMenuItem("Copy working directory", () => void copyValue(project.rootPath, "Working directory copied"));
  }
  addMenuSeparator();
  addMenuItem("Archive chats", () => void archiveProjectChats(id), true);
}

function buildTaskMenu(id: string): void {
  const session = (currentProject ? sessionsByProject.get(currentProject) : undefined)?.find((item) => item.id === id);
  const project = projectRecords.find((item) => item.id === currentProject);
  if (!session) return;
  addMenuItem(pinnedSessions.has(id) ? "Unpin chat" : "Pin chat", () => toggleStored(pinnedSessions, id, "fitz-pinned-sessions"));
  addMenuItem("Rename chat", () => { currentSession = id; openRenameDialog(); });
  addMenuItem("Archive chat", () => { currentSession = id; void archiveCurrentTask(); }, true);
  addMenuItem(unreadSessions.has(id) ? "Mark as read" : "Mark as unread", () => toggleStored(unreadSessions, id, "fitz-unread-sessions"));
  if (project?.rootPath) {
    addMenuSeparator();
    addMenuItem("Open in Explorer", () => void openProjectPath(project.rootPath));
    addMenuItem("Copy working directory", () => void copyValue(project.rootPath, "Working directory copied"));
  }
  addMenuItem("Copy session ID", () => void copyValue(id, "Session ID copied"));
  addMenuItem("Copy deeplink", () => void copyValue(`fitz://sessions/${id}`, "Deeplink copied"));
  addMenuSeparator();
  addMenuItem("Continue in new chat", () => void continueInNewChat(session));
}

function addMenuItem(label: string, action: () => void, danger = false): void {
  const button = document.createElement("button"); button.type = "button"; button.classList.toggle("danger", danger);
  const text = document.createElement("span"); text.className = "menu-label"; text.textContent = label; button.append(text);
  button.addEventListener("click", () => { closePopovers(); action(); }); sidebarContextMenu.append(button);
}

function addMenuSeparator(): void { sidebarContextMenu.append(document.createElement("hr")); }

function toggleStored(values: Set<string>, id: string, key: string): void {
  if (values.has(id)) values.delete(id); else values.add(id);
  saveSet(key, values); closePopovers(); renderProjectTree();
}

async function editProjectFolder(id: string): Promise<void> {
  const folder = await window.fitz.chooseFolder();
  if (!folder) return;
  try { await api(`/api/v1/projects/${id}`, "PATCH", { rootPath: folder }); await loadProjects(id, currentSession); showToast("Source folder updated"); }
  catch (error) { showToast(errorMessage(error)); }
}

async function openProjectPath(path: string): Promise<void> { try { await window.fitz.openPath(path); } catch (error) { showToast(errorMessage(error)); } }
async function copyValue(value: string, message: string): Promise<void> { await window.fitz.copyText(value); showToast(message); }

async function archiveProjectChats(id: string): Promise<void> {
  const active = sessionsByProject.get(id) ?? [];
  try { await Promise.all(active.map((session) => api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" }))); currentSession = undefined; await loadProjects(id); showToast(`Archived ${active.length} chat${active.length === 1 ? "" : "s"}`); }
  catch (error) { showToast(errorMessage(error)); }
}

async function continueInNewChat(session: Json): Promise<void> {
  if (!currentProject) return;
  try { const response = await api(`/api/v1/projects/${currentProject}/sessions`, "POST", { title: `Continue: ${session.title}` }); await loadProjects(currentProject, response.data.id); showToast("Created continuation chat"); }
  catch (error) { showToast(errorMessage(error)); }
}

async function openPlaybookPage(): Promise<void> {
  closePopovers();
  setContextPanel(false);
  playbookPage.hidden = false;
  closeManagementEditor();
  setConversationInert(true);
  element("manage-playbooks").classList.add("active");
  playbookList.replaceChildren(panelEmpty("Loading playbooks…"));
  await loadManagementConfiguration(true);
}

function showConversationWorkspace(): void { playbookPage.hidden = true; closeManagementEditor(); setConversationInert(false); element("manage-playbooks").classList.remove("active"); }
function setConversationInert(inert: boolean): void { for (const area of [workspaceHeader, messages, composerDock]) { area.toggleAttribute("inert", inert); area.setAttribute("aria-hidden", String(inert)); } }

async function loadManagementConfiguration(renderPage: boolean): Promise<void> {
  try {
    managementConfiguration = await api("/api/v1/management/status");
    syncContextLimit();
    updateContextMeter();
    if (renderPage) renderManagementPage();
  } catch (error) {
    if (renderPage) playbookList.replaceChildren(panelEmpty(`Management data is unavailable: ${errorMessage(error)}`));
  }
}

function syncContextLimit(): void {
  const route = managementConfiguration?.routes?.find((item: Json) => item.id === model.value);
  const recipe = managementConfiguration?.recipes?.find((item: Json) => item.id === route?.recipeId);
  if (Number.isFinite(recipe?.contextTokens) && recipe.contextTokens > 0) contextTokenLimit = recipe.contextTokens;
}

function renderManagementPage(): void {
  const configuration = managementConfiguration;
  playbookList.replaceChildren();
  managementTitle.textContent = "Playbooks";
  managementDescription.textContent = "Engine folders appear automatically. Configure their recipes and routing here.";
  playbookSearch.placeholder = "Search playbooks";
  if (!configuration) { playbookList.append(panelEmpty("Management data is unavailable")); return; }
  const recipes = configuration.recipes ?? [];
  const routes = configuration.routes ?? [];
  const folders = configuration.engineFolders ?? [];
  const query = playbookSearch.value.trim().toLowerCase();
  const matches = (...values: unknown[]) => !query || values.some((value) => String(value ?? "").toLowerCase().includes(query));
  const visibleFolders = folders.filter((folder: Json) => {
    const engineRecipes = recipes.filter((recipe: Json) => recipe.playbookId === folder.folderName);
    return matches(folder.folderName, folder.rootPath, folder.engine?.displayName, ...engineRecipes.flatMap((recipe: Json) => [recipe.displayName, recipe.modelId]));
  });
  if (!visibleFolders.length) { playbookList.append(panelEmpty(`No engine folders found in ${configuration.engineRoot ?? "the configured root"}`)); return; }
  for (const folder of visibleFolders) {
    const engine = folder.engine;
    const playbookId = folder.folderName;
    const playbookRecipes = recipes.filter((recipe: Json) => recipe.playbookId === playbookId);
    const card = document.createElement("section"); card.className = "playbook-card";
    const heading = document.createElement("div"); heading.className = "playbook-heading";
    const identity = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = engine?.displayName ?? playbookId;
    identity.append(title);
    const headingActions = document.createElement("div"); headingActions.className = "playbook-actions";
    const configure = document.createElement("button"); configure.type = "button"; configure.className = "quiet-button compact-button"; configure.textContent = engine ? "Configure" : "Set up"; configure.addEventListener("click", () => openEngineEditor(folder)); headingActions.append(configure);
    if (engine) { const addRecipe = document.createElement("button"); addRecipe.type = "button"; addRecipe.className = "quiet-button compact-button"; addRecipe.textContent = "Add recipe"; addRecipe.addEventListener("click", () => openRecipeEditor(undefined, { ...engine, rootPath: folder.rootPath })); headingActions.append(addRecipe); }
    heading.append(identity, headingActions); card.append(heading);
    if (engine && !playbookRecipes.length) card.append(panelEmpty("No recipes yet"));
    if (!engine) { playbookList.append(card); continue; }
    for (const recipe of playbookRecipes) {
      const recipeCard = document.createElement("article"); recipeCard.className = "recipe-card";
      const recipeDetails = document.createElement("button"); recipeDetails.type = "button"; recipeDetails.className = "recipe-card-details"; recipeDetails.addEventListener("click", () => openRecipeEditor(recipe));
      const name = document.createElement("span"); name.textContent = recipe.displayName;
      const context = document.createElement("code"); context.textContent = `${formatTokenCount(recipe.contextTokens)} ctx`;
      const detail = document.createElement("small"); detail.textContent = `${recipe.adapter} · ${recipe.modelId}`;
      recipeDetails.append(name, context, detail);
      const routeToggle = document.createElement("div"); routeToggle.className = "recipe-route-toggle"; routeToggle.setAttribute("role", "group"); routeToggle.setAttribute("aria-label", `${recipe.displayName} routing`);
      for (const definition of FIXED_ROUTES) {
        const route = routes.find((item: Json) => item.id === definition.id);
        const button = document.createElement("button"); button.type = "button"; button.className = `route-symbol route-${definition.id}`; button.title = definition.label; button.setAttribute("aria-label", `${definition.label} route`); button.setAttribute("aria-pressed", String(route?.recipeId === recipe.id)); button.classList.toggle("active", route?.recipeId === recipe.id); button.append(svg(definition.icon)); button.addEventListener("click", () => void assignFixedRoute(definition, recipe, button));
        routeToggle.append(button);
      }
      recipeCard.append(recipeDetails, routeToggle); card.append(recipeCard);
    }
    playbookList.append(card);
  }
}

async function assignFixedRoute(definition: (typeof FIXED_ROUTES)[number], recipe: Json, button: HTMLButtonElement): Promise<void> {
  const current = managementConfiguration?.routes?.find((route: Json) => route.id === definition.id);
  if (current?.recipeId === recipe.id) return;
  button.disabled = true;
  try {
    await api(`/api/v1/management/routes/${definition.id}`, "PUT", {
      displayName: definition.label,
      description: definition.id === "fast" ? "Lowest-latency route" : definition.id === "smart" ? "Highest-capability route" : "Primary route",
      recipeId: recipe.id,
      enabled: true,
      isDefault: definition.id === "default",
    });
    await loadManagementConfiguration(true);
  } catch (error) {
    button.disabled = false;
    showToast(errorMessage(error));
  }
}

function openEngineEditor(folder?: Json): void {
  engineForm.reset();
  const folderSelect = element("engine-folder") as HTMLSelectElement;
  folderSelect.replaceChildren();
  const folders = managementConfiguration?.engineFolders ?? [];
  for (const candidate of folders) { const option = document.createElement("option"); option.value = candidate.folderName; option.textContent = candidate.folderName; folderSelect.append(option); }
  const preferred = folder ?? folders.find((candidate: Json) => !candidate.registered) ?? folders[0];
  element("engine-editor-title").textContent = preferred?.engine ? "Configure engine" : "Set up engine";
  if (preferred) folderSelect.value = preferred.folderName;
  else { const option = document.createElement("option"); option.textContent = "No folders found"; option.disabled = true; option.selected = true; folderSelect.append(option); }
  applyEngineFolderChoice();
  showManagementEditor("engine");
  (preferred ? element("engine-display-name") : folderSelect).focus();
}

function applyEngineFolderChoice(): void {
  const folderName = (element("engine-folder") as HTMLSelectElement).value;
  const folder = (managementConfiguration?.engineFolders ?? []).find((candidate: Json) => candidate.folderName === folderName);
  const engine = folder?.engine;
  const value = (id: string) => element(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  value("engine-display-name").value = engine?.displayName ?? folderName;
  value("engine-connection").value = engine?.connectionMode ?? "managed";
  value("engine-runtime").value = engine?.runtime ?? "windows";
  value("engine-base-url").value = engine?.baseUrl ?? "http://127.0.0.1:18080";
  value("engine-health-path").value = engine?.healthPath ?? "/v1/models";
  value("engine-command").value = engine?.launchCommand ?? "";
  value("engine-arguments").value = (engine?.launchArguments ?? []).join("\n");
  value("engine-working-directory").value = engine?.workingDirectory ?? ".";
  value("engine-wsl-distribution").value = engine?.wslDistribution ?? "Ubuntu";
  (engineForm.querySelector('button[type="submit"]') as HTMLButtonElement).disabled = !folder;
  updateEngineFieldVisibility();
}

function updateEngineFieldVisibility(): void {
  const managed = (element("engine-connection") as HTMLSelectElement).value === "managed";
  element("engine-managed-fields").hidden = !managed;
  element("engine-runtime-field").hidden = !managed;
  element("engine-base-url-field").hidden = managed;
  element("engine-wsl-field").hidden = !managed || (element("engine-runtime") as HTMLSelectElement).value !== "wsl";
}

async function saveEngine(): Promise<void> {
  const value = (id: string) => (element(id) as HTMLInputElement | HTMLSelectElement).value.trim();
  const folderName = value("engine-folder");
  if (!folderName) return;
  setFormBusy(engineForm, true);
  try {
    await api(`/api/v1/management/engines/${encodeURIComponent(folderName)}`, "PUT", {
      displayName: value("engine-display-name"),
      connectionMode: value("engine-connection"),
      runtime: value("engine-runtime"),
      baseUrl: value("engine-base-url"),
      healthPath: value("engine-health-path"),
      launchCommand: value("engine-command"),
      launchArguments: (element("engine-arguments") as HTMLTextAreaElement).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      workingDirectory: value("engine-working-directory"),
      wslDistribution: value("engine-wsl-distribution"),
    });
    closeManagementEditor();
    await loadManagementConfiguration(true);
  } catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(engineForm, false); }
}

function openRecipeEditor(recipe?: Json, playbook?: Json): void {
  editingRecipe = recipe;
  recipeForm.reset();
  element("recipe-editor-title").textContent = recipe ? "Edit recipe" : "Create recipe";
  const value = (id: string) => element(id) as HTMLInputElement;
  const playbookIds = [...new Set((managementConfiguration?.recipes ?? []).map((item: Json) => item.playbookId))];
  const playbookId = recipe?.playbookId ?? playbook?.id ?? (playbookIds.length === 1 ? playbookIds[0] : "");
  value("recipe-playbook-id").value = playbookId; value("recipe-playbook-id").readOnly = Boolean(playbookId);
  value("recipe-id").value = recipe?.id ?? ""; value("recipe-id").readOnly = Boolean(recipe);
  value("recipe-display-name").value = recipe?.displayName ?? "";
  const adapter = recipe?.adapter ?? (playbook?.connectionMode === "managed" ? "openai-managed" : "openai-compatible");
  value("recipe-adapter").value = adapter; value("recipe-adapter").readOnly = true;
  value("recipe-model-id").value = recipe?.modelId ?? "";
  value("recipe-context-tokens").value = String(recipe?.contextTokens ?? 131_072);
  const defaultConfiguration = playbook?.connectionMode === "managed"
    ? { enginePath: playbook.rootPath, runtime: playbook.runtime, command: playbook.launchCommand, args: playbook.launchArguments, workingDirectory: playbook.workingDirectory ?? ".", healthPath: playbook.healthPath, readinessTimeoutMs: 120_000, ...(playbook.wslDistribution ? { wslDistribution: playbook.wslDistribution } : {}) }
    : playbook ? { baseUrl: playbook.baseUrl, healthPath: playbook.healthPath, allowInsecureRemote: false } : {};
  (element("recipe-configuration") as HTMLTextAreaElement).value = JSON.stringify(recipe?.configuration ?? defaultConfiguration, null, 2);
  showManagementEditor("recipe"); value("recipe-id").focus();
}

async function saveRecipe(): Promise<void> {
  const value = (id: string) => (element(id) as HTMLInputElement).value.trim();
  let configuration: Json;
  try { configuration = JSON.parse((element("recipe-configuration") as HTMLTextAreaElement).value || "{}"); }
  catch { showToast("Configuration must be valid JSON"); return; }
  const id = value("recipe-id"); if (!id) return;
  setFormBusy(recipeForm, true);
  try {
    await api(`/api/v1/management/recipes/${encodeURIComponent(id)}`, "PUT", {
      playbookId: value("recipe-playbook-id"), displayName: value("recipe-display-name"), adapter: value("recipe-adapter"), modelId: value("recipe-model-id"),
      contextTokens: Number(value("recipe-context-tokens")), configuration,
      capabilities: editingRecipe?.capabilities ?? { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
      lifecycle: editingRecipe?.lifecycle ?? { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 300, minimumResidencySeconds: 0 },
    });
    closeManagementEditor(); await loadManagementConfiguration(true);
  } catch (error) { showToast(errorMessage(error)); } finally { setFormBusy(recipeForm, false); }
}

function showManagementEditor(kind: "engine" | "recipe"): void {
  managementBrowser.hidden = true;
  managementEditor.hidden = false;
  engineForm.hidden = kind !== "engine";
  recipeForm.hidden = kind !== "recipe";
  playbookPage.scrollTop = 0;
}

function closeManagementEditor(): void {
  managementEditor.hidden = true;
  managementBrowser.hidden = false;
  engineForm.hidden = true;
  recipeForm.hidden = true;
}

function updateModelControls(): void {
  routeState.textContent = model.selectedOptions[0]?.textContent ?? "—";
  const effortLabel = effort.selectedOptions[0]?.textContent ?? "Medium";
  modelSummary.textContent = `${model.selectedOptions[0]?.textContent ?? "Model"} · ${effortLabel}`;
  modelValue.textContent = model.selectedOptions[0]?.textContent ?? "Model";
  effortValue.textContent = effortLabel;
  speed.value = model.value === "fast" ? "fast" : "standard";
  speedValue.textContent = speed.selectedOptions[0]?.textContent ?? "Standard";
  syncContextLimit();
  updateContextMeter();
}

function applySpeedSelection(): void { const route = speed.value === "fast" ? "fast" : "default"; if ([...model.options].some((option) => option.value === route)) model.value = route; updateModelControls(); }

function openSettingsSubmenu(kind: "model" | "effort" | "speed", row: HTMLButtonElement): void {
  const select = kind === "model" ? model : kind === "effort" ? effort : speed;
  settingsSubmenu.replaceChildren();
  for (const option of [...select.options]) {
    const button = document.createElement("button"); button.type = "button"; button.classList.toggle("selected", option.value === select.value);
    const label = document.createElement("span"); label.textContent = option.textContent; button.append(label);
    if (kind === "effort" && option.value === "65536") { const note = document.createElement("small"); note.textContent = "Consumes resources faster"; label.append(note); }
    button.addEventListener("click", (event) => { event.stopPropagation(); select.value = option.value; if (kind === "speed") applySpeedSelection(); else updateModelControls(); closePopovers(); }); settingsSubmenu.append(button);
  }
  for (const item of document.querySelectorAll(".setting-row")) item.classList.toggle("active", item === row);
  settingsSubmenu.style.top = `${Math.max(-8, row.offsetTop - 8)}px`;
  settingsSubmenu.hidden = false;
  const bounds = settingsSubmenu.getBoundingClientRect();
  if (bounds.bottom > window.innerHeight - 16) settingsSubmenu.style.top = `${Number.parseFloat(settingsSubmenu.style.top) - (bounds.bottom - window.innerHeight + 16)}px`;
}

function togglePopover(popover: HTMLElement, toggle: HTMLButtonElement): void {
  const opening = popover.hidden;
  closePopovers();
  popover.hidden = !opening;
  toggle.setAttribute("aria-expanded", String(opening));
}

function closePopovers(): void {
  modelMenu.hidden = true;
  settingsSubmenu.hidden = true;
  contextUsagePopover.hidden = true;
  taskMenu.hidden = true;
  sidebarContextMenu.hidden = true;
  hideChatHover();
  modelToggle.setAttribute("aria-expanded", "false");
  contextMeter.setAttribute("aria-expanded", "false");
  taskMenuToggle.setAttribute("aria-expanded", "false");
  for (const row of document.querySelectorAll(".setting-row")) row.classList.remove("active");
  for (const toggle of projects.querySelectorAll(".tree-menu-toggle")) toggle.setAttribute("aria-expanded", "false");
}

async function sendPrompt(): Promise<void> {
  const content = prompt.value.trim();
  if (!content) return;
  if (!currentSession && newChatMode && currentProject) {
    try {
      const title = content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
      const response = await api(`/api/v1/projects/${currentProject}/sessions`, "POST", { title });
      const sessions = sessionsByProject.get(currentProject) ?? [];
      sessions.unshift(response.data);
      sessionsByProject.set(currentProject, sessions);
      currentSession = response.data.id;
      newChatMode = false;
      workspace.classList.remove("new-chat-open");
      newChatContext.hidden = true;
      renderProjectTree();
    } catch (error) { showToast(errorMessage(error)); return; }
  }
  if (!currentSession) { openNewChat(); return; }
  if (!model.value) { showToast("No model route is available"); return; }
  prompt.value = "";
  resizePrompt();
  if (messages.querySelector(".landing")) messages.replaceChildren();
  appendMessage("user", content);
  sessionTokenEstimate += estimateTokens(content);
  updateContextMeter();
  setStatus("Queued", "loading");
  try {
    const response = await api("/api/v1/agent/runs", "POST", {
      model: model.value,
      maxTokens: Number(effort.value),
      sessionId: currentSession,
      messages: [{ role: "user", content }],
    });
    const runId = String(response.data.id);
    currentRun = runId;
    lastSequence = 0;
    engineState.textContent = "QUEUED";
    refreshComposerState();
    await followRun(runId);
  } catch (error) {
    appendMessage("system", errorMessage(error));
    setStatus("Failed", "error");
  } finally {
    currentRun = undefined;
    refreshComposerState();
  }
}

async function cancelRun(): Promise<void> {
  if (!currentRun) return;
  sendButton.disabled = true;
  setStatus("Stopping", "loading");
  try {
    await api(`/api/v1/agent/runs/${currentRun}`, "DELETE");
  } catch (error) {
    showToast(errorMessage(error));
    sendButton.disabled = false;
  }
}

async function followRun(runId: string): Promise<void> {
  let assistant: HTMLElement | undefined;
  let done = false;
  let reconnectAttempt = 0;
  while (!done && currentRun === runId) {
    let replay: Json;
    try {
      replay = await api(`/api/v1/agent/runs/${runId}/events?after=${lastSequence}`);
      reconnectAttempt = 0;
    } catch (error) {
      if (error instanceof HttpError || reconnectAttempt >= 12) throw error;
      setStatus(`Reconnecting ${reconnectAttempt + 1}`, "loading");
      await delay(reconnectDelay(reconnectAttempt++));
      continue;
    }
    for (const event of replay.events ?? []) {
      lastSequence = event.sequence;
      if (event.type === "run.started") { setStatus("Working", "active"); engineState.textContent = "WORKING"; }
      if (event.type === "assistant.delta") {
        assistant ??= appendMessage("assistant", "");
        const delta = event.data.text ?? ""; assistant.textContent += delta; sessionTokenEstimate += estimateTokens(delta); updateContextMeter();
        messages.scrollTop = messages.scrollHeight;
      }
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) {
        done = true;
        const success = event.type === "run.completed";
        setStatus(success ? "Ready" : event.type.slice(4), success ? "idle" : "error");
        engineState.textContent = success || event.type === "run.cancelled" ? "READY" : event.type.slice(4).toUpperCase();
        if (!success && event.data?.error) appendMessage("system", event.data.error);
      }
    }
    if (!done) await delay(350);
  }
}

async function loadArtifacts(): Promise<void> {
  artifacts.replaceChildren();
  composerAttachments.replaceChildren();
  composerAttachments.hidden = true;
  artifactPreview.replaceChildren(panelEmpty("Select an artifact to preview it"));
  if (!currentSession) { artifacts.append(panelEmpty("Artifacts appear with a task")); return; }
  const response = await api(`/api/v1/sessions/${currentSession}/artifacts`);
  if (!(response.data ?? []).length) artifacts.append(panelEmpty("No artifacts yet"));
  for (const artifact of response.data ?? []) {
    const value = document.createElement("button"); value.type = "button"; value.className = "artifact-item";
    const name = document.createElement("span"); name.textContent = artifact.name;
    const size = document.createElement("small"); size.textContent = formatBytes(artifact.byteSize);
    value.append(name, size); value.addEventListener("click", () => void previewArtifact(artifact, value)); artifacts.append(value);
    const chip = document.createElement("div"); chip.className = "attachment-chip";
    const chipPreview = document.createElement("button"); chipPreview.type = "button"; chipPreview.className = "attachment-preview"; chipPreview.setAttribute("aria-label", `Preview ${artifact.name}`);
    const chipName = document.createElement("span"); chipName.textContent = artifact.name;
    const chipSize = document.createElement("small"); chipSize.textContent = formatBytes(artifact.byteSize);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "attachment-remove"; remove.title = `Remove ${artifact.name}`; remove.setAttribute("aria-label", `Remove ${artifact.name}`); remove.textContent = "×";
    chipPreview.append(chipName, chipSize); chipPreview.addEventListener("click", () => { setContextPanel(true); void previewArtifact(artifact, value); }); remove.addEventListener("click", () => void removeArtifact(artifact)); chip.append(chipPreview, remove); composerAttachments.append(chip);
  }
  composerAttachments.hidden = composerAttachments.childElementCount === 0;
}

async function removeArtifact(artifact: Json): Promise<void> {
  try { await api(`/api/v1/artifacts/${artifact.id}`, "DELETE"); await loadArtifacts(); showToast(`Removed ${artifact.name}`); }
  catch (error) { showToast(errorMessage(error)); }
}

function chooseArtifact(): void {
  if (!currentSession) { showToast("Create or select a task before attaching a file"); return; }
  artifactFile.click();
}

async function uploadArtifact(): Promise<void> {
  const file = artifactFile.files?.[0]; artifactFile.value = "";
  if (!file || !currentSession) return;
  if (file.size > 1_500_000) { showToast("Artifacts are currently limited to 1.5 MB"); return; }
  try {
    const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    await api(`/api/v1/sessions/${currentSession}/artifacts`, "POST", { name: file.name, mimeType: file.type || "application/octet-stream", contentBase64 });
    await loadArtifacts(); setContextPanel(true); showToast(`Attached ${file.name}`);
  } catch (error) { showToast(errorMessage(error)); }
}

async function previewArtifact(artifact: Json, selected: HTMLButtonElement): Promise<void> {
  for (const item of artifacts.querySelectorAll(".artifact-item")) item.classList.remove("active");
  selected.classList.add("active");
  artifactPreview.replaceChildren(panelEmpty("Loading preview…"));
  try {
    const response = await window.fitz.request({ path: `/api/v1/artifacts/${artifact.id}/content`, responseType: "base64" });
    if (response.status >= 400) throw new HttpError("Artifact could not be loaded", response.status);
    artifactPreview.replaceChildren();
    if (artifact.kind === "text" || artifact.kind === "code") {
      const pre = document.createElement("pre"); pre.textContent = new TextDecoder().decode(base64Bytes(response.body)); artifactPreview.append(pre); return;
    }
    if (["image", "audio", "video"].includes(artifact.kind)) {
      const node = document.createElement(artifact.kind === "image" ? "img" : artifact.kind) as HTMLImageElement | HTMLMediaElement;
      node.setAttribute("src", `data:${artifact.mimeType};base64,${response.body}`);
      if (node instanceof HTMLMediaElement) node.controls = true;
      artifactPreview.append(node); return;
    }
    if (artifact.kind === "pdf") {
      const frame = document.createElement("iframe"); frame.setAttribute("sandbox", ""); frame.title = artifact.name; frame.src = `data:application/pdf;base64,${response.body}`; artifactPreview.append(frame); return;
    }
    artifactPreview.append(panelEmpty("Preview unavailable for this file type"));
  } catch (error) { artifactPreview.replaceChildren(panelEmpty(errorMessage(error))); }
}

function showLanding(hasTask = false): void {
  messages.replaceChildren();
  const landing = document.createElement("div"); landing.className = "landing";
  const mark = document.createElement("div"); mark.className = "landing-mark"; mark.append(sparkIcon());
  const heading = document.createElement("h1"); heading.textContent = hasTask ? "What should we work on?" : currentProject ? "Start a task" : "Bring your code. Build with Fitz.";
  const detail = document.createElement("p"); detail.textContent = hasTask ? "Describe a change, ask a question, or attach a file. Fitz keeps the work and transcript together." : currentProject ? "Create a task inside this project to begin a durable conversation." : "Create a project, start a task, and work with local or remote inference from one focused desktop.";
  landing.append(mark, heading, detail);
  if (!hasTask) {
    const action = document.createElement("button"); action.type = "button"; action.className = "primary-button"; action.textContent = currentProject ? "New task" : "Create project";
    action.addEventListener("click", () => currentProject ? openNewChat() : openProjectDialog(true)); landing.append(action);
  }
  messages.append(landing);
  updateTitles();
}

function showConnectionFailure(detail: string): void {
  messages.replaceChildren();
  const landing = document.createElement("div"); landing.className = "landing";
  const heading = document.createElement("h1"); heading.textContent = "Fitz host is offline";
  const message = document.createElement("p"); message.textContent = detail;
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "primary-button"; retry.textContent = "Try again"; retry.addEventListener("click", () => void initialize());
  landing.append(heading, message, retry); messages.append(landing);
}

function appendMessage(role: string, text: string): HTMLElement {
  if (messages.querySelector(".landing")) messages.replaceChildren();
  const article = document.createElement("article"); article.className = `message ${role}`;
  if (role === "assistant") { const mark = document.createElement("span"); mark.className = "assistant-mark"; mark.append(sparkIcon()); article.append(mark); }
  const content = document.createElement("div"); content.className = "message-body"; content.textContent = text; article.append(content); messages.append(article); messages.scrollTop = messages.scrollHeight; return content;
}

function refreshComposerState(): void {
  const ready = Boolean((currentSession || (newChatMode && currentProject)) && model.value);
  prompt.disabled = !ready || Boolean(currentRun);
  model.disabled = model.options.length === 0 || Boolean(currentRun);
  effort.disabled = Boolean(currentRun);
  speed.disabled = model.options.length === 0 || Boolean(currentRun);
  modelToggle.disabled = model.options.length === 0 || Boolean(currentRun);
  attachButton.disabled = !currentSession || Boolean(currentRun);
  addArtifactButton.disabled = !currentSession;
  sendButton.classList.toggle("running", Boolean(currentRun));
  sendButton.title = currentRun ? "Stop task" : "Send message";
  sendButton.setAttribute("aria-label", sendButton.title);
  sendButton.disabled = currentRun ? false : !ready || prompt.value.trim().length === 0;
}

function updateTitles(): void {
  const project = projectRecords.find((item) => item.id === currentProject);
  const session = currentProject ? (sessionsByProject.get(currentProject) ?? []).find((item) => item.id === currentSession) : undefined;
  projectTitle.textContent = project?.name ?? "Fitz Codex";
  taskTitle.textContent = session?.title ?? "";
  taskMenuToggle.hidden = !session;
}

function showChatHover(session: Json, project: Json, anchor: HTMLElement): void {
  const updated = new Date(session.updatedAt ?? session.createdAt ?? Date.now()).getTime();
  const ageMilliseconds = Math.max(0, Date.now() - updated);
  const days = Math.floor(ageMilliseconds / 86_400_000);
  const hours = Math.floor(ageMilliseconds / 3_600_000);
  hoverChatTitle.textContent = session.title;
  hoverChatAge.textContent = days ? `${days}d` : hours ? `${hours}h` : "now";
  hoverProjectName.textContent = project.name;
  const bounds = anchor.getBoundingClientRect();
  chatHoverCard.style.left = `${Math.min(window.innerWidth - 318, bounds.right + 10)}px`;
  chatHoverCard.style.top = `${Math.max(52, Math.min(window.innerHeight - 145, bounds.top - 4))}px`;
  chatHoverCard.hidden = false;
}

function hideChatHover(): void { chatHoverCard.hidden = true; }

function setContextPanel(open: boolean): void {
  contextPanel.hidden = !open;
  shell.classList.toggle("context-open", open);
  contextToggle.setAttribute("aria-expanded", String(open));
}

function toggleSidebar(): void { shell.classList.toggle("sidebar-collapsed"); closePopovers(); }
function resizePrompt(): void { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; }
function updateContextMeter(): void { const usedTokens = sessionTokenEstimate + estimateTokens(prompt.value); const used = Math.min(100, (usedTokens / contextTokenLimit) * 100); contextMeter.style.setProperty("--context-used", `${used}%`); contextPercent.textContent = `${Math.round(used)}% full`; contextTokens.textContent = `≈${formatTokenCount(usedTokens)} / ${formatTokenCount(contextTokenLimit)} tokens used`; contextMeter.setAttribute("aria-label", `Context window ${Math.round(used)}% full, approximately ${formatTokenCount(usedTokens)} of ${formatTokenCount(contextTokenLimit)} tokens used`); }

function beginSidebarResize(event: PointerEvent): void {
  event.preventDefault(); sidebarResizer.classList.add("dragging"); sidebarResizer.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => setSidebarWidth(moveEvent.clientX);
  const finish = () => { sidebarResizer.classList.remove("dragging"); sidebarResizer.removeEventListener("pointermove", move); localStorage.setItem("fitz-sidebar-width", String(sidebarWidth())); };
  sidebarResizer.addEventListener("pointermove", move); sidebarResizer.addEventListener("pointerup", finish, { once: true }); sidebarResizer.addEventListener("pointercancel", finish, { once: true });
}

function resizeSidebarWithKeyboard(event: KeyboardEvent): void { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setSidebarWidth(sidebarWidth() + (event.key === "ArrowRight" ? 12 : -12)); localStorage.setItem("fitz-sidebar-width", String(sidebarWidth())); }
function setSidebarWidth(value: number): void { shell.style.setProperty("--sidebar-width", `${Math.max(190, Math.min(420, value))}px`); sidebarResizer.setAttribute("aria-valuenow", String(Math.round(sidebarWidth()))); }
function sidebarWidth(): number { return Number.parseFloat(getComputedStyle(shell).getPropertyValue("--sidebar-width")) || 254; }
function restoreSidebarWidth(): void { const saved = Number(localStorage.getItem("fitz-sidebar-width")); if (Number.isFinite(saved) && saved > 0) setSidebarWidth(saved); }
function setStatus(text: string, state: string): void { status.textContent = text; status.dataset.state = state; }
function setConnection(text: string, state: string): void { connectionDetail.textContent = text; connectionStatus.dataset.state = state; }
function setFormBusy(formElement: HTMLFormElement, busy: boolean): void { for (const control of formElement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy; }
function showToast(text: string): void { if (toastTimer) clearTimeout(toastTimer); toast.textContent = text; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 3_200); }
function panelEmpty(text: string): HTMLElement { const value = document.createElement("div"); value.className = "panel-empty"; value.textContent = text; return value; }
function loadingMessage(text: string): HTMLElement { const value = document.createElement("div"); value.className = "panel-empty"; value.textContent = text; return value; }
function treeItem(label: string, className: string, icon: SVGElement, action: () => void, menu: (toggle: HTMLButtonElement, event: MouseEvent) => void): HTMLElement {
  const item = document.createElement("div"); item.className = "tree-item";
  const value = document.createElement("button"); value.type = "button"; value.className = className; const text = document.createElement("span"); text.textContent = label; value.append(icon, text); value.addEventListener("click", action);
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "tree-menu-toggle"; toggle.title = `${label} actions`; toggle.setAttribute("aria-label", `${label} actions`); toggle.setAttribute("aria-expanded", "false"); toggle.append(svg('<circle cx="5" cy="10" r="1"></circle><circle cx="10" cy="10" r="1"></circle><circle cx="15" cy="10" r="1"></circle>'));
  toggle.addEventListener("click", (event) => menu(toggle, event)); value.addEventListener("contextmenu", (event) => menu(toggle, event)); item.append(value, toggle); return item;
}

function storedSet(key: string): Set<string> { try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); } catch { return new Set(); } }
function saveSet(key: string, values: Set<string>): void { localStorage.setItem(key, JSON.stringify([...values])); }

async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const response = await window.fitz.request({ path, method, ...(body !== undefined ? { body } : {}) });
  let parsed: Json;
  try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
  if (response.status >= 400) throw new HttpError(parsed.error?.message ?? parsed.error ?? `Request failed (${response.status})`, response.status);
  return parsed;
}

function svg(path: string): SVGElement { const value = document.createElementNS("http://www.w3.org/2000/svg", "svg"); value.setAttribute("viewBox", "0 0 20 20"); value.setAttribute("aria-hidden", "true"); value.innerHTML = path; return value; }
function folderIcon(): SVGElement { return svg('<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>'); }
function chatIcon(): SVGElement { return svg('<path d="M4 4.5h12v9H9l-3.5 2.5v-2.5H4z"></path>'); }
function sparkIcon(): SVGElement { return svg('<path d="M10 2.8c.5 3.7 2.4 5.8 6.2 7.2-3.8 1.4-5.7 3.5-6.2 7.2-.5-3.7-2.4-5.8-6.2-7.2C7.6 8.6 9.5 6.5 10 2.8Z"></path>'); }
function element(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error(`Missing #${id}`); return value; }
function query(selector: string): HTMLElement { const value = document.querySelector<HTMLElement>(selector); if (!value) throw new Error(`Missing ${selector}`); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }
function base64Bytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
function estimateTokens(value: string): number { return value ? Math.max(1, Math.ceil(value.length / 4)) : 0; }
function formatTokenCount(value: number): string { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)); }
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
