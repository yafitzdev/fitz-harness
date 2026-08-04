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
import { requiredElement as element, requiredQuery as query, svgIcon as svg, textBlock } from "./ui/primitives/dom.js";
import { togglePopover as toggleManagedPopover } from "./ui/primitives/popover.js";
import { ResizablePane } from "./ui/primitives/resizable-pane.js";
import { PluginsPageController } from "./ui/plugins/plugins-page.js";
import { AdministrationPageController } from "./ui/administration/administration-page.js";
import { PlaybookWorkspaceController } from "./ui/playbooks/playbook-workspace.js";
import { ProjectsController } from "./ui/projects/projects.js";
import { ProjectSidebarController } from "./ui/sidebar/project-sidebar.js";

type Json = Record<string, any>;
type AppLocation = { view: "conversation"; projectId?: string; sessionId?: string; newChat?: boolean } | { view: "playbooks" | "connections" | "plugins" | "administration" };

let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTokenEstimate = 0;
let contextTokenLimit = 131_072;
let configuredHostOrigin = "Fitz host";
let administrator = false;
let currentUserId: string | undefined;
let managementConfiguration: Json | undefined;
let newChatMode = false;
let newChatProjectDetached = false;
let navigationIndex = -1;
let replayingNavigation = false;
const navigationHistory: AppLocation[] = [];
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
const taskMenuToggle = element("task-menu-toggle") as HTMLButtonElement;
const taskMenu = element("task-menu");
const appMenuPopover = element("app-menu-popover");
const selectPopover = element("select-popover");
const sidebarResizer = element("sidebar-resizer");
const playbookPage = element("playbook-page");
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

let conversationLayout: ConversationLayout | undefined;
const sidebarPane = new ResizablePane({
  divider: sidebarResizer, storageKey: "fitz-sidebar-width", defaultValue: 254, minimum: 240, maximum: 520,
  pointerValue: (event) => event.clientX,
  apply: (value) => shell.style.setProperty("--sidebar-width", `${value}px`),
});
const inspectorPanel = new InspectorPanel({
  mount: workspace,
  getProjectRoot: () => String(projects.activeProject()?.rootPath ?? ""),
  getSearchRoots: () => activityTimeline.searchRoots(),
  showToast,
  onLayoutChange: () => conversationLayout?.sync(),
});
const composer = new Composer({
  mount: workspace,
  getProjectRoot: () => String(projects.activeProject()?.rootPath ?? "") || undefined,
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
    const project = projects.activeProject();
    if (!project) return;
    await api(`/api/v1/projects/${project.id}`, "PATCH", { rootPath: path });
    project.rootPath = path;
  },
  onError: showToast,
  isRunning: () => agentRuns.active,
});
conversationLayout = new ConversationLayout({ workspace, messages, composer: composer.root, scrollButton: composer.scrollButton, inspectorWidth: () => inspectorPanel.width() });
const customSelects = new CustomSelectController(selectPopover, closePopovers);
const projectSidebar = new ProjectSidebarController({
  mount: element("projects"),
  closePopovers,
  selectProject: (projectId) => void projects.selectProject(projectId),
  selectSession: (sessionId, projectId) => void projects.selectSession(sessionId, true, projectId),
  newChat: openNewChatForProject,
  openProjectPath: (path) => void projects.openProjectPath(path),
  createWorktree: openProjectWorktreeSetup,
  editProject: (projectId) => void projects.openProjectRenameDialog(projectId),
  archiveProjectChats: (projectId) => void projects.archiveProjectChats(projectId),
  removeProject: (projectId) => void projects.openRemoveProjectDialog(projectId),
  renameSession: (sessionId, projectId) => { projects.setCurrentProject(projectId); projects.setCurrentSession(sessionId); projects.openRenameDialog(); },
  archiveSession: (sessionId, projectId) => { projects.setCurrentProject(projectId); projects.setCurrentSession(sessionId); void projects.archiveCurrentTask(); },
  copyValue: (value, message) => void copyValue(value, message),
  continueSession: (session, projectId) => void projects.continueInNewChat(session, projectId),
});
const projects = new ProjectsController({
  api,
  bridge: { chooseFolder: () => window.fitz.chooseFolder(), openPath: (path) => window.fitz.openPath(path) },
  elements: {
    projectDialog: element("project-dialog") as HTMLDialogElement,
    projectForm: element("project-form") as HTMLFormElement,
    projectName: element("project-name") as HTMLInputElement,
    projectRootPath: element("project-root-path") as HTMLInputElement,
    projectFolderLabel: element("project-folder-label"),
    chooseProjectFolder: element("choose-project-folder") as HTMLButtonElement,
    taskDialog: element("task-dialog") as HTMLDialogElement,
    taskForm: element("task-form") as HTMLFormElement,
    taskProject: element("task-project") as HTMLSelectElement,
    taskName: element("task-name") as HTMLInputElement,
    renameDialog: element("rename-dialog") as HTMLDialogElement,
    renameForm: element("rename-form") as HTMLFormElement,
    renameTaskName: element("rename-task-name") as HTMLInputElement,
    renameHeading: element("rename-heading"),
    renameLabel: element("rename-label"),
    removeProjectDialog: element("remove-project-dialog") as HTMLDialogElement,
    removeProjectForm: element("remove-project-form") as HTMLFormElement,
    removeProjectName: element("remove-project-name"),
  },
  sidebar: {
    ensureExpanded: (projectId) => projectSidebar.ensureExpanded(projectId),
    hasExpandedProjects: () => projectSidebar.hasExpandedProjects(),
    markSessionRead: (sessionId) => projectSidebar.markSessionRead(sessionId),
    removeProjectState: (projectId) => projectSidebar.removeProjectState(projectId),
  },
  showToast,
  errorMessage,
  closePopovers,
  showConversationWorkspace,
  leaveNewChat: () => { newChatMode = false; workspace.classList.remove("new-chat-open"); composer.exitNewChat(); },
  renderTree,
  refreshComposerState,
  rememberLocation: (location) => rememberLocation(location),
  onStartNewChat: () => openNewChat(),
  onSessionSelected: async (sessionId) => {
    projectSidebar.hideChatHover();
    composer.controls.resetContextStatus();
    const selectedSession = projects.currentSessionRecord();
    if (selectedSession?.routeId) composer.controls.setRoute(selectedSession.routeId);
    syncComposerContext();
    messages.replaceChildren(loadingMessage("Loading conversation…"));
    try {
      const transcript = await api(`/api/v1/sessions/${sessionId}/transcript`);
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
      const pendingApprovals = await api(`/api/v1/sessions/${sessionId}/tool-approvals?status=pending`);
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
    rememberLocation({ view: "conversation", ...(projects.currentProjectId ? { projectId: projects.currentProjectId } : {}), sessionId });
  },
  onNoSession: async () => {
    sessionTokenEstimate = 0;
    updateContextMeter();
    showLanding();
    await loadArtifacts();
  },
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
const playbookWorkspace = new PlaybookWorkspaceController({
  page: playbookPage,
  list: element("playbook-list"),
  search: element("playbook-search") as HTMLInputElement,
  title: element("management-title"),
  description: element("management-description"),
  browser: element("management-browser"),
  editor: element("management-editor"),
  closeEditorButtons: [...document.querySelectorAll<HTMLButtonElement>("#close-management-editor, [data-close-management-editor]")],
  refresh: element("refresh-playbooks") as HTMLButtonElement,
  engineForm: element("engine-form") as HTMLFormElement,
  engineFolder: element("engine-folder") as HTMLSelectElement,
  engineDisplayName: element("engine-display-name") as HTMLInputElement,
  engineConnection: element("engine-connection") as HTMLSelectElement,
  engineRuntime: element("engine-runtime") as HTMLSelectElement,
  engineBaseUrl: element("engine-base-url") as HTMLInputElement,
  engineHealthPath: element("engine-health-path") as HTMLInputElement,
  engineCommand: element("engine-command") as HTMLInputElement,
  engineArguments: element("engine-arguments") as HTMLTextAreaElement,
  engineWorkingDirectory: element("engine-working-directory") as HTMLInputElement,
  engineWslDistribution: element("engine-wsl-distribution") as HTMLInputElement,
  engineManagedFields: element("engine-managed-fields"),
  engineRuntimeField: element("engine-runtime-field"),
  engineBaseUrlField: element("engine-base-url-field"),
  engineWslField: element("engine-wsl-field"),
  engineEditorTitle: element("engine-editor-title"),
  recipeForm: element("recipe-form") as HTMLFormElement,
  recipePlaybookId: element("recipe-playbook-id") as HTMLInputElement,
  recipeId: element("recipe-id") as HTMLInputElement,
  recipeDisplayName: element("recipe-display-name") as HTMLInputElement,
  recipeAdapter: element("recipe-adapter") as HTMLInputElement,
  recipeModelId: element("recipe-model-id") as HTMLInputElement,
  recipeContextTokens: element("recipe-context-tokens") as HTMLInputElement,
  recipeConfiguration: element("recipe-configuration") as HTMLTextAreaElement,
  recipeEditorTitle: element("recipe-editor-title"),
}, {
  api,
  reloadConfiguration: () => loadManagementConfiguration(true),
  showToast,
  errorMessage,
});
const connectionWorkspace = new ConnectionWorkspaceController({
  mount: workspace,
  bridge: window.fitz,
  api,
  reloadConfiguration: () => loadManagementConfiguration(false),
  testRecipe: (recipe, card, button) => playbookWorkspace.testRecipe(recipe, card, button),
  renderRecipeTestState: (recipeId, card, button) => playbookWorkspace.renderRecipeTestState(recipeId, card, button),
  closePopovers,
  showToast,
  errorMessage,
});
const workspacePages = new WorkspacePageController({
  pages: {
    playbooks: playbookPage,
    connections: connectionWorkspace.root,
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
const pluginsPageController = new PluginsPageController({
  page: pluginsPage,
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
const administrationPageController = new AdministrationPageController({
  refresh: element("refresh-administration") as HTMLButtonElement,
  refreshRemoteAccess: element("refresh-remote-access") as HTMLButtonElement,
  cancelRemoteAccess: element("cancel-remote-access") as HTMLButtonElement,
  refreshHostStartup: element("refresh-host-startup") as HTMLButtonElement,
  cancelHostStartup: element("cancel-host-startup") as HTMLButtonElement,
  pairingCodeForm: element("pairing-code-form") as HTMLFormElement,
  pairingCodeRole: element("pairing-code-role") as HTMLSelectElement,
  pairingCodeTtl: element("pairing-code-ttl") as HTMLSelectElement,
  pairingCodeResult: element("pairing-code-result"),
  issuedPairingCode: element("issued-pairing-code"),
  issuedPairingExpiry: element("issued-pairing-expiry"),
  copyPairingCode: element("copy-pairing-code") as HTMLButtonElement,
  createUserForm: element("create-user-form") as HTMLFormElement,
  createUserName: element("create-user-name") as HTMLInputElement,
  createUserRole: element("create-user-role") as HTMLSelectElement,
  adminUsers: element("admin-users"),
  toolPolicyForm: element("tool-policy-form") as HTMLFormElement,
  toolPolicySubjectType: element("tool-policy-subject-type") as HTMLSelectElement,
  toolPolicySubject: element("tool-policy-subject") as HTMLSelectElement,
  toolPolicyName: element("tool-policy-name") as HTMLInputElement,
  toolPolicyDecision: element("tool-policy-decision") as HTMLSelectElement,
  toolPolicies: element("tool-policies"),
  adminAuditEvents: element("admin-audit-events"),
  diagnosticGeneratedAt: element("diagnostic-generated-at"),
  diagnosticSummary: element("diagnostic-summary"),
  diagnosticMetrics: element("diagnostic-metrics"),
  diagnosticFailures: element("diagnostic-failures"),
  exportDiagnostics: element("export-diagnostics") as HTMLButtonElement,
  remoteAccessStatus: element("remote-access-status"),
  remoteAccessConfirmation: element("remote-access-confirmation"),
  remoteAccessConfirmationText: element("remote-access-confirmation-text"),
  enableRemoteAccess: element("enable-remote-access") as HTMLButtonElement,
  disableRemoteAccess: element("disable-remote-access") as HTMLButtonElement,
  confirmRemoteAccess: element("confirm-remote-access") as HTMLButtonElement,
  hostStartupStatus: element("host-startup-status"),
  hostStartupConfirmation: element("host-startup-confirmation"),
  hostStartupConfirmationText: element("host-startup-confirmation-text"),
  installHostStartup: element("install-host-startup") as HTMLButtonElement,
  removeHostStartup: element("remove-host-startup") as HTMLButtonElement,
  confirmHostStartup: element("confirm-host-startup") as HTMLButtonElement,
  checkDesktopUpdate: element("check-desktop-update") as HTMLButtonElement,
  installDesktopUpdate: element("install-desktop-update") as HTMLButtonElement,
  desktopUpdateLabel: element("desktop-update-label"),
  desktopUpdateVersion: element("desktop-update-version"),
  desktopUpdateProgress: element("desktop-update-progress"),
  updateButton,
}, {
  api,
  bridge: window.fitz,
  isAdministrator: () => administrator,
  currentUserId: () => currentUserId,
  showToast,
  errorMessage,
});
void initialize();

window.fitz.onNavigationCommand((command) => void navigateHistory(command === "back" ? -1 : 1));
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewChat(); }
  if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); projects.openRenameDialog(); }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); void projects.archiveCurrentTask(); }
  if (event.key === "Escape") { if (playbookWorkspace.editorOpen) playbookWorkspace.closeEditor(); else if (connectionWorkspace.editorOpen) connectionWorkspace.closeEditor(); else closePopovers(); }
});

element("new-project").addEventListener("click", () => projects.openProjectDialog());
element("new-session").addEventListener("click", openNewChat);
element("manage-playbooks").addEventListener("click", () => void openPlaybookPage());
connectionsButton.addEventListener("click", () => void openConnectionsPage());
pluginsButton.addEventListener("click", () => void openPluginsPage());
administrationButton.addEventListener("click", () => void openAdministrationPage());
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
projects.elements.chooseProjectFolder.addEventListener("click", () => void projects.selectProjectFolder());
taskMenuToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(taskMenu, taskMenuToggle); });
taskMenu.addEventListener("click", (event) => event.stopPropagation());
element("rename-task").addEventListener("click", () => projects.openRenameDialog());
element("archive-task").addEventListener("click", () => void projects.archiveCurrentTask());
projects.elements.renameForm.addEventListener("submit", (event) => { event.preventDefault(); void projects.renameCurrentTask(); });
projects.elements.removeProjectForm.addEventListener("submit", (event) => { event.preventDefault(); void projects.removeProject(); });
projects.elements.projectForm.addEventListener("submit", (event) => { event.preventDefault(); void projects.createProject(); });
projects.elements.taskForm.addEventListener("submit", (event) => { event.preventDefault(); void projects.createSession(); });
pairingForm.addEventListener("submit", (event) => { event.preventDefault(); void pairDevice(); });
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
    await projects.load();
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

function renderTree(): void {
  projectSidebar.render({ projects: projects.projects, sessionsByProject: projects.sessionsByProject, currentProjectId: projects.currentProjectId, currentSessionId: projects.currentSessionId, newChat: newChatMode });
  updateTitles();
}

function openNewChat(): void {
  if (agentRuns.active) { showToast("Stop the current response before starting a new chat"); return; }
  showConversationWorkspace();
  inspectorPanel.close();
  if (projects.projects.length === 0) { projects.openProjectDialog(true); return; }
  projects.setCurrentProject(projects.currentProjectId ?? projects.projects[0]!.id);
  if (!projects.currentProjectId) return;
  projects.beginNewChat();
  newChatMode = true;
  newChatProjectDetached = false;
  sessionTokenEstimate = 0;
  composer.controls.resetContextStatus();
  projectSidebar.ensureExpanded(projects.currentProjectId);
  workspace.classList.add("new-chat-open");
  connectionWorkspace.setConfiguration(managementConfiguration);
  composer.enterNewChat(projects.activeProject()?.name ?? "Project");
  agentRuns.resetWarmup();
  renderTree();
  showNewChatLanding();
  void composer.refreshBranches();
  updateContextMeter();
  refreshComposerState();
  composer.focus();
  rememberLocation({ view: "conversation", projectId: projects.currentProjectId, newChat: true });
}

function openNewChatForProject(id: string): void { projects.setCurrentProject(id); projectSidebar.ensureExpanded(id); openNewChat(); }

function showNewChatLanding(): void {
  messages.replaceChildren();
  activityTimeline.clear();
  const project = projects.projects.find((item) => item.id === projects.currentProjectId);
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

function openProjectWorktreeSetup(id: string): void { openNewChatForProject(id); composer.openWorktreeSetup(); }

async function copyValue(value: string, message: string): Promise<void> { await window.fitz.copyText(value); showToast(message); }

async function openPlaybookPage(): Promise<void> {
  if (!pairingPage.hidden) { pairingCode.focus(); return; }
  closePopovers();
  inspectorPanel.close();
  playbookWorkspace.closeEditor();
  workspacePages.show("playbooks");
  playbookWorkspace.showLoading();
  await loadManagementConfiguration(true);
  rememberLocation({ view: "playbooks" });
}

async function openConnectionsPage(): Promise<void> { if (!pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); connectionWorkspace.closeEditor(); workspacePages.show("connections"); await connectionWorkspace.sync(false); rememberLocation({ view: "connections" }); }
async function openPluginsPage(): Promise<void> { if (!administrator || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); connectionWorkspace.closeEditor(); workspacePages.show("plugins"); pluginsPageController.showLoading(); await pluginsPageController.load(false); rememberLocation({ view: "plugins" }); }
async function openAdministrationPage(): Promise<void> { if (!administrator || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); workspacePages.show("administration"); administrationPageController.showLoading(); await administrationPageController.load(); rememberLocation({ view: "administration" }); }
function showPairingPage(message: string): void { closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); workspacePages.show("pairing"); pairingDescription.textContent = message || "Enter a one-time code from your Fitz host."; pairingError.hidden = true; pairingError.textContent = ""; pairingCode.focus(); }
function showConversationWorkspace(): void { playbookWorkspace.closeEditor(); workspacePages.show("conversation"); }
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
      if (location.newChat && location.projectId) { projects.setCurrentProject(location.projectId); openNewChat(); }
      else if (location.sessionId) await projects.selectSession(location.sessionId, true, location.projectId);
      else if (location.projectId) await projects.selectProject(location.projectId);
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

async function loadManagementConfiguration(renderPage: boolean): Promise<Json | undefined> {
  try {
    managementConfiguration = await api("/api/v1/management/status");
    syncContextLimit();
    updateContextMeter();
    connectionWorkspace.setConfiguration(managementConfiguration);
    rebuildRouteLabels();
    playbookWorkspace.setConfiguration(managementConfiguration);
    if (renderPage) playbookWorkspace.render();
  } catch (error) {
    if (renderPage) playbookWorkspace.showUnavailable(errorMessage(error));
  }
  return managementConfiguration;
}

function syncContextLimit(): void {
  const route = managementConfiguration?.routes?.find((item: Json) => item.id === composer.controls.routeId);
  const recipe = managementConfiguration?.recipes?.find((item: Json) => item.id === route?.recipeId);
  if (Number.isFinite(recipe?.contextTokens) && recipe.contextTokens > 0) contextTokenLimit = recipe.contextTokens;
}

async function updateSessionBinding(): Promise<void> {
  const session = projects.currentSessionRecord();
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
  if (projects.currentSessionId) void updateSessionBinding();
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
    item("New project", '<path d="M3 6h5l1.5 2H17v8H3z"></path><path d="M3 6V4h5l1.5 2"></path>', () => projects.openProjectDialog());
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
  projectSidebar.hideMenu();
  projectSidebar.hideOverlays();
  taskMenuToggle.setAttribute("aria-expanded", "false");
  projectSidebar.resetMenuToggles();
  for (const toggle of document.querySelectorAll("[data-app-menu]")) toggle.setAttribute("aria-expanded", "false");
}

async function sendPrompt(submittedContent?: string, existingUserMessage?: HTMLElement): Promise<void> {
  const content = (submittedContent ?? composer.value).trim();
  const attachments = composer.consumePastedAttachments();
  if (!content && attachments.length === 0) return;
  if (!projects.currentSessionId && newChatMode && projects.currentProjectId) {
    try {
      const title = content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
      const response = await api(`/api/v1/projects/${projects.currentProjectId}/sessions`, "POST", { title, routeId: composer.controls.routeId as FixedRouteId });
      newChatMode = false;
      workspace.classList.remove("new-chat-open");
      composer.exitNewChat();
      projects.startSessionInProject(projects.currentProjectId, response.data);
    } catch (error) { showToast(errorMessage(error)); return; }
  }
  if (!projects.currentSessionId) { openNewChat(); return; }
  if (!composer.controls.routeId) { showToast("No model route is available"); return; }
  composer.clearDraft();
  agentRuns.resetWarmup();
  // Upload pasted files as artifacts; images become multi-modal message parts
  const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const pasted of attachments) {
    try {
      const response = await api(`/api/v1/sessions/${projects.currentSessionId}/artifacts`, "POST", {
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
    sessionId: projects.currentSessionId,
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
  if (!projects.currentSessionId) { artifacts.append(panelEmpty("Artifacts appear with a task")); return; }
  const response = await api(`/api/v1/sessions/${projects.currentSessionId}/artifacts`);
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
  if (!projects.currentSessionId) { showToast("Create or select a task before attaching a file"); return; }
  artifactFile.click();
}

async function uploadArtifact(): Promise<void> {
  const file = artifactFile.files?.[0]; artifactFile.value = "";
  if (!file || !projects.currentSessionId) return;
  if (file.size > 5_000_000) { showToast("Artifacts are currently limited to 5 MB"); return; }
  try {
    const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    await api(`/api/v1/sessions/${projects.currentSessionId}/artifacts`, "POST", { name: file.name, mimeType: file.type || "application/octet-stream", contentBase64 });
    await loadArtifacts(); inspectorPanel.open(); showToast(`Attached ${file.name}`);
  } catch (error) { showToast(errorMessage(error)); }
}

function showLanding(hasTask = false): void {
  messages.replaceChildren();
  activityTimeline.clear();
  const landing = document.createElement("div"); landing.className = "landing";
  const mark = document.createElement("div"); mark.className = "landing-mark"; mark.append(sparkIcon());
  const heading = document.createElement("h1"); heading.textContent = hasTask ? "What should we work on?" : projects.currentProjectId ? "Start a task" : "Bring your code. Build with Fitz.";
  const detail = document.createElement("p"); detail.textContent = hasTask ? "Describe a change, ask a question, or attach a file. Fitz keeps the work and transcript together." : projects.currentProjectId ? "Create a task inside this project to begin a durable conversation." : "Create a project, start a task, and work with local or remote inference from one focused desktop.";
  landing.append(mark, heading, detail);
  if (!hasTask) {
    const action = document.createElement("button"); action.type = "button"; action.className = "primary-button"; action.textContent = projects.currentProjectId ? "New task" : "Create project";
    action.addEventListener("click", () => projects.currentProjectId ? openNewChat() : projects.openProjectDialog(true)); landing.append(action);
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
  const ready = Boolean((projects.currentSessionId || (newChatMode && projects.currentProjectId)) && composer.controls.routeId);
  addArtifactButton.disabled = !projects.currentSessionId;
  composer.setState({ ready, running: agentRuns.active, hasSession: Boolean(projects.currentSessionId) });
}

function updateTitles(): void {
  const project = projects.activeProject();
  const session = projects.currentSessionRecord();
  projectTitle.textContent = project?.name ?? "Fitz Codex";
  taskTitle.textContent = "";
  taskMenuToggle.hidden = !session;
}

function toggleSidebar(): void { shell.classList.toggle("sidebar-collapsed"); closePopovers(); }
function updateContextMeter(): void { composer.controls.updateContext(sessionTokenEstimate + estimateTokens(composer.value), contextTokenLimit); }

async function compactCurrentSession(): Promise<void> {
  if (!projects.currentSessionId || agentRuns.active) return;
  composer.controls.setContextStatus("Compacting…", true);
  try {
    const response = await api(`/api/v1/sessions/${projects.currentSessionId}/compact`, "POST", { model: composer.controls.routeId || "default" });
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
