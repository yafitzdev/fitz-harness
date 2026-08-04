import type { DesktopUpdateStatus } from "./preload.js";
import { appendMarkdown, setMarkdown } from "./markdown.js";
import { MessageActions, type ActionableMessageRole } from "./ui/chat/message-actions.js";
import { ActivityTimeline } from "./ui/chat/activity-timeline.js";
import { AgentRunController } from "./ui/chat/agent-run-controller.js";
import { Composer } from "./ui/chat/composer.js";
import { ConnectionWorkspaceController, FIXED_ROUTES, type FixedRouteId } from "./ui/connections/connection-workspace.js";
import { InspectorPanel } from "./ui/inspector/inspector-panel.js";
import { ConversationLayout } from "./ui/layout/conversation-layout.js";
import { WorkspacePageController } from "./ui/layout/workspace-pages.js";
import { CustomSelectController } from "./ui/primitives/custom-select.js";
import { ContextMenu } from "./ui/primitives/context-menu.js";
import { requiredElement as element, requiredQuery as query, svgIcon as svg, textBlock } from "./ui/primitives/dom.js";
import { togglePopover as toggleManagedPopover } from "./ui/primitives/popover.js";
import { ResizablePane } from "./ui/primitives/resizable-pane.js";
import { PluginCatalogController } from "./ui/plugins/plugin-catalog.js";
import { ProjectSidebarController, type ProjectSidebarProject, type ProjectSidebarSession } from "./ui/sidebar/project-sidebar.js";

type Json = Record<string, any>;
type AppLocation = { view: "conversation"; projectId?: string; sessionId?: string; newChat?: boolean } | { view: "playbooks" | "connections" | "plugins" | "administration" };
type ProjectRecord = ProjectSidebarProject & Json;
type SessionRecord = ProjectSidebarSession & Json;

let projectRecords: ProjectRecord[] = [];
const sessionsByProject = new Map<string, SessionRecord[]>();
let currentProject: string | undefined;
let currentSession: string | undefined;
let pendingTaskAfterProject = false;
let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTokenEstimate = 0;
let contextTokenLimit = 131_072;
let configuredHostOrigin = "Fitz host";
let administrator = false;
let currentUserId: string | undefined;
let administrationUsers: Json[] = [];
let administrationPolicies: Json[] = [];
let diagnosticBundle: Json | undefined;
let pendingRemoteAction: "enable" | "disable" | undefined;
let pendingStartupAction: "install" | "remove" | undefined;
let managementConfiguration: Json | undefined;
let newChatMode = false;
let newChatProjectDetached = false;
let removeProjectTarget: string | undefined;
let editingRecipe: Json | undefined;
let renameTarget: { kind: "project" | "task"; id: string } | undefined;
let navigationIndex = -1;
let replayingNavigation = false;
const navigationHistory: AppLocation[] = [];
const recipeTestStates = new Map<string, { state: "testing" | "passed" | "failed"; detail: string }>();
let routeCards: Json[] = [];

const shell = query(".app-shell");
const workspaceHeader = query(".workspace-header");
const messages = element("messages");
const workspace = query(".workspace");
const connectionStatus = element("connection-status") as HTMLButtonElement;
const connectionDetail = element("connection-detail");
const projectTitle = element("project-title");
const taskTitle = element("task-title");
const engineState = element("engine-state");
const routeState = element("route-state");
const contextToggle = element("context-toggle") as HTMLButtonElement;
const artifacts = element("artifacts");
const requestQueue = element("request-queue");
const queueCount = element("queue-count");
const artifactFile = element("artifact-file") as HTMLInputElement;
const addArtifactButton = element("add-artifact") as HTMLButtonElement;
const updateButton = element("update") as HTMLButtonElement;
const checkDesktopUpdate = element("check-desktop-update") as HTMLButtonElement;
const installDesktopUpdate = element("install-desktop-update") as HTMLButtonElement;
const desktopUpdateLabel = element("desktop-update-label");
const desktopUpdateVersion = element("desktop-update-version");
const desktopUpdateProgress = element("desktop-update-progress");
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
const appMenuPopover = element("app-menu-popover");
const selectPopover = element("select-popover");
const sidebarContextMenu = element("sidebar-context-menu");
const sidebarResizer = element("sidebar-resizer");
const renameDialog = element("rename-dialog") as HTMLDialogElement;
const renameForm = element("rename-form") as HTMLFormElement;
const renameTaskName = element("rename-task-name") as HTMLInputElement;
const renameHeading = element("rename-heading");
const renameLabel = element("rename-label");
const playbookPage = element("playbook-page");
const connectionsPage = element("connections-page");
const connectionsButton = element("manage-connections") as HTMLButtonElement;
const pluginsPage = element("plugins-page");
const pluginsButton = element("manage-plugins") as HTMLButtonElement;
const pairingPage = element("pairing-page");
const pairingForm = element("pairing-form") as HTMLFormElement;
const pairingCode = element("pairing-code") as HTMLInputElement;
const pairingDisplayName = element("pairing-display-name") as HTMLInputElement;
const pairingDeviceName = element("pairing-device-name") as HTMLInputElement;
const pairingDescription = element("pairing-description");
const pairingError = element("pairing-error");
const administrationPage = element("administration-page");
const administrationButton = element("manage-administration") as HTMLButtonElement;
const pairingCodeForm = element("pairing-code-form") as HTMLFormElement;
const pairingCodeRole = element("pairing-code-role") as HTMLSelectElement;
const pairingCodeTtl = element("pairing-code-ttl") as HTMLSelectElement;
const pairingCodeResult = element("pairing-code-result");
const issuedPairingCode = element("issued-pairing-code");
const issuedPairingExpiry = element("issued-pairing-expiry");
const copyPairingCode = element("copy-pairing-code") as HTMLButtonElement;
const createUserForm = element("create-user-form") as HTMLFormElement;
const createUserName = element("create-user-name") as HTMLInputElement;
const createUserRole = element("create-user-role") as HTMLSelectElement;
const adminUsers = element("admin-users");
const toolPolicyForm = element("tool-policy-form") as HTMLFormElement;
const toolPolicySubjectType = element("tool-policy-subject-type") as HTMLSelectElement;
const toolPolicySubject = element("tool-policy-subject") as HTMLSelectElement;
const toolPolicyName = element("tool-policy-name") as HTMLInputElement;
const toolPolicyDecision = element("tool-policy-decision") as HTMLSelectElement;
const toolPolicies = element("tool-policies");
const adminAuditEvents = element("admin-audit-events");
const diagnosticGeneratedAt = element("diagnostic-generated-at");
const diagnosticSummary = element("diagnostic-summary");
const diagnosticMetrics = element("diagnostic-metrics");
const diagnosticFailures = element("diagnostic-failures");
const exportDiagnostics = element("export-diagnostics") as HTMLButtonElement;
const remoteAccessStatus = element("remote-access-status");
const remoteAccessConfirmation = element("remote-access-confirmation");
const remoteAccessConfirmationText = element("remote-access-confirmation-text");
const enableRemoteAccess = element("enable-remote-access") as HTMLButtonElement;
const disableRemoteAccess = element("disable-remote-access") as HTMLButtonElement;
const confirmRemoteAccess = element("confirm-remote-access") as HTMLButtonElement;
const hostStartupStatus = element("host-startup-status");
const hostStartupConfirmation = element("host-startup-confirmation");
const hostStartupConfirmationText = element("host-startup-confirmation-text");
const installHostStartup = element("install-host-startup") as HTMLButtonElement;
const removeHostStartup = element("remove-host-startup") as HTMLButtonElement;
const confirmHostStartup = element("confirm-host-startup") as HTMLButtonElement;
const playbookList = element("playbook-list");
const playbookSearch = element("playbook-search") as HTMLInputElement;
const managementTitle = element("management-title");
const managementDescription = element("management-description");
const managementBrowser = element("management-browser");
const managementEditor = element("management-editor");
const engineForm = element("engine-form") as HTMLFormElement;
const recipeForm = element("recipe-form") as HTMLFormElement;
const removeProjectDialog = element("remove-project-dialog") as HTMLDialogElement;
const removeProjectForm = element("remove-project-form") as HTMLFormElement;
const removeProjectName = element("remove-project-name");

let conversationLayout: ConversationLayout | undefined;
const sidebarPane = new ResizablePane({
  divider: sidebarResizer, storageKey: "fitz-sidebar-width", defaultValue: 254, minimum: 240, maximum: 520,
  pointerValue: (event) => event.clientX,
  apply: (value) => shell.style.setProperty("--sidebar-width", `${value}px`),
});
const inspectorPanel = new InspectorPanel({
  mount: workspace,
  getProjectRoot: () => String(activeProject()?.rootPath ?? ""),
  getSearchRoots: () => activityTimeline.searchRoots(),
  showToast,
  onLayoutChange: () => conversationLayout?.sync(),
});
const composer = new Composer({
  mount: workspace,
  getProjectRoot: () => String(activeProject()?.rootPath ?? "") || undefined,
  bridge: window.fitz,
  closeAllPopovers: closePopovers,
  onRouteChange: () => handleRouteChange(),
  onCompact: compactCurrentSession,
  onSubmit: (content) => {
    if (agentRuns.active) {
      if (content.trim().length > 0) void steerPrompt(content);
      else void agentRuns.cancel();
    } else void sendPrompt(content);
  },
  onInput: (text) => {
    updateContextMeter();
    refreshComposerState();
    agentRuns.scheduleWarmup(text, composer.controls.routeId);
  },
  onValueChange: () => { updateContextMeter(); refreshComposerState(); },
  onAttach: () => chooseArtifact(),
  onDismissProject: () => { newChatProjectDetached = true; showNewChatLanding(); },
  onPreviewPasted: (kind, dataUrl, mimeType, name) => {
    if (kind === "pdf") inspectorPanel.previewPdf(dataUrl, mimeType, name);
    else inspectorPanel.previewImage(dataUrl, mimeType, name);
  },
  onWorktreeCreated: async (path) => {
    const project = activeProject();
    if (!project) return;
    await api(`/api/v1/projects/${project.id}`, "PATCH", { rootPath: path });
    project.rootPath = path;
  },
  onError: showToast,
  isRunning: () => agentRuns.active,
});
conversationLayout = new ConversationLayout({ workspace, messages, composer: composer.root, scrollButton: composer.scrollButton, inspectorWidth: () => inspectorPanel.width() });
const customSelects = new CustomSelectController(selectPopover, closePopovers);
const sidebarMenu = new ContextMenu(sidebarContextMenu, closePopovers);
const projectSidebar = new ProjectSidebarController({
  elements: {
    tree: element("projects"),
    chatHoverCard: element("chat-hover-card"),
    chatHoverTitle: element("hover-chat-title"),
    chatHoverAge: element("hover-chat-age"),
    chatHoverProject: element("hover-project-name"),
    projectHoverCard: element("project-hover-card"),
    projectHoverTitle: element("hover-project-title"),
    projectHoverTaskCount: element("hover-project-task-count"),
    projectHoverPath: element("hover-project-path") as HTMLButtonElement,
    projectHoverPathLabel: element("hover-project-path-label"),
    projectHoverPin: element("hover-project-pin") as HTMLButtonElement,
    projectHoverEdit: element("hover-project-edit") as HTMLButtonElement,
  },
  menu: sidebarMenu,
  closePopovers,
  selectProject: (projectId) => void selectProject(projectId),
  selectSession: (sessionId, projectId) => void selectSession(sessionId, true, projectId),
  newChat: openNewChatForProject,
  openProjectPath: (path) => void openProjectPath(path),
  createWorktree: openProjectWorktreeSetup,
  editProject: openProjectRenameDialog,
  archiveProjectChats: (projectId) => void archiveProjectChats(projectId),
  removeProject: openRemoveProjectDialog,
  renameSession: (sessionId, projectId) => { currentProject = projectId; currentSession = sessionId; openRenameDialog(); },
  archiveSession: (sessionId, projectId) => { currentProject = projectId; currentSession = sessionId; void archiveCurrentTask(); },
  copyValue: (value, message) => void copyValue(value, message),
  continueSession: (session, projectId) => { currentProject = projectId; void continueInNewChat(session); },
});
const workspacePages = new WorkspacePageController({
  pages: {
    playbooks: playbookPage,
    connections: connectionsPage,
    plugins: pluginsPage,
    administration: administrationPage,
    pairing: pairingPage,
  },
  navigation: {
    playbooks: element("manage-playbooks"),
    connections: connectionsButton,
    plugins: pluginsButton,
    administration: administrationButton,
  },
  setConversationInert,
});
const activityTimeline = new ActivityTimeline({
  messages,
  inspectResource: (reference) => inspectorPanel.inspect(reference),
  decideApproval: async (approvalId, decision) => {
    const response = await api(`/api/v1/tool-approvals/${approvalId}/decision`, "POST", { decision });
    return response.data?.status === "approved" ? "approved" : "denied";
  },
  showToast,
});
const agentRuns = new AgentRunController({
  messages,
  activity: activityTimeline,
  api,
  appendAssistant: () => appendMessage("assistant", ""),
  appendAssistantDelta: (target, delta) => appendMarkdown(target, delta),
  appendSystem: (message) => { appendMessage("system", message); },
  appendChangeSummary: (files) => appendChangeSummary(files),
  addTokenEstimate: (text) => { sessionTokenEstimate += estimateTokens(text); updateContextMeter(); },
  setStatus,
  setEngineState: (state) => { engineState.textContent = state; },
  refreshControls: refreshComposerState,
  queueVisible: () => inspectorPanel.isOpen,
  refreshQueue: loadAgentQueue,
  showToast,
  errorMessage,
  terminalReplayError: (error) => error instanceof HttpError,
});
const connectionWorkspace = new ConnectionWorkspaceController({
  form: element("connection-form") as HTMLFormElement,
  id: element("consumer-connection-id") as HTMLInputElement,
  name: element("consumer-connection-name") as HTMLInputElement,
  url: element("consumer-connection-url") as HTMLInputElement,
  auth: element("consumer-connection-auth") as HTMLSelectElement,
  apiKey: element("consumer-connection-key") as HTMLInputElement,
  apiKeyField: element("consumer-api-key-field"),
  formStatus: element("connection-form-status"),
  connections: element("consumer-connections"),
  listView: element("connection-list-view"),
  editor: element("connection-editor"),
  editorTitle: element("connection-editor-title"),
  search: element("connection-search") as HTMLInputElement,
  refresh: element("refresh-connections") as HTMLButtonElement,
  newConnection: element("new-connection") as HTMLButtonElement,
  editorBack: element("connection-editor-back") as HTMLButtonElement,
  cancelEdit: element("cancel-connection-edit") as HTMLButtonElement,
}, {
  bridge: window.fitz,
  api,
  reloadConfiguration: () => loadManagementConfiguration(false),
  testRecipe,
  renderRecipeTestState,
  closePopovers,
  showToast,
  errorMessage,
});
const pluginCatalog = new PluginCatalogController({
  pluginsView: element("plugins-view"),
  skillsView: element("skills-view"),
  pluginsTab: element("plugins-tab") as HTMLButtonElement,
  skillsTab: element("skills-tab") as HTMLButtonElement,
  pluginSearch: element("plugin-search") as HTMLInputElement,
  skillSearch: element("skill-search") as HTMLInputElement,
  installedPlugins: element("installed-plugins"),
  pluginCatalog: element("plugin-catalog"),
  installedSkills: element("installed-skills"),
  loadMorePlugins: element("load-more-plugins") as HTMLButtonElement,
  refresh: element("refresh-plugins") as HTMLButtonElement,
}, {
  api,
  openExternal: (url) => window.fitz.openExternal(url),
  showToast,
  errorMessage,
});
const messageActions = new MessageActions({
  canEdit: () => !agentRuns.active,
  onEditBlocked: () => showToast("Wait for the current response before editing a message."),
  copyText: (text) => window.fitz.copyText(text),
  resend: (text, article) => sendPrompt(text, article),
});
void initialize();

window.fitz.onNavigationCommand((command) => void navigateHistory(command === "back" ? -1 : 1));
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewChat(); }
  if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); openRenameDialog(); }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); void archiveCurrentTask(); }
  if (event.key === "Escape") { if (!managementEditor.hidden) closeManagementEditor(); else if (connectionWorkspace.editorOpen) connectionWorkspace.closeEditor(); else closePopovers(); }
});

element("new-project").addEventListener("click", () => openProjectDialog());
element("new-session").addEventListener("click", openNewChat);
element("manage-playbooks").addEventListener("click", () => void openPlaybookPage());
connectionsButton.addEventListener("click", () => void openConnectionsPage());
pluginsButton.addEventListener("click", () => void openPluginsPage());
administrationButton.addEventListener("click", () => void openAdministrationPage());
element("refresh-administration").addEventListener("click", () => void loadAdministration());
element("refresh-playbooks").addEventListener("click", () => void loadManagementConfiguration(true));
element("close-management-editor").addEventListener("click", closeManagementEditor);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-management-editor]")) button.addEventListener("click", closeManagementEditor);
playbookSearch.addEventListener("input", renderManagementPage);
element("sidebar-menu").addEventListener("click", toggleSidebar);
for (const menuButton of document.querySelectorAll<HTMLButtonElement>("[data-app-menu]")) menuButton.addEventListener("click", (event) => openAppMenu(menuButton.dataset.appMenu ?? "", menuButton, event));
for (const windowButton of document.querySelectorAll<HTMLButtonElement>("[data-window-action]")) windowButton.addEventListener("click", () => void window.fitz.windowAction(windowButton.dataset.windowAction as "minimize" | "maximize" | "close"));
connectionStatus.addEventListener("click", () => void initialize());
contextToggle.addEventListener("click", () => inspectorPanel.toggle());
window.addEventListener("fitz:open-resource", (event) => {
  const reference = (event as CustomEvent<{ reference?: string }>).detail?.reference;
  if (reference) void inspectorPanel.inspect(reference);
});
element("context-add").addEventListener("click", chooseArtifact);
addArtifactButton.addEventListener("click", chooseArtifact);
artifactFile.addEventListener("change", () => void uploadArtifact());
chooseProjectFolder.addEventListener("click", () => void selectProjectFolder());
taskMenuToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(taskMenu, taskMenuToggle); });
taskMenu.addEventListener("click", (event) => event.stopPropagation());
sidebarContextMenu.addEventListener("click", (event) => event.stopPropagation());
element("rename-task").addEventListener("click", openRenameDialog);
element("archive-task").addEventListener("click", () => void archiveCurrentTask());
renameForm.addEventListener("submit", (event) => { event.preventDefault(); void renameCurrentTask(); });
removeProjectForm.addEventListener("submit", (event) => { event.preventDefault(); void removeProject(); });
updateButton.addEventListener("click", () => void window.fitz.installUpdate());
installDesktopUpdate.addEventListener("click", () => void window.fitz.installUpdate());
checkDesktopUpdate.addEventListener("click", () => void checkForDesktopUpdate());
window.fitz.onUpdateStatus(renderDesktopUpdate);
void window.fitz.updateStatus().then(renderDesktopUpdate).catch(() => renderDesktopUpdate({ state: "error" }));
projectForm.addEventListener("submit", (event) => { event.preventDefault(); void createProject(); });
taskForm.addEventListener("submit", (event) => { event.preventDefault(); void createSession(); });
pairingForm.addEventListener("submit", (event) => { event.preventDefault(); void pairDevice(); });
pairingCodeForm.addEventListener("submit", (event) => { event.preventDefault(); void issuePairingCode(); });
copyPairingCode.addEventListener("click", () => void window.fitz.copyText(issuedPairingCode.textContent ?? ""));
createUserForm.addEventListener("submit", (event) => { event.preventDefault(); void createAdminUser(); });
toolPolicySubjectType.addEventListener("change", renderToolPolicySubjects);
toolPolicyForm.addEventListener("submit", (event) => { event.preventDefault(); void saveToolPolicy(); });
exportDiagnostics.addEventListener("click", () => void exportDiagnosticBundle());
element("refresh-remote-access").addEventListener("click", () => void loadRemoteAccess());
enableRemoteAccess.addEventListener("click", () => showRemoteConfirmation("enable"));
disableRemoteAccess.addEventListener("click", () => showRemoteConfirmation("disable"));
element("cancel-remote-access").addEventListener("click", hideRemoteConfirmation);
confirmRemoteAccess.addEventListener("click", () => void applyRemoteAccessChange());
element("refresh-host-startup").addEventListener("click", () => void loadHostStartup());
installHostStartup.addEventListener("click", () => showStartupConfirmation("install"));
removeHostStartup.addEventListener("click", () => showStartupConfirmation("remove"));
element("cancel-host-startup").addEventListener("click", hideStartupConfirmation);
confirmHostStartup.addEventListener("click", () => void applyStartupChange());
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
    await connectionWorkspace.sync(false);
    const [health, connection, identity] = await Promise.all([api("/health"), window.fitz.connectionInfo(), api("/api/v1/me")]); configuredHostOrigin = connection.origin; currentUserId = identity.data?.user?.id; administrator = identity.data?.authMode === "disabled" || identity.data?.user?.role === "administrator";
    applyNavigation();
    await loadModels();
    engineState.textContent = health.engine?.state ?? "UNLOADED";
    routeState.textContent = composer.controls.routeLabel;
    setConnection(configuredHostOrigin.replace(/^https?:\/\//, ""), "active");
    setStatus(health.engine?.state ?? "Ready", "idle");
    showConversationWorkspace();
    await loadProjects();
    void loadManagementConfiguration(false);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      const bootstrapped = await window.fitz.bootstrapLocalDevice().catch(() => false);
      if (bootstrapped) { await initialize(); return; }
      currentUserId = undefined; administrator = false; administrationButton.hidden = true; configuredHostOrigin = (await window.fitz.connectionInfo()).origin; setConnection("Pair device", "error"); setStatus("Pairing required", "error"); showPairingPage(`Enter a one-time code to connect to ${configuredHostOrigin}.`);
    }
    else { setConnection("Click to retry", "error"); setStatus("Offline", "error"); showConnectionFailure(errorMessage(error)); }
  } finally {
    refreshComposerState();
  }
}

async function loadModels(preferredRoute?: string): Promise<void> {
  const response = await api("/v1/models");
  routeCards = response.data ?? [];
  rebuildRouteLabels(preferredRoute);
}

// Rebuilds the chat route selector's labels from the latest management configuration
// (route → recipe). The selected route is preserved; only the displayed model name
// refreshes, so picks made in the Connections workspace show up in chat immediately.
function rebuildRouteLabels(preferredRoute?: string): void {
  if (!routeCards.length) return;
  const priority = new Map([["default", 0], ["fast", 1], ["smart", 2]]);
  const cards = routeCards.filter((card: Json) => priority.has(String(card.id))).sort((left: Json, right: Json) => (priority.get(left.id) ?? 3) - (priority.get(right.id) ?? 3));
  composer.controls.setRoutes(cards.map((card: Json) => {
    const route = (managementConfiguration?.routes ?? []).find((item: Json) => item.id === card.id);
    const recipe = (managementConfiguration?.recipes ?? []).find((item: Json) => item.id === route?.recipeId);
    const modelName = recipe?.displayName ?? recipe?.modelId;
    return { id: card.id, label: modelName ? `${card.display_name ?? card.id} · ${modelName}` : (card.display_name ?? card.id), group: "Routes" };
  }), preferredRoute);
  routeState.textContent = composer.controls.routeLabel;
  syncComposerContext();
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
  if (currentProject && !projectSidebar.hasExpandedProjects()) projectSidebar.ensureExpanded(currentProject);

  if (preferredSession) currentSession = preferredSession;
  const selectedSessions = currentProject ? sessionsByProject.get(currentProject) ?? [] : [];
  if (!currentSession || !selectedSessions.some((session) => session.id === currentSession)) currentSession = selectedSessions[0]?.id;

  renderProjectTree();
  if (currentSession) await selectSession(currentSession, false);
  else { sessionTokenEstimate = 0; updateContextMeter(); showLanding(); await loadArtifacts(); }
}

function renderProjectTree(): void {
  projectSidebar.render({ projects: projectRecords, sessionsByProject, currentProjectId: currentProject, currentSessionId: currentSession, newChat: newChatMode });
  updateTitles();
}

async function selectProject(id: string): Promise<void> {
  showConversationWorkspace();
  newChatMode = false;
  currentProject = id;
  projectSidebar.ensureExpanded(id);
  const projectSessions = sessionsByProject.get(id) ?? [];
  currentSession = projectSessions[0]?.id;
  renderProjectTree();
  if (currentSession) await selectSession(currentSession, false);
  else { sessionTokenEstimate = 0; updateContextMeter(); showLanding(); await loadArtifacts(); rememberLocation({ view: "conversation", projectId: id }); }
  refreshComposerState();
}

async function selectSession(id: string, rerender = true, projectId?: string): Promise<void> {
  projectSidebar.hideChatHover();
  composer.controls.resetContextStatus();
  showConversationWorkspace();
  newChatMode = false;
  workspace.classList.remove("new-chat-open");
  composer.exitNewChat();
  if (projectId) currentProject = projectId;
  if (currentProject) projectSidebar.ensureExpanded(currentProject);
  currentSession = id;
  const selectedSession = currentSessionRecord();
  if (selectedSession?.routeId) composer.controls.setRoute(selectedSession.routeId);
  syncComposerContext();
  projectSidebar.markSessionRead(id);
  if (rerender) renderProjectTree();
  updateTitles();
  messages.replaceChildren(loadingMessage("Loading conversation…"));
  try {
    const transcript = await api(`/api/v1/sessions/${id}/transcript`);
    composer.rebuildHistory((transcript.data ?? []).filter((entry: Json) => entry.kind === "message" && entry.role === "user" && typeof entry.content?.text === "string" && entry.content.text.length > 0).map((entry: Json) => entry.content.text as string));
    messages.replaceChildren();
    activityTimeline.clear();
    sessionTokenEstimate = estimateTranscriptContext(transcript.data ?? []);
    const transcriptTools = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
    for (const entry of transcript.data ?? []) {
      if (entry.kind === "message") {
        const text = entry.content?.text ?? "";
        if (entry.role === "assistant" && entry.content?.phase === "commentary") appendCommentary(text, entry.createdAt);
        else appendMessage(entry.role ?? "system", text, entry.createdAt);
      }
      if (entry.kind === "tool-call") {
        const toolCallId = String(entry.content?.toolCallId ?? entry.id);
        const toolName = String(entry.content?.toolName ?? "tool");
        const input = entry.content?.input;
        transcriptTools.set(toolCallId, { row: activityTimeline.appendTool(toolName, input, toolCallId, true, entry.createdAt), toolName, input });
      }
      if (entry.kind === "tool-result") {
        const toolCallId = String(entry.content?.toolCallId ?? entry.id);
        const existing = transcriptTools.get(toolCallId);
        if (existing) activityTimeline.completeTool(existing.row, existing.toolName, existing.input, entry.content?.result, Boolean(entry.content?.isError));
        else activityTimeline.completeTool(activityTimeline.appendTool(String(entry.content?.toolName ?? "tool"), undefined, toolCallId, true, entry.createdAt), String(entry.content?.toolName ?? "tool"), undefined, entry.content?.result, Boolean(entry.content?.isError));
      }
      if (entry.kind === "reasoning") {
        const text = entry.content?.text ?? "";
        const row = activityTimeline.appendReasoning(false);
        activityTimeline.appendReasoningDelta(row, text);
        activityTimeline.completeReasoning(row);
      }
      if (entry.kind === "compaction") activityTimeline.appendContext(entry.content?.manual === true ? "Context compacted" : "Context automatically compacted");
    }
    const pendingApprovals = await api(`/api/v1/sessions/${id}/tool-approvals?status=pending`);
    for (const approval of pendingApprovals.data ?? []) activityTimeline.appendApproval(approval);
    updateContextMeter();
    if (!messages.childElementCount) showLanding(true);
    messages.scrollTop = messages.scrollHeight;
    await loadArtifacts();
  } catch (error) {
    messages.replaceChildren();
    appendMessage("system", errorMessage(error));
  }
  refreshComposerState();
  composer.focus();
  rememberLocation({ view: "conversation", ...(currentProject ? { projectId: currentProject } : {}), sessionId: id });
}

function openNewChat(): void {
  if (agentRuns.active) { showToast("Stop the current response before starting a new chat"); return; }
  showConversationWorkspace();
  inspectorPanel.close();
  if (projectRecords.length === 0) { openProjectDialog(true); return; }
  currentProject ??= projectRecords[0]?.id;
  if (!currentProject) return;
  newChatMode = true;
  newChatProjectDetached = false;
  currentSession = undefined;
  sessionTokenEstimate = 0;
  composer.controls.resetContextStatus();
  projectSidebar.ensureExpanded(currentProject);
  workspace.classList.add("new-chat-open");
  connectionWorkspace.setConfiguration(managementConfiguration);
  composer.enterNewChat(projectRecords.find((project) => project.id === currentProject)?.name ?? "Project");
  agentRuns.resetWarmup();
  renderProjectTree();
  showNewChatLanding();
  void composer.refreshBranches();
  updateContextMeter();
  refreshComposerState();
  composer.focus();
  rememberLocation({ view: "conversation", projectId: currentProject, newChat: true });
}

function openNewChatForProject(id: string): void { currentProject = id; projectSidebar.ensureExpanded(id); openNewChat(); }

function showNewChatLanding(): void {
  messages.replaceChildren();
  activityTimeline.clear();
  const project = projectRecords.find((item) => item.id === currentProject);
  const landing = document.createElement("div"); landing.className = "new-chat-landing";
  const mark = document.createElement("div"); mark.className = "landing-mark"; mark.append(terminalCloudIcon());
  const heading = document.createElement("h1");
  if (newChatProjectDetached) heading.textContent = "What should we build?";
  else { heading.append("What should we build in "); const projectName = document.createElement("span"); projectName.className = "landing-project-name"; projectName.textContent = project?.name ?? "this project"; heading.append(projectName, "?"); }
  const suggestions = [
    ["Explore and understand code", '<path d="m4.2 7.4 8.7-4.1 2 4.1-8.8 4.2z"></path><path d="m11.1 4.2 2 4.1M8 10.7l2.5 5.8M6.2 11.6l-1.7 4.1M7.2 14h4.5"></path>'],
    ["Build a new feature, app, or tool", '<path d="m12.8 3.2 4 4-2.5 2.5-4-4z"></path><path d="m11.4 8.6-6.8 6.8M3.6 16.4l2.6-.7-1.9-1.9z"></path>'],
    ["Review code and suggest changes", '<path d="M15.7 7.2A6 6 0 0 0 5 5.4L3.6 7"></path><path d="M3.6 3.8V7h3.2M4.3 12.8A6 6 0 0 0 15 14.6l1.4-1.6"></path><path d="M16.4 16.2V13h-3.2"></path>'],
    ["Fix issues and failures", '<path d="M7 7.2 5.2 4.5M13 7.2l1.8-2.7M6.1 9.1h7.8v6.2H6.1z"></path><path d="M3.5 10.5h2.6M13.9 10.5h2.6M3.8 14.7l2.3-1M16.2 14.7l-2.3-1M8.2 6V4.8h3.6V6M10 9.1v6.2"></path>'],
  ];
  const grid = document.createElement("div"); grid.className = "starter-grid";
  for (const [label, iconPath] of suggestions) {
    const button = document.createElement("button"); button.type = "button"; button.className = "starter-card"; button.append(svg(iconPath!), Object.assign(document.createElement("span"), { textContent: label }));
    button.addEventListener("click", () => { composer.setDraft(label!); composer.focus(); });
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
    const response = await api(`/api/v1/projects/${projectId}/sessions`, "POST", { title, routeId: "default" });
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

async function editProjectFolder(id: string): Promise<void> {
  const folder = await window.fitz.chooseFolder();
  if (!folder) return;
  try { await api(`/api/v1/projects/${id}`, "PATCH", { rootPath: folder }); await loadProjects(id, currentSession); showToast("Source folder updated"); }
  catch (error) { showToast(errorMessage(error)); }
}

function openProjectWorktreeSetup(id: string): void { openNewChatForProject(id); composer.openWorktreeSetup(); }

function openRemoveProjectDialog(id: string): void { const project = projectRecords.find((item) => item.id === id); if (!project) return; removeProjectTarget = id; removeProjectName.textContent = project.name; removeProjectDialog.showModal(); }

async function removeProject(): Promise<void> {
  if (!removeProjectTarget) return; const id = removeProjectTarget; setFormBusy(removeProjectForm, true);
  try { await api(`/api/v1/projects/${id}`, "DELETE"); projectSidebar.removeProjectState(id); removeProjectDialog.close(); removeProjectTarget = undefined; currentProject = currentProject === id ? undefined : currentProject; currentSession = undefined; await loadProjects(currentProject); showToast("Project removed"); }
  catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(removeProjectForm, false); }
}

async function openProjectPath(path: string): Promise<void> { try { await window.fitz.openPath(path); } catch (error) { showToast(errorMessage(error)); } }
async function copyValue(value: string, message: string): Promise<void> { await window.fitz.copyText(value); showToast(message); }

async function archiveProjectChats(id: string): Promise<void> {
  const active = sessionsByProject.get(id) ?? [];
  try { await Promise.all(active.map((session) => api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" }))); currentSession = undefined; await loadProjects(id); showToast(`Archived ${active.length} chat${active.length === 1 ? "" : "s"}`); }
  catch (error) { showToast(errorMessage(error)); }
}

async function continueInNewChat(session: ProjectSidebarSession): Promise<void> {
  if (!currentProject) return;
  try { const response = await api(`/api/v1/projects/${currentProject}/sessions`, "POST", { title: `Continue: ${session.title}` }); await loadProjects(currentProject, response.data.id); showToast("Created continuation chat"); }
  catch (error) { showToast(errorMessage(error)); }
}

async function openPlaybookPage(): Promise<void> {
  if (!pairingPage.hidden) { pairingCode.focus(); return; }
  closePopovers();
  inspectorPanel.close();
  closeManagementEditor();
  workspacePages.show("playbooks");
  playbookList.replaceChildren(panelEmpty("Loading playbooks…"));
  await loadManagementConfiguration(true);
  rememberLocation({ view: "playbooks" });
}

async function openConnectionsPage(): Promise<void> { if (!pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); closeManagementEditor(); connectionWorkspace.closeEditor(); workspacePages.show("connections"); await connectionWorkspace.sync(false); rememberLocation({ view: "connections" }); }
async function openPluginsPage(): Promise<void> { if (!administrator || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); closeManagementEditor(); connectionWorkspace.closeEditor(); workspacePages.show("plugins"); pluginCatalog.showLoading(); await pluginCatalog.load(false); rememberLocation({ view: "plugins" }); }
async function openAdministrationPage(): Promise<void> { if (!administrator || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); closeManagementEditor(); workspacePages.show("administration"); adminUsers.replaceChildren(panelEmpty("Loading users…")); await loadAdministration(); rememberLocation({ view: "administration" }); }
function showPairingPage(message: string): void { closePopovers(); inspectorPanel.close(); closeManagementEditor(); workspacePages.show("pairing"); pairingDescription.textContent = message || "Enter a one-time code from your Fitz host."; pairingError.hidden = true; pairingError.textContent = ""; pairingCode.focus(); }
function showConversationWorkspace(): void { closeManagementEditor(); workspacePages.show("conversation"); }
function setConversationInert(inert: boolean): void { for (const area of [workspaceHeader, messages, composer.root]) { area.toggleAttribute("inert", inert); area.setAttribute("aria-hidden", String(inert)); } }

function rememberLocation(location: AppLocation): void {
  if (replayingNavigation) return;
  const previous = navigationHistory[navigationIndex];
  if (previous && JSON.stringify(previous) === JSON.stringify(location)) return;
  navigationHistory.splice(navigationIndex + 1);
  navigationHistory.push(location);
  navigationIndex = navigationHistory.length - 1;
}

async function navigateHistory(offset: -1 | 1): Promise<void> {
  const nextIndex = navigationIndex + offset;
  const location = navigationHistory[nextIndex];
  if (!location || agentRuns.active) return;
  navigationIndex = nextIndex;
  replayingNavigation = true;
  try {
    if (location.view === "playbooks") await openPlaybookPage();
    else if (location.view === "connections") await openConnectionsPage();
    else if (location.view === "plugins") await openPluginsPage();
    else if (location.view === "administration") await openAdministrationPage();
    else if (location.view === "conversation") {
      if (location.newChat && location.projectId) { currentProject = location.projectId; openNewChat(); }
      else if (location.sessionId) await selectSession(location.sessionId, true, location.projectId);
      else if (location.projectId) await selectProject(location.projectId);
    }
  } finally {
    replayingNavigation = false;
  }
}

function applyNavigation(): void {
  element("manage-playbooks").hidden = false;
  connectionsButton.hidden = false;
  pluginsButton.hidden = !administrator;
  administrationButton.hidden = !administrator;
}

async function pairDevice(): Promise<void> {
  setFormBusy(pairingForm, true); pairingError.hidden = true; pairingError.textContent = "";
  try {
    const response = await window.fitz.pairDevice({ code: pairingCode.value.trim(), displayName: pairingDisplayName.value.trim(), deviceName: pairingDeviceName.value.trim() }); let parsed: Json;
    try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
    if (response.status >= 400) throw new HttpError(parsed.error?.message ?? parsed.error ?? `Pairing failed (${response.status})`, response.status);
    pairingCode.value = ""; await initialize();
  } catch (error) { pairingError.textContent = errorMessage(error); pairingError.hidden = false; }
  finally { setFormBusy(pairingForm, false); }
}

async function issuePairingCode(): Promise<void> {
  setFormBusy(pairingCodeForm, true);
  try {
    const response = await api("/api/v1/management/pairing-codes", "POST", {
      intendedRole: pairingCodeRole.value,
      ttlSeconds: Number(pairingCodeTtl.value),
    });
    issuedPairingCode.textContent = response.data.code;
    issuedPairingExpiry.textContent = `Expires ${new Date(response.data.expiresAt).toLocaleString()}`;
    pairingCodeResult.hidden = false;
  }
  catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(pairingCodeForm, false); }
}

async function createAdminUser(): Promise<void> {
  setFormBusy(createUserForm, true);
  try {
    await api("/api/v1/management/users", "POST", {
      displayName: createUserName.value.trim(),
      role: createUserRole.value,
    });
    createUserName.value = "";
    await loadAdministration();
  }
  catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(createUserForm, false); }
}

async function loadAdministration(): Promise<void> {
  if (!administrator) return;
  try {
    const [users, policies, audit, diagnostics, remote, startup] = await Promise.all([
      api("/api/v1/management/users"),
      api("/api/v1/management/tool-policies"),
      api("/api/v1/management/audit-events?limit=50"),
      api("/api/v1/management/diagnostics"),
      api("/api/v1/management/connectivity/status"),
      api("/api/v1/management/startup"),
    ]);
    administrationUsers = users.data ?? [];
    administrationPolicies = policies.data ?? [];
    const access = await Promise.all(administrationUsers.map((user) =>
      api(`/api/v1/management/users/${user.id}/access`).then((response) => response.data),
    ));
    adminUsers.replaceChildren(...access.map(renderAdminUser));
    if (!access.length) adminUsers.append(panelEmpty("No users yet"));
    renderToolPolicySubjects();
    renderToolPolicies();
    renderAdminAuditEvents(audit.data ?? []);
    diagnosticBundle = diagnostics;
    renderDiagnostics(diagnostics);
    renderRemoteAccess(remote.data);
    renderHostStartup(startup.data);
  }
  catch (error) { adminUsers.replaceChildren(panelEmpty(`Administration unavailable: ${errorMessage(error)}`)); }
}

function renderAdminUser(access: Json): HTMLElement {
  const user = access.user as Json;
  const activeDevices = (access.devices ?? []).filter((device: Json) => !device.revokedAt).length;
  const details = document.createElement("details");
  details.className = "admin-user";

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "admin-user-title";
  title.append(
    Object.assign(document.createElement("strong"), { textContent: user.displayName }),
    Object.assign(document.createElement("small"), { textContent: `${activeDevices} active device${activeDevices === 1 ? "" : "s"}` }),
  );
  const role = document.createElement("select");
  role.setAttribute("aria-label", `Role for ${user.displayName}`);
  for (const value of ["consumer", "agent", "administrator"]) {
    role.add(new Option(value[0]!.toUpperCase() + value.slice(1), value));
  }
  role.value = user.role;
  role.disabled = user.id === currentUserId;
  role.addEventListener("click", (event) => event.stopPropagation());
  role.addEventListener("change", () => void updateAdminUser(user.id, { role: role.value }));
  const status = document.createElement("span");
  status.className = "admin-user-status";
  status.textContent = user.id === currentUserId ? "Current user" : user.status;
  summary.append(title, role, status);

  const body = document.createElement("div");
  body.className = "admin-user-body";
  const routesHeading = document.createElement("h3");
  routesHeading.textContent = "Routes";
  const routeList = document.createElement("div");
  routeList.className = "admin-routes";
  for (const route of FIXED_ROUTES) {
    const label = document.createElement("label");
    label.className = "admin-route";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = route.id;
    input.checked = user.role === "administrator" || (access.routeIds ?? []).includes(route.id);
    input.disabled = user.role === "administrator";
    label.append(input, route.label);
    routeList.append(label);
  }

  const quotaHeading = document.createElement("h3");
  quotaHeading.textContent = "Quotas";
  const quota = document.createElement("div");
  quota.className = "admin-access";
  const quotaFields = [
    ["maxRequestsPerMinute", "Requests / minute"],
    ["maxPromptChars", "Prompt characters"],
    ["maxOutputTokens", "Output tokens"],
    ["maxQueueDepth", "Queue depth"],
  ];
  for (const [key, labelText] of quotaFields) {
    const label = document.createElement("label");
    label.textContent = labelText!;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.value = String(access.quota?.[key!] ?? 1);
    input.dataset.quota = key!;
    label.append(input);
    quota.append(label);
  }

  const devicesHeading = document.createElement("h3");
  devicesHeading.textContent = "Devices";
  const devices = document.createElement("div");
  devices.className = "admin-devices";
  for (const device of access.devices ?? []) {
    const item = document.createElement("span");
    item.className = "admin-device";
    const current = device.id === access.currentDeviceId;
    item.append(Object.assign(document.createElement("span"), {
      textContent: `${device.name}${current ? " · current" : ""}${device.revokedAt ? " · revoked" : ""}`,
    }));
    if (!device.revokedAt && !current) {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.title = `Revoke ${device.name}`;
      revoke.setAttribute("aria-label", revoke.title);
      revoke.textContent = "×";
      revoke.addEventListener("click", () => void revokeAdminDevice(device.id));
      item.append(revoke);
    }
    devices.append(item);
  }
  if (!(access.devices ?? []).length) devices.append(panelEmpty("No devices"));

  const actions = document.createElement("div");
  actions.className = "admin-user-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save access";
  save.addEventListener("click", () => void saveAdminAccess(user.id, details, save));
  actions.append(save);
  if (user.id !== currentUserId) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = user.status === "active" ? "danger" : "";
    toggle.textContent = user.status === "active" ? "Disable user" : "Enable user";
    toggle.addEventListener("click", () => void updateAdminUser(user.id, { status: user.status === "active" ? "disabled" : "active" }));
    actions.append(toggle);
  }
  body.append(routesHeading, routeList, quotaHeading, quota, devicesHeading, devices, actions);
  details.append(summary, body);
  return details;
}

function renderToolPolicySubjects(): void {
  const previous = toolPolicySubject.value;
  toolPolicySubject.replaceChildren();
  if (toolPolicySubjectType.value === "role") {
    for (const role of ["consumer", "agent", "administrator"]) toolPolicySubject.add(new Option(role, role));
  } else {
    for (const user of administrationUsers) toolPolicySubject.add(new Option(user.displayName, user.id));
  }
  if ([...toolPolicySubject.options].some((option) => option.value === previous)) toolPolicySubject.value = previous;
}

function renderToolPolicies(): void {
  toolPolicies.replaceChildren();
  for (const policy of administrationPolicies) {
    const row = document.createElement("div");
    row.className = "tool-policy";
    const subject = policy.subjectType === "user"
      ? administrationUsers.find((user) => user.id === policy.subjectId)?.displayName ?? policy.subjectId
      : policy.subjectId;
    row.append(
      Object.assign(document.createElement("strong"), { textContent: policy.toolName }),
      Object.assign(document.createElement("span"), { textContent: `${policy.subjectType}: ${subject}` }),
      Object.assign(document.createElement("em"), { textContent: policy.decision }),
    );
    toolPolicies.append(row);
  }
  if (!administrationPolicies.length) toolPolicies.append(panelEmpty("No explicit tool policies"));
}

function renderAdminAuditEvents(events: Json[]): void {
  adminAuditEvents.replaceChildren();
  for (const event of events) {
    const row = document.createElement("div");
    row.className = "admin-audit-event";
    const actor = administrationUsers.find((user) => user.id === event.actorUserId)?.displayName ?? "System";
    const timestamp = String(event.timestamp ?? "");
    const target = event.targetType ?? "system";
    row.append(
      Object.assign(document.createElement("strong"), { textContent: event.action }),
      Object.assign(document.createElement("span"), { textContent: `${actor} · ${target}${event.targetId ? ` · ${event.targetId}` : ""}` }),
      Object.assign(document.createElement("time"), { textContent: timestamp ? new Date(timestamp).toLocaleString() : "", dateTime: timestamp }),
    );
    adminAuditEvents.append(row);
  }
  if (!events.length) adminAuditEvents.append(panelEmpty("No activity yet"));
}

function renderDiagnostics(diagnostics: Json): void {
  diagnosticGeneratedAt.textContent = diagnostics.generatedAt
    ? `Captured ${new Date(diagnostics.generatedAt).toLocaleString()} · values are redacted before leaving the host`
    : "";
  diagnosticSummary.replaceChildren();
  const stats = [
    ["Engine", diagnostics.engine?.state ?? "Unknown"],
    ["Queue", String(diagnostics.queueDepth ?? 0)],
    ["Free RAM", diagnosticMib(diagnostics.resources?.freeRamMiB, diagnostics.resources?.totalRamMiB)],
    ["Free VRAM", diagnosticMib(diagnostics.resources?.freeVramMiB, diagnostics.resources?.totalVramMiB)],
  ];
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "diagnostic-stat";
    stat.append(
      Object.assign(document.createElement("small"), { textContent: label }),
      Object.assign(document.createElement("strong"), { textContent: value }),
    );
    diagnosticSummary.append(stat);
  }

  const metricRows: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(diagnostics.metrics?.counters ?? {})) metricRows.push([name, Number(value).toLocaleString()]);
  for (const [name, value] of Object.entries(diagnostics.metrics?.gauges ?? {})) metricRows.push([name, String(value)]);
  for (const [name, value] of Object.entries<Json>(diagnostics.metrics?.timings ?? {})) metricRows.push([name, `${Number(value.averageMs ?? 0).toFixed(1)} ms avg`]);
  renderDiagnosticRows(diagnosticMetrics, metricRows, "No metrics recorded yet");

  const failures: Array<[string, string]> = [];
  for (const request of diagnostics.recentRequests ?? []) {
    if (["failed", "interrupted", "cancelled"].includes(request.status)) failures.push([`${request.routeId} · ${request.status}`, request.errorCode ?? request.id]);
  }
  for (const event of diagnostics.recentLifecycleEvents ?? []) {
    if (event.data?.state === "FAILED") failures.push([event.data.recipeId ?? "engine", event.data.reason ?? "Engine failed"]);
  }
  renderDiagnosticRows(diagnosticFailures, failures.slice(0, 20), "No recent failures");
}

function renderDiagnosticRows(container: HTMLElement, rows: Array<[string, string]>, empty: string): void {
  container.replaceChildren();
  for (const [name, value] of rows) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    row.append(
      Object.assign(document.createElement("span"), { textContent: name }),
      Object.assign(document.createElement("strong"), { textContent: value }),
    );
    container.append(row);
  }
  if (!rows.length) container.append(panelEmpty(empty));
}

function diagnosticMib(free: unknown, total: unknown): string {
  if (!Number.isFinite(Number(free)) || !Number.isFinite(Number(total))) return "Unavailable";
  return `${Math.round(Number(free)).toLocaleString()} / ${Math.round(Number(total)).toLocaleString()} MiB`;
}

async function exportDiagnosticBundle(): Promise<void> {
  if (!diagnosticBundle) return;
  exportDiagnostics.disabled = true;
  try {
    const path = await window.fitz.saveDiagnostics(JSON.stringify(diagnosticBundle, null, 2));
    if (path) showToast(`Diagnostics saved to ${path}`);
  } catch (error) { showToast(errorMessage(error)); }
  finally { exportDiagnostics.disabled = false; }
}

async function checkForDesktopUpdate(): Promise<void> {
  checkDesktopUpdate.disabled = true;
  try { await window.fitz.checkForUpdates(); }
  catch { renderDesktopUpdate({ state: "error" }); }
  finally { if (desktopUpdateLabel.dataset.state !== "checking" && desktopUpdateLabel.dataset.state !== "downloading") checkDesktopUpdate.disabled = false; }
}

function renderDesktopUpdate(update: DesktopUpdateStatus): void {
  const percent = update.state === "downloaded" ? 100 : Math.max(0, Math.min(100, update.percent ?? 0));
  const labels: Record<DesktopUpdateStatus["state"], string> = {
    idle: "Ready to check",
    checking: "Checking for updates…",
    available: "Update found. Download starting…",
    downloading: `Downloading update · ${Math.round(percent)}%`,
    current: "Fitz is up to date",
    downloaded: "Update ready to install",
    error: "Update check failed",
    development: "Update checks are available in packaged builds",
  };
  desktopUpdateLabel.textContent = labels[update.state];
  desktopUpdateLabel.dataset.state = update.state;
  desktopUpdateVersion.textContent = update.version ? `Version ${update.version}` : "";
  desktopUpdateProgress.style.width = `${percent}%`;
  const busy = update.state === "checking" || update.state === "available" || update.state === "downloading";
  checkDesktopUpdate.disabled = busy;
  installDesktopUpdate.hidden = update.state !== "downloaded";
  updateButton.hidden = update.state !== "downloaded";
}

async function loadRemoteAccess(): Promise<void> {
  try {
    const response = await api("/api/v1/management/connectivity/status");
    renderRemoteAccess(response.data);
  } catch (error) { remoteAccessStatus.replaceChildren(panelEmpty(`Remote status unavailable: ${errorMessage(error)}`)); }
}

function renderRemoteAccess(remote: Json): void {
  const tailscale = remote.tailscale ?? {};
  const configuration = remote.serve?.configuration;
  const served = remote.serve?.available === true && configuration && Object.keys(configuration).length > 0;
  const values = [
    ["Tailscale", String(tailscale.state ?? "unknown").replaceAll("-", " ")],
    ["Device", tailscale.dnsName ?? tailscale.addresses?.[0] ?? "Not connected"],
    ["Private HTTPS", remote.serve?.available === false ? "Unavailable" : served ? "Enabled" : "Disabled"],
  ];
  remoteAccessStatus.replaceChildren();
  for (const [label, value] of values) {
    const card = document.createElement("div");
    card.className = "remote-access-card";
    card.append(
      Object.assign(document.createElement("small"), { textContent: label }),
      Object.assign(document.createElement("strong"), { textContent: value }),
    );
    remoteAccessStatus.append(card);
  }
  enableRemoteAccess.disabled = tailscale.state !== "connected" || served;
  disableRemoteAccess.disabled = !served;
}

function showRemoteConfirmation(action: "enable" | "disable"): void {
  pendingRemoteAction = action;
  remoteAccessConfirmationText.textContent = action === "enable"
    ? "Enable private HTTPS through Tailscale Serve for this Fitz host?"
    : "Disable the private HTTPS route? Remote clients will disconnect.";
  confirmRemoteAccess.textContent = action === "enable" ? "Confirm enable" : "Confirm disable";
  remoteAccessConfirmation.hidden = false;
}

function hideRemoteConfirmation(): void {
  pendingRemoteAction = undefined;
  remoteAccessConfirmation.hidden = true;
}

async function applyRemoteAccessChange(): Promise<void> {
  if (!pendingRemoteAction) return;
  const action = pendingRemoteAction;
  confirmRemoteAccess.disabled = true;
  try {
    if (action === "enable") await api("/api/v1/management/connectivity/tailscale-serve", "POST", {});
    else await api("/api/v1/management/connectivity/tailscale-serve", "DELETE");
    hideRemoteConfirmation();
    await loadAdministration();
    showToast(action === "enable" ? "Private HTTPS enabled" : "Private HTTPS disabled");
  } catch (error) { showToast(errorMessage(error)); }
  finally { confirmRemoteAccess.disabled = false; }
}

async function loadHostStartup(): Promise<void> {
  try {
    const response = await api("/api/v1/management/startup");
    renderHostStartup(response.data);
  } catch (error) { hostStartupStatus.replaceChildren(panelEmpty(`Startup status unavailable: ${errorMessage(error)}`)); }
}

function renderHostStartup(startup: Json): void {
  hostStartupStatus.replaceChildren(
    Object.assign(document.createElement("strong"), { textContent: startup.configured ? "Starts at sign-in" : "Does not start at sign-in" }),
    Object.assign(document.createElement("span"), { textContent: startup.message ?? (startup.available ? "Per-user Windows startup" : "Packaged host launcher unavailable") }),
  );
  installHostStartup.disabled = !startup.available || startup.configured;
  removeHostStartup.disabled = !startup.configured;
}

function showStartupConfirmation(action: "install" | "remove"): void {
  pendingStartupAction = action;
  hostStartupConfirmationText.textContent = action === "install"
    ? "Start the lightweight Fitz host automatically at Windows sign-in?"
    : "Remove Fitz host from Windows sign-in startup?";
  confirmHostStartup.textContent = action === "install" ? "Confirm startup" : "Confirm removal";
  hostStartupConfirmation.hidden = false;
}

function hideStartupConfirmation(): void {
  pendingStartupAction = undefined;
  hostStartupConfirmation.hidden = true;
}

async function applyStartupChange(): Promise<void> {
  if (!pendingStartupAction) return;
  const action = pendingStartupAction;
  confirmHostStartup.disabled = true;
  try {
    await api("/api/v1/management/startup", action === "install" ? "POST" : "DELETE", action === "install" ? {} : undefined);
    hideStartupConfirmation();
    await loadAdministration();
    showToast(action === "install" ? "Host will start at sign-in" : "Host startup removed");
  } catch (error) { showToast(errorMessage(error)); }
  finally { confirmHostStartup.disabled = false; }
}

async function saveToolPolicy(): Promise<void> {
  setFormBusy(toolPolicyForm, true);
  try {
    const subjectType = toolPolicySubjectType.value;
    const subjectId = toolPolicySubject.value;
    const toolName = toolPolicyName.value.trim();
    if (!subjectId) throw new Error("Choose a policy subject");
    await api(`/api/v1/management/tool-policies/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}/${encodeURIComponent(toolName)}`, "PUT", {
      decision: toolPolicyDecision.value,
    });
    toolPolicyName.value = "";
    await loadAdministration();
  } catch (error) { showToast(errorMessage(error)); }
  finally { setFormBusy(toolPolicyForm, false); }
}

async function updateAdminUser(userId: string, update: Json): Promise<void> {
  try {
    await api(`/api/v1/management/users/${userId}`, "PATCH", update);
    await loadAdministration();
  } catch (error) { showToast(errorMessage(error)); }
}

async function revokeAdminDevice(deviceId: string): Promise<void> {
  try {
    await api(`/api/v1/management/devices/${deviceId}`, "DELETE");
    await loadAdministration();
  } catch (error) { showToast(errorMessage(error)); }
}

async function saveAdminAccess(userId: string, card: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const routeIds = [...card.querySelectorAll<HTMLInputElement>(".admin-route input:checked")].map((input) => input.value);
    const quota: Json = {};
    for (const input of card.querySelectorAll<HTMLInputElement>("[data-quota]")) quota[input.dataset.quota!] = Number(input.value);
    await Promise.all([
      api(`/api/v1/management/users/${userId}/routes`, "PUT", { routeIds }),
      api(`/api/v1/management/users/${userId}/quota`, "PUT", quota),
    ]);
    showToast("Access saved");
  } catch (error) { showToast(errorMessage(error)); }
  finally { button.disabled = false; }
}

async function loadManagementConfiguration(renderPage: boolean): Promise<Json | undefined> {
  try {
    managementConfiguration = await api("/api/v1/management/status");
    syncContextLimit();
    updateContextMeter();
    connectionWorkspace.setConfiguration(managementConfiguration);
    rebuildRouteLabels();
    if (renderPage) renderManagementPage();
  } catch (error) {
    if (renderPage) playbookList.replaceChildren(panelEmpty(`Management data is unavailable: ${errorMessage(error)}`));
  }
  return managementConfiguration;
}

function syncContextLimit(): void {
  const route = managementConfiguration?.routes?.find((item: Json) => item.id === composer.controls.routeId);
  const recipe = managementConfiguration?.recipes?.find((item: Json) => item.id === route?.recipeId);
  if (Number.isFinite(recipe?.contextTokens) && recipe.contextTokens > 0) contextTokenLimit = recipe.contextTokens;
}

function renderManagementPage(): void {
  const configuration = managementConfiguration;
  playbookList.replaceChildren();
  managementTitle.textContent = "Playbooks";
  managementDescription.textContent = "Engine folders appear automatically. Configure and test their recipes here.";
  playbookSearch.placeholder = "Search playbooks";
  if (!configuration) { playbookList.append(panelEmpty("Management data is unavailable")); return; }
  const recipes = configuration.recipes ?? [];
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
      const name = document.createElement("span"); name.className = "recipe-display-name"; name.textContent = recipe.displayName;
      const labels = document.createElement("div"); labels.className = "recipe-card-labels";
      const modelLabel = document.createElement("span"); modelLabel.className = "recipe-card-label"; modelLabel.textContent = recipe.modelId;
      const contextLabel = document.createElement("span"); contextLabel.className = "recipe-card-label recipe-context-label"; contextLabel.textContent = `${formatTokenCount(recipe.contextTokens)} ctx`;
      labels.append(modelLabel, contextLabel); recipeDetails.append(name, labels);
      const recipeActions = document.createElement("div"); recipeActions.className = "recipe-card-actions";
      const testButton = document.createElement("button"); testButton.type = "button"; testButton.className = "recipe-test-button"; testButton.setAttribute("aria-live", "polite"); testButton.addEventListener("click", (event) => { event.stopPropagation(); void testRecipe(recipe, recipeCard, testButton); });
      recipeActions.append(testButton); renderRecipeTestState(recipe.id, recipeCard, testButton);
      recipeCard.append(recipeDetails, recipeActions); card.append(recipeCard);
    }
    playbookList.append(card);
  }
}

async function testRecipe(recipe: Json, card: HTMLElement, button: HTMLButtonElement): Promise<void> {
  recipeTestStates.set(recipe.id, { state: "testing", detail: "Sending “Say hi.” to this recipe" });
  renderRecipeTestState(recipe.id, card, button);
  try {
    const response = await api(`/api/v1/management/recipes/${encodeURIComponent(recipe.id)}/test`, "POST");
    recipeTestStates.set(recipe.id, { state: "passed", detail: String(response.data?.output ?? "Recipe returned a response") });
  } catch (error) {
    recipeTestStates.set(recipe.id, { state: "failed", detail: errorMessage(error) });
  }
  renderRecipeTestState(recipe.id, card, button);
}

function renderRecipeTestState(recipeId: string, card: HTMLElement, button: HTMLButtonElement): void {
  const result = recipeTestStates.get(recipeId);
  const state = result?.state ?? "idle";
  button.disabled = state === "testing";
  button.classList.toggle("testing", state === "testing");
  button.classList.toggle("passed", state === "passed");
  button.classList.toggle("failed", state === "failed");
  card.classList.toggle("recipe-test-passed", state === "passed");
  card.classList.toggle("recipe-test-failed", state === "failed");
  button.textContent = state === "testing" ? "Testing…" : state === "passed" ? "✓ Working" : state === "failed" ? "Retry" : "Test";
  button.title = result?.detail ?? "Send “Say hi.” directly to this recipe";
  button.setAttribute("aria-label", state === "passed" ? "Recipe test passed" : state === "failed" ? `Recipe test failed: ${result?.detail ?? "Unknown error"}. Retry` : state === "testing" ? "Testing recipe" : "Test recipe");
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
      lifecycle: editingRecipe?.lifecycle ?? { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
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

function activeProject(): Json | undefined { return projectRecords.find((project) => project.id === currentProject); }

async function updateSessionBinding(): Promise<void> {
  const session = currentSessionRecord();
  if (!session || !composer.controls.routeId) return;
  try {
    const response = await api(`/api/v1/sessions/${session.id}`, "PATCH", { routeId: composer.controls.routeId });
    Object.assign(session, response.data);
  } catch (error) { showToast(errorMessage(error)); }
}

function handleRouteChange(): void {
  routeState.textContent = composer.controls.routeLabel;
  agentRuns.resetWarmup();
  agentRuns.scheduleWarmup(composer.value, composer.controls.routeId);
  if (currentSession) void updateSessionBinding();
  syncComposerContext();
}

function syncComposerContext(): void {
  syncContextLimit();
  updateContextMeter();
}

function openAppMenu(name: string, toggle: HTMLButtonElement, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const reopening = appMenuPopover.dataset.menu === name && !appMenuPopover.hidden;
  closePopovers();
  if (reopening) return;
  appMenuPopover.dataset.menu = name;
  appMenuPopover.replaceChildren();
  const separator = () => appMenuPopover.append(document.createElement("hr"));
  const item = (label: string, icon: string, action: () => void, shortcut = "") => {
    const button = document.createElement("button"); button.type = "button";
    const text = document.createElement("span"); text.className = "menu-label"; text.textContent = label;
    button.append(svg(icon), text);
    if (shortcut) { const key = document.createElement("kbd"); key.textContent = shortcut; button.append(key); }
    button.addEventListener("click", (clickEvent) => { clickEvent.stopPropagation(); closePopovers(); action(); });
    appMenuPopover.append(button);
  };
  const edit = (command: "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" | "reload" | "devtools") => () => void window.fitz.editCommand(command);
  if (name === "File") {
    item("New chat", '<path d="M4 4h12v12H4z"></path><path d="M7 10h6M10 7v6"></path>', openNewChat, "Ctrl+N");
    item("New project", '<path d="M3 6h5l1.5 2H17v8H3z"></path><path d="M3 6V4h5l1.5 2"></path>', openProjectDialog);
    separator();
    item("Close window", '<path d="m5 5 10 10M15 5 5 15"></path>', () => void window.fitz.windowAction("close"));
  } else if (name === "Edit") {
    item("Undo", '<path d="M7 7H3V3"></path><path d="M3 7c2-3 5-4 8-3 3 1 5 4 5 7"></path>', edit("undo"), "Ctrl+Z");
    item("Redo", '<path d="M13 7h4V3"></path><path d="M17 7c-2-3-5-4-8-3-3 1-5 4-5 7"></path>', edit("redo"), "Ctrl+Y");
    separator();
    item("Cut", '<circle cx="6" cy="15" r="2"></circle><circle cx="14" cy="15" r="2"></circle><path d="m7.5 13.5 7-9M12.5 13.5l-7-9"></path>', edit("cut"), "Ctrl+X");
    item("Copy", '<rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path>', edit("copy"), "Ctrl+C");
    item("Paste", '<rect x="5" y="5" width="10" height="12" rx="2"></rect><path d="M8 5V3h4v2"></path>', edit("paste"), "Ctrl+V");
    item("Select all", '<path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4"></path>', edit("select-all"), "Ctrl+A");
  } else if (name === "View") {
    item("Toggle sidebar", '<rect x="3" y="4" width="14" height="12" rx="2"></rect><path d="M7 4v12"></path>', toggleSidebar, "Ctrl+B");
    item("Reload", '<path d="M16 7V3l-2 2a6 6 0 1 0 1 8"></path>', edit("reload"), "Ctrl+R");
    item("Developer tools", '<path d="m7 6-4 4 4 4M13 6l4 4-4 4M11 4 9 16"></path>', edit("devtools"));
  } else if (name === "Help") {
    item("Fitz Codex on GitHub", '<circle cx="10" cy="10" r="7"></circle><path d="M8 8a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5M10 14h.01"></path>', () => void window.fitz.openExternal("https://github.com/yafitzdev/fitz-codex"));
  }
  const rect = toggle.getBoundingClientRect();
  appMenuPopover.style.left = `${rect.left}px`;
  appMenuPopover.style.top = `${rect.bottom + 3}px`;
  appMenuPopover.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
}

function togglePopover(popover: HTMLElement, toggle: HTMLButtonElement): void {
  toggleManagedPopover(popover, toggle, closePopovers);
}

function closePopovers(): void {
  customSelects.close();
  appMenuPopover.hidden = true;
  composer.closePopovers();
  taskMenu.hidden = true;
  sidebarContextMenu.hidden = true;
  projectSidebar.hideOverlays();
  taskMenuToggle.setAttribute("aria-expanded", "false");
  projectSidebar.resetMenuToggles();
  for (const toggle of document.querySelectorAll("[data-app-menu]")) toggle.setAttribute("aria-expanded", "false");
}

async function sendPrompt(submittedContent?: string, existingUserMessage?: HTMLElement): Promise<void> {
  const content = (submittedContent ?? composer.value).trim();
  const attachments = composer.consumePastedAttachments();
  if (!content && attachments.length === 0) return;
  if (!currentSession && newChatMode && currentProject) {
    try {
      const title = content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
      const response = await api(`/api/v1/projects/${currentProject}/sessions`, "POST", { title, routeId: composer.controls.routeId as FixedRouteId });
      const sessions = sessionsByProject.get(currentProject) ?? [];
      sessions.unshift(response.data);
      sessionsByProject.set(currentProject, sessions);
      currentSession = response.data.id;
      newChatMode = false;
      workspace.classList.remove("new-chat-open");
      composer.exitNewChat();
      renderProjectTree();
    } catch (error) { showToast(errorMessage(error)); return; }
  }
  if (!currentSession) { openNewChat(); return; }
  if (!composer.controls.routeId) { showToast("No model route is available"); return; }
  composer.clearDraft();
  agentRuns.resetWarmup();
  // Upload pasted files as artifacts; images become multi-modal message parts
  const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const pasted of attachments) {
    try {
      const response = await api(`/api/v1/sessions/${currentSession}/artifacts`, "POST", {
        name: pasted.kind === "pdf" ? pasted.name : `screenshot-${Date.now()}.png`,
        mimeType: pasted.mimeType,
        contentBase64: pasted.dataUrl.split(",")[1]!,
      });
      if (pasted.kind === "image") imageParts.push({ type: "image_url" as const, image_url: { url: `/api/v1/artifacts/${response.data.id}` } });
    } catch (error) { showToast(errorMessage(error)); }
  }
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  if (!existingUserMessage) appendMessage("user", content);
  if (content && !existingUserMessage) composer.pushHistory(content);
  sessionTokenEstimate += estimateTokens(content);
  updateContextMeter();
  // Build multi-modal message content
  const messageContent = imageParts.length > 0
    ? [{ type: "text" as const, text: content }, ...imageParts]
    : content;
  await agentRuns.start({
    model: composer.controls.routeId,
    max_tokens: composer.controls.maxTokens,
    temperature: composer.controls.temperature,
    sessionId: currentSession,
    accessMode: composer.controls.accessMode,
    messages: [{ role: "user", content: messageContent }],
  });
}

// While the agent is reasoning the composer stays unlocked. Sending inserts the
// message into the running conversation: the host forwards it to the active stream
// (Pi queues it as a steering message) and emits a `user.steer` event when it is
// delivered. We render the message here, inside the agent's work feed next to the
// tool calls and reasoning, so the user gets immediate feedback.
async function steerPrompt(content: string): Promise<void> {
  const runId = agentRuns.runId;
  if (!content || !runId) return;
  composer.clearDraft();
  agentRuns.resetWarmup();
  updateContextMeter();
  refreshComposerState();
  const steerRow = activityTimeline.appendSteer(content);
  composer.pushHistory(content);
  sessionTokenEstimate += estimateTokens(content);
  updateContextMeter();
  try {
    await agentRuns.steer(content);
  } catch {
    // The run finished or stopped accepting messages before the steer landed;
    // put the draft back and drop the undelivered row.
    steerRow.remove();
    composer.setDraft(content);
  }
}

async function loadArtifacts(): Promise<void> {
  artifacts.replaceChildren();
  composer.clearArtifactChips();
  inspectorPanel.resetPreview();
  if (!currentSession) { artifacts.append(panelEmpty("Artifacts appear with a task")); return; }
  const response = await api(`/api/v1/sessions/${currentSession}/artifacts`);
  if (!(response.data ?? []).length) artifacts.append(panelEmpty("No artifacts yet"));
  for (const artifact of response.data ?? []) {
    const value = document.createElement("button"); value.type = "button"; value.className = "artifact-item";
    const name = document.createElement("span"); name.textContent = artifact.name;
    const size = document.createElement("small"); size.textContent = formatBytes(artifact.byteSize);
    value.append(name, size); value.addEventListener("click", () => void inspectorPanel.previewArtifact(artifact, value, artifacts)); artifacts.append(value);
    composer.addArtifactChip(artifact.name, formatBytes(artifact.byteSize), () => void inspectorPanel.previewArtifact(artifact, value, artifacts), () => void removeArtifact(artifact));
  }
}

async function loadAgentQueue(): Promise<void> {
  try {
    const response = await api("/api/v1/agent/queue"); const items = response.data ?? [];
    requestQueue.replaceChildren(); queueCount.textContent = String(items.length);
    if (!items.length) { requestQueue.append(panelEmpty("No active requests")); return; }
    for (const item of items) {
      const row = document.createElement("div"); row.className = `queue-item ${item.status}`;
      const state = document.createElement("span"); state.className = "queue-state"; if (item.status === "queued") state.textContent = String(item.position);
      const copy = document.createElement("span"); copy.className = "queue-copy";
      const title = document.createElement("strong"); title.textContent = item.sessionTitle ?? `${item.routeId} task`;
      const detail = document.createElement("small"); detail.textContent = item.status === "running" ? `${item.projectName ?? "Agent"} · Running` : `${item.projectName ?? "Agent"} · Position ${item.position}`;
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "queue-cancel"; cancel.title = item.status === "running" ? "Stop request" : "Remove from queue"; cancel.setAttribute("aria-label", cancel.title); cancel.append(svg('<path d="m5 5 10 10M15 5 5 15"></path>'));
      cancel.addEventListener("click", () => void cancelQueuedRun(String(item.runId), cancel)); copy.append(title, detail); row.append(state, copy, cancel); requestQueue.append(row);
    }
  } catch { requestQueue.replaceChildren(panelEmpty("Queue unavailable")); queueCount.textContent = "—"; }
}

async function cancelQueuedRun(runId: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try { await api(`/api/v1/agent/runs/${runId}`, "DELETE"); await loadAgentQueue(); }
  catch (error) { button.disabled = false; showToast(errorMessage(error)); }
}

function scheduleQueueRefresh(): void {
  if (queueRefreshTimer) clearTimeout(queueRefreshTimer); queueRefreshTimer = undefined;
  if (!inspectorPanel.isOpen) return;
  void loadAgentQueue().finally(() => { if (inspectorPanel.isOpen) queueRefreshTimer = setTimeout(scheduleQueueRefresh, 1_000); });
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
  if (file.size > 5_000_000) { showToast("Artifacts are currently limited to 5 MB"); return; }
  try {
    const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    await api(`/api/v1/sessions/${currentSession}/artifacts`, "POST", { name: file.name, mimeType: file.type || "application/octet-stream", contentBase64 });
    await loadArtifacts(); inspectorPanel.open(); showToast(`Attached ${file.name}`);
  } catch (error) { showToast(errorMessage(error)); }
}

function showLanding(hasTask = false): void {
  messages.replaceChildren();
  activityTimeline.clear();
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

function appendMessage(role: string, text: string, createdAt?: string): HTMLElement {
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  if (role !== "commentary" && !agentRuns.active) activityTimeline.finishWork(createdAt);
  const article = document.createElement("article"); article.className = `message ${role}`;
  const content = document.createElement("div"); content.className = "message-body"; if (role === "assistant" || role === "commentary") setMarkdown(content, text); else content.textContent = text; article.append(content); if (["user", "assistant"].includes(role)) messageActions.attach(article, content, role as ActionableMessageRole, text, createdAt); messages.append(article); messages.scrollTop = messages.scrollHeight; return content;
}

function appendCommentary(text: string, createdAt?: string): HTMLElement {
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  const article = document.createElement("article"); article.className = "message commentary";
  const content = document.createElement("div"); content.className = "message-body"; setMarkdown(content, text); article.append(content);
  activityTimeline.appendCommentary(article, createdAt);
  return content;
}

function appendChangeSummary(files: Array<{ path: string; action: "edited" | "created" }>): void {
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  const article = document.createElement("article"); article.className = "message change-summary";
  const content = document.createElement("div"); content.className = "message-body change-summary-body";

  const createdFiles = files.filter((f) => f.action === "created");
  const editedFiles = files.filter((f) => f.action === "edited");

  const summaryHeader = document.createElement("div"); summaryHeader.className = "change-summary-header";
  const total = files.length;
  const parts: string[] = [];
  if (createdFiles.length) parts.push(`${createdFiles.length} created`);
  if (editedFiles.length) parts.push(`${editedFiles.length} edited`);
  summaryHeader.textContent = `${total} file${total === 1 ? "" : "s"}: ${parts.join(", ")}`;
  content.append(summaryHeader);

  const fileList = document.createElement("div"); fileList.className = "change-summary-list";
  for (const file of files) {
    const row = document.createElement("div"); row.className = `change-summary-row ${file.action}`;
    const icon = document.createElement("span"); icon.className = "change-summary-icon";
    icon.textContent = file.action === "created" ? "+" : "~";
    const filePath = document.createElement("span"); filePath.className = "change-summary-path";
    filePath.textContent = file.path;
    row.append(icon, filePath);
    fileList.append(row);
  }
  content.append(fileList);
  article.append(content);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
}

function refreshComposerState(): void {
  const ready = Boolean((currentSession || (newChatMode && currentProject)) && composer.controls.routeId);
  addArtifactButton.disabled = !currentSession;
  composer.setState({ ready, running: agentRuns.active, hasSession: Boolean(currentSession) });
}

function updateTitles(): void {
  const project = projectRecords.find((item) => item.id === currentProject);
  const session = currentProject ? (sessionsByProject.get(currentProject) ?? []).find((item) => item.id === currentSession) : undefined;
  projectTitle.textContent = project?.name ?? "Fitz Codex";
  taskTitle.textContent = "";
  taskMenuToggle.hidden = !session;
}

function toggleSidebar(): void { shell.classList.toggle("sidebar-collapsed"); closePopovers(); }
function updateContextMeter(): void { composer.controls.updateContext(sessionTokenEstimate + estimateTokens(composer.value), contextTokenLimit); }

async function compactCurrentSession(): Promise<void> {
  if (!currentSession || agentRuns.active) return;
  composer.controls.setContextStatus("Compacting…", true);
  try {
    const response = await api(`/api/v1/sessions/${currentSession}/compact`, "POST", { model: composer.controls.routeId || "default" });
    sessionTokenEstimate = Number(response.data?.estimatedContextTokens ?? sessionTokenEstimate);
    updateContextMeter();
    activityTimeline.appendContext("Context compacted");
    composer.controls.setContextStatus(`Reduced ${formatTokenCount(Number(response.data?.estimatedInputTokens ?? 0))} to ${formatTokenCount(sessionTokenEstimate)} tokens`);
  } catch (error) { composer.controls.setContextStatus(errorMessage(error)); }
  finally { refreshComposerState(); }
}

function setStatus(text: string, state: string): void { composer.setStatus(text, state); }
function setConnection(text: string, state: string): void { connectionDetail.textContent = text; connectionStatus.dataset.state = state; }
function setFormBusy(formElement: HTMLFormElement, busy: boolean): void { for (const control of formElement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy; }
// Toast notifications are intentionally removed; this no-op keeps the call sites intact.
function showToast(_text: string): void { }
function panelEmpty(text: string): HTMLElement { return textBlock("panel-empty", text); }
function loadingMessage(text: string): HTMLElement { return textBlock("panel-empty", text); }
async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const response = await window.fitz.request({ path, method, ...(body !== undefined ? { body } : {}) });
  let parsed: Json;
  try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
  if (response.status >= 400) throw new HttpError(parsed.error?.message ?? parsed.error ?? `Request failed (${response.status})`, response.status);
  return parsed;
}

function sparkIcon(): SVGElement { return svg('<path d="M10 2.8c.5 3.7 2.4 5.8 6.2 7.2-3.8 1.4-5.7 3.5-6.2 7.2-.5-3.7-2.4-5.8-6.2-7.2C7.6 8.6 9.5 6.5 10 2.8Z"></path>'); }
function terminalCloudIcon(): SVGElement { return svg('<path d="M6.2 16.4c-2 0-3.7-1.6-3.7-3.6 0-1.2.6-2.3 1.5-3-.4-1.8.5-3.6 2.1-4.4.7-1.7 2.4-2.8 4.2-2.8 1.5 0 2.9.7 3.8 1.9 1.8-.1 3.3 1.3 3.4 3.1 1 .7 1.7 1.9 1.7 3.2 0 1.5-.8 2.8-2.1 3.5-.5 1.8-2.1 3-4 3-.8 0-1.6-.2-2.2-.7-.7.6-1.6.9-2.5.9-.8 0-1.6-.3-2.2-.7z"></path><path d="m6.8 8 1.8 2-1.8 2M10.7 12.3h2.7"></path>'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }

function estimateTokens(value: string): number { return value ? Math.max(1, Math.ceil(value.length / 4)) : 0; }
function estimateTranscriptContext(entries: Json[]): number {
  const checkpoint = [...entries].reverse().find((entry) => entry.kind === "compaction" && entry.content?.manual === true && typeof entry.content?.summary === "string" && Number.isFinite(Number(entry.content?.throughSequence)));
  const throughSequence = checkpoint ? Number(checkpoint.content.throughSequence) : -1; let total = checkpoint ? estimateTokens(`Conversation summary:\n${checkpoint.content.summary}`) : 0;
  for (const entry of entries) if (entry.kind === "message" && typeof entry.content?.text === "string" && Number(entry.sequence) > throughSequence) total += estimateTokens(entry.content.text);
  return total;
}
function formatTokenCount(value: number): string { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)); }
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
