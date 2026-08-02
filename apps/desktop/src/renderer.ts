import { reconnectDelay } from "@fitz/connectivity/reconnect";
import type { ConsumerConnectionSummary, DesktopUpdateStatus, ResourcePreview } from "./preload.js";
import { appendMarkdown, setMarkdown } from "./markdown.js";

type Json = Record<string, any>;
type FixedRouteId = "fast" | "default" | "smart";
type AccessMode = "full" | "ask" | "read-only";
type ConnectionModelView = ConsumerConnectionSummary["models"][number] & { displayName?: string; modelId?: string; contextTokens?: number };
type HostedConnectionView = Omit<ConsumerConnectionSummary, "models"> & { hosted: true; availableModels: ConnectionModelView[] };
type SavedConnectionView = Omit<ConsumerConnectionSummary, "models"> & { hosted: false; availableModels: ConnectionModelView[]; source: ConsumerConnectionSummary };
type ConnectionView = HostedConnectionView | SavedConnectionView;
type PiCatalogPackage = { name: string; description: string; version: string; publisher: string; keywords: string[]; types: string[]; links: Record<string, string> };
type InstalledPiPackage = { source: string; displayName: string; version?: string; description?: string; enabled: boolean; resources: Record<string, number> };
type PiSkillSummary = { name: string; description: string; source: string; enabled: boolean; filePath: string };
type AppLocation = { view: "conversation"; projectId?: string; sessionId?: string; newChat?: boolean } | { view: "playbooks" | "connections" | "plugins" | "administration" };

const FIXED_ROUTES: readonly { id: FixedRouteId; label: string; icon: string }[] = [
  { id: "fast", label: "Fast", icon: '<path class="route-icon-outline" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path><path class="route-icon-filled" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path>' },
  { id: "default", label: "Default", icon: '<g class="route-icon-outline"><circle cx="10" cy="10" r="6"></circle><circle cx="10" cy="10" r="1.6"></circle></g><path class="route-icon-filled" fill-rule="evenodd" d="M10 3.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Zm0 4a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"></path>' },
  { id: "smart", label: "Smart", icon: '<g class="route-icon-outline"><path d="M8.75 2.75A3.25 3.25 0 0 0 4.3 5.7 3.2 3.2 0 0 0 3 8.3a3.5 3.5 0 0 0 2.1 3.2V14a3.25 3.25 0 0 0 3.65 3.2M11.25 2.75a3.25 3.25 0 0 1 4.45 2.95A3.2 3.2 0 0 1 17 8.3a3.5 3.5 0 0 1-2.1 3.2V14a3.25 3.25 0 0 1-3.65 3.2M8.75 2.75V17.2M11.25 2.75V17.2M5.1 8h3.65M11.25 8h3.65M5.1 12h3.65M11.25 12h3.65"></path></g><g class="route-icon-filled"><path d="M8.8 2.35A3.65 3.65 0 0 0 4 5.55 3.55 3.55 0 0 0 2.65 8.3c0 1.6.8 3 2.15 3.85V14a3.75 3.75 0 0 0 4 3.65V2.35Zm2.4 0v15.3A3.75 3.75 0 0 0 15.2 14v-1.85a4.35 4.35 0 0 0 2.15-3.85A3.55 3.55 0 0 0 16 5.55a3.65 3.65 0 0 0-4.8-3.2Z"></path><path class="route-icon-cut" d="M8.8 6.35H6.6l-1.15-1M8.8 10H5.9l-1.15 1M8.8 13.65H6.7l-1 1M11.2 6.35h2.2l1.15-1M11.2 10h2.9l1.15 1M11.2 13.65h2.1l1 1"></path></g>' },
];
const LOCAL_CONNECTION_ID = "hosted--local";

let projectRecords: Json[] = [];
const sessionsByProject = new Map<string, Json[]>();
let currentProject: string | undefined;
let currentSession: string | undefined;
let currentRun: string | undefined;
let lastSequence = 0;
let pendingTaskAfterProject = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTokenEstimate = 0;
let contextTokenLimit = 131_072;
let configuredHostOrigin = "Fitz host";
let administrator = false;
let currentUserId: string | undefined;
let administrationUsers: Json[] = [];
let administrationPolicies: Json[] = [];
let diagnosticBundle: Json | undefined;
let consumerConnectionRecords: ConsumerConnectionSummary[] = [];
let installedPiPackages: InstalledPiPackage[] = [];
let piCatalogPackages: PiCatalogPackage[] = [];
let installedPiSkills: PiSkillSummary[] = [];
let piCatalogTotal = 0;
let pluginSearchTimer: ReturnType<typeof setTimeout> | undefined;
let modelWarmupTimer: ReturnType<typeof setTimeout> | undefined;
let composerHadText = false;
let speculativeWarmupActive = false;
let selectedConnectionId = LOCAL_CONNECTION_ID;
let pendingRemoteAction: "enable" | "disable" | undefined;
let pendingStartupAction: "install" | "remove" | undefined;
let managementConfiguration: Json | undefined;
let newChatMode = false;
let newChatProjectDetached = false;
let currentBranch = "main";
let availableBranches: string[] = [];
let hoveredProjectId: string | undefined;
let projectHoverHideTimer: ReturnType<typeof setTimeout> | undefined;
let removeProjectTarget: string | undefined;
let editingRecipe: Json | undefined;
let accessMode: AccessMode = storedAccessMode();
let activeCustomSelect: HTMLSelectElement | undefined;
let inspectedResource: { kind: "file"; path: string } | { kind: "url"; url: string } | undefined;
let inspectionVersion = 0;
let inspectedPreview: ResourcePreview | undefined;
let inspectorSourceMode = false;
let activeWorkSummary: { root: HTMLElement; toggle: HTMLButtonElement; details: HTMLElement; startedAt: number; lastAt: number } | undefined;
let renameTarget: { kind: "project" | "task"; id: string } | undefined;
let navigationIndex = -1;
let replayingNavigation = false;
const navigationHistory: AppLocation[] = [];
const pinnedProjects = storedSet("fitz-pinned-projects");
const pinnedSessions = storedSet("fitz-pinned-sessions");
const unreadSessions = storedSet("fitz-unread-sessions");
const expandedProjects = storedSet("fitz-expanded-projects");
const resourceSearchRoots = new Set<string>();
const recipeTestStates = new Map<string, { state: "testing" | "passed" | "failed"; detail: string }>();

const shell = query(".app-shell");
const workspaceHeader = query(".workspace-header");
const composerDock = query(".composer-dock");
const projects = element("projects");
const messages = element("messages");
const scrollToBottom = element("scroll-to-bottom") as HTMLButtonElement;
const model = element("model") as HTMLSelectElement;
const effort = element("effort") as HTMLSelectElement;
const modelToggle = element("model-toggle") as HTMLButtonElement;
const modelMenu = element("model-menu");
const modelSummary = element("model-summary");
const modelValue = element("model-value");
const effortValue = element("effort-value");
const settingsSubmenu = element("settings-submenu");
const advancedSettings = element("advanced-settings") as HTMLButtonElement;
const advancedSettingsPanel = element("advanced-settings-panel");
const temperature = element("temperature") as HTMLInputElement;
const temperatureValue = element("temperature-value");
const contextMeter = element("context-meter");
const contextUsagePopover = element("context-usage-popover");
const contextPercent = element("context-percent");
const contextTokens = element("context-tokens");
const contextCompactButton = element("context-compact") as HTMLButtonElement;
const contextCompactStatus = element("context-compact-status");
const accessModeToggle = element("access-mode-toggle") as HTMLButtonElement;
const accessModeMenu = element("access-mode-menu");
const accessModeLabel = element("access-mode-label");
const accessModeIcon = element("access-mode-icon") as unknown as SVGElement;
const form = element("composer") as HTMLFormElement;
const workspace = query(".workspace");
const prompt = element("prompt") as HTMLTextAreaElement;
const conversationLayoutObserver = new ResizeObserver(syncConversationLayout);
const conversationContentObserver = new MutationObserver(syncConversationLayout);
conversationLayoutObserver.observe(messages);
conversationLayoutObserver.observe(composerDock);
conversationContentObserver.observe(messages, { childList: true, subtree: true });
syncConversationLayout();
const newChatContext = element("new-chat-context");
const newChatProject = element("new-chat-project");
const newChatProjectControl = element("new-chat-project-control") as HTMLButtonElement;
const newChatEnvironmentControl = element("new-chat-environment-control") as HTMLButtonElement;
const newChatEnvironmentLabel = element("new-chat-environment-label");
const newChatEnvironmentMenu = element("new-chat-environment-menu");
const newChatConnectionList = element("new-chat-connection-list");
const createWorktreeForm = element("create-worktree-form");
const newWorktreeBranch = element("new-worktree-branch") as HTMLInputElement;
const newChatBranchControl = element("new-chat-branch-control") as HTMLButtonElement;
const newChatBranchLabel = element("new-chat-branch-label");
const newChatBranchMenu = element("new-chat-branch-menu");
const branchSearch = element("branch-search") as HTMLInputElement;
const branchList = element("branch-list");
const createBranchForm = element("create-branch-form");
const newBranchName = element("new-branch-name") as HTMLInputElement;
const showCreateBranch = element("show-create-branch") as HTMLButtonElement;
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
const inspectorTitle = element("inspector-title");
const inspectorLocation = element("inspector-location");
const inspectorOpen = element("inspector-open") as HTMLButtonElement;
const inspectorClose = element("inspector-close") as HTMLButtonElement;
const inspectorRenderToggle = element("inspector-render-toggle") as HTMLButtonElement;
const inspectorIcon = element("inspector-icon");
const inspectorResizer = element("inspector-resizer");
const artifacts = element("artifacts");
const requestQueue = element("request-queue");
const queueCount = element("queue-count");
const artifactPreview = element("artifact-preview");
const artifactFile = element("artifact-file") as HTMLInputElement;
const composerAttachments = element("composer-attachments");
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
const pluginsView = element("plugins-view");
const skillsView = element("skills-view");
const pluginsTab = element("plugins-tab") as HTMLButtonElement;
const skillsTab = element("skills-tab") as HTMLButtonElement;
const pluginSearch = element("plugin-search") as HTMLInputElement;
const skillSearch = element("skill-search") as HTMLInputElement;
const installedPlugins = element("installed-plugins");
const pluginCatalog = element("plugin-catalog");
const installedSkills = element("installed-skills");
const loadMorePlugins = element("load-more-plugins") as HTMLButtonElement;
const connectionForm = element("connection-form") as HTMLFormElement;
const consumerConnectionId = element("consumer-connection-id") as HTMLInputElement;
const consumerConnectionName = element("consumer-connection-name") as HTMLInputElement;
const consumerConnectionUrl = element("consumer-connection-url") as HTMLInputElement;
const consumerConnectionAuth = element("consumer-connection-auth") as HTMLSelectElement;
const consumerConnectionKey = element("consumer-connection-key") as HTMLInputElement;
const consumerApiKeyField = element("consumer-api-key-field");
const connectionFormStatus = element("connection-form-status");
const consumerConnections = element("consumer-connections");
const cancelConnectionEdit = element("cancel-connection-edit") as HTMLButtonElement;
const connectionListView = element("connection-list-view");
const connectionEditor = element("connection-editor");
const connectionEditorTitle = element("connection-editor-title");
const connectionSearch = element("connection-search") as HTMLInputElement;
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
const chatHoverCard = element("chat-hover-card");
const hoverChatTitle = element("hover-chat-title");
const hoverChatAge = element("hover-chat-age");
const hoverProjectName = element("hover-project-name");
const projectHoverCard = element("project-hover-card");
const hoverProjectTitle = element("hover-project-title");
const hoverProjectTaskCount = element("hover-project-task-count");
const hoverProjectPath = element("hover-project-path") as HTMLButtonElement;
const hoverProjectPathLabel = element("hover-project-path-label");
const hoverProjectPin = element("hover-project-pin") as HTMLButtonElement;
const hoverProjectEdit = element("hover-project-edit") as HTMLButtonElement;
const removeProjectDialog = element("remove-project-dialog") as HTMLDialogElement;
const removeProjectForm = element("remove-project-form") as HTMLFormElement;
const removeProjectName = element("remove-project-name");
const toast = element("toast");
const engineLoadingObserver = new MutationObserver(updateModelLoadingSpinner);
engineLoadingObserver.observe(engineState, { childList: true, characterData: true, subtree: true });

restoreSidebarWidth();
restoreInspectorWidth();
renderAccessMode();
initializeCustomSelects();
void initialize();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentRun) void cancelRun();
  else void sendPrompt();
});
messages.addEventListener("scroll", updateScrollToBottom, { passive: true });
scrollToBottom.addEventListener("click", () => messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" }));
window.fitz.onNavigationCommand((command) => void navigateHistory(command === "back" ? -1 : 1));
prompt.addEventListener("input", () => { resizePrompt(); updateContextMeter(); refreshComposerState(); scheduleModelWarmup(); });
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
  if (event.key === "Escape") { if (!managementEditor.hidden) closeManagementEditor(); else if (!connectionEditor.hidden) closeConnectionEditor(); else closePopovers(); }
});

element("new-project").addEventListener("click", () => openProjectDialog());
element("new-session").addEventListener("click", openNewChat);
element("manage-playbooks").addEventListener("click", () => void openPlaybookPage());
connectionsButton.addEventListener("click", () => void openConnectionsPage());
pluginsButton.addEventListener("click", () => void openPluginsPage());
administrationButton.addEventListener("click", () => void openAdministrationPage());
element("refresh-plugins").addEventListener("click", () => void loadPiPackages(false));
pluginsTab.addEventListener("click", () => setPluginView("plugins"));
skillsTab.addEventListener("click", () => setPluginView("skills"));
pluginSearch.addEventListener("input", () => { if (pluginSearchTimer) clearTimeout(pluginSearchTimer); pluginSearchTimer = setTimeout(() => void loadPiPackages(false), 250); });
skillSearch.addEventListener("input", renderPiSkills);
loadMorePlugins.addEventListener("click", () => void loadPiCatalog(true));
element("refresh-administration").addEventListener("click", () => void loadAdministration());
element("refresh-playbooks").addEventListener("click", () => void loadManagementConfiguration(true));
element("refresh-connections").addEventListener("click", () => void syncAndLoadConsumerConnections(true));
element("new-connection").addEventListener("click", () => openConnectionEditor());
element("connection-editor-back").addEventListener("click", closeConnectionEditor);
element("close-management-editor").addEventListener("click", closeManagementEditor);
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-management-editor]")) button.addEventListener("click", closeManagementEditor);
playbookSearch.addEventListener("input", renderManagementPage);
connectionSearch.addEventListener("input", renderConsumerConnections);
element("sidebar-menu").addEventListener("click", toggleSidebar);
for (const menuButton of document.querySelectorAll<HTMLButtonElement>("[data-app-menu]")) menuButton.addEventListener("click", (event) => openAppMenu(menuButton.dataset.appMenu ?? "", menuButton, event));
for (const windowButton of document.querySelectorAll<HTMLButtonElement>("[data-window-action]")) windowButton.addEventListener("click", () => void window.fitz.windowAction(windowButton.dataset.windowAction as "minimize" | "maximize" | "close"));
sidebarResizer.addEventListener("pointerdown", beginSidebarResize);
sidebarResizer.addEventListener("keydown", resizeSidebarWithKeyboard);
inspectorResizer.addEventListener("pointerdown", beginInspectorResize);
inspectorResizer.addEventListener("keydown", resizeInspectorWithKeyboard);
connectionStatus.addEventListener("click", () => void initialize());
contextToggle.addEventListener("click", () => setContextPanel(contextPanel.hasAttribute("hidden")));
inspectorClose.addEventListener("click", () => setContextPanel(false));
inspectorOpen.addEventListener("click", () => void openInspectedResourceExternally());
inspectorRenderToggle.addEventListener("click", () => { if (!inspectedPreview) return; inspectorSourceMode = !inspectorSourceMode; inspectorRenderToggle.setAttribute("aria-pressed", String(inspectorSourceMode)); inspectorRenderToggle.title = inspectorSourceMode ? "View rendered" : "View source"; inspectorRenderToggle.setAttribute("aria-label", inspectorRenderToggle.title); renderResourcePreview(inspectedPreview); });
window.addEventListener("fitz:open-resource", (event) => {
  const reference = (event as CustomEvent<{ reference?: string }>).detail?.reference;
  if (reference) void inspectResource(reference);
});
element("context-add").addEventListener("click", chooseArtifact);
attachButton.addEventListener("click", chooseArtifact);
addArtifactButton.addEventListener("click", chooseArtifact);
artifactFile.addEventListener("change", () => void uploadArtifact());
chooseProjectFolder.addEventListener("click", () => void selectProjectFolder());
model.addEventListener("change", () => { updateModelControls(); resetComposerWarmup(); scheduleModelWarmup(); if (currentSession) void updateSessionBinding(); });
effort.addEventListener("change", updateModelControls);
modelToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(modelMenu, modelToggle); });
contextMeter.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(contextUsagePopover, contextMeter as HTMLButtonElement); });
contextUsagePopover.addEventListener("click", (event) => event.stopPropagation());
contextCompactButton.addEventListener("click", () => void compactCurrentSession());
accessModeToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(accessModeMenu, accessModeToggle); });
accessModeMenu.addEventListener("click", (event) => event.stopPropagation());
for (const choice of document.querySelectorAll<HTMLButtonElement>("[data-access-mode]")) choice.addEventListener("click", () => setAccessMode(choice.dataset.accessMode as AccessMode));
newChatProjectControl.addEventListener("click", (event) => { event.stopPropagation(); newChatProjectDetached = true; newChatProjectControl.hidden = true; showNewChatLanding(); });
newChatEnvironmentControl.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(newChatEnvironmentMenu, newChatEnvironmentControl); });
newChatBranchControl.addEventListener("click", (event) => { event.stopPropagation(); void openBranchMenu(); });
newChatEnvironmentMenu.addEventListener("click", (event) => event.stopPropagation());
newChatBranchMenu.addEventListener("click", (event) => event.stopPropagation());
for (const choice of document.querySelectorAll<HTMLButtonElement>("[data-environment-choice]")) choice.addEventListener("click", () => void chooseEnvironment(choice.dataset.environmentChoice ?? ""));
branchSearch.addEventListener("input", renderBranchList);
showCreateBranch.addEventListener("click", () => { showCreateBranch.hidden = true; createBranchForm.hidden = false; newBranchName.focus(); });
element("create-branch-submit").addEventListener("click", () => void createAndCheckoutBranch());
newBranchName.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void createAndCheckoutBranch(); } });
element("create-worktree-submit").addEventListener("click", () => void createWorktree());
newWorktreeBranch.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void createWorktree(); } });
for (const row of document.querySelectorAll<HTMLButtonElement>("[data-setting]")) row.addEventListener("click", (event) => { event.stopPropagation(); openSettingsSubmenu(row.dataset.setting as "model" | "effort", row); });
advancedSettings.addEventListener("click", (event) => { event.stopPropagation(); toggleAdvancedSettings(); });
temperature.addEventListener("input", updateTemperature);
const storedTemperature = Number(localStorage.getItem("fitz-temperature") ?? "0.4");
temperature.value = String(Number.isFinite(storedTemperature) && storedTemperature >= 0 && storedTemperature <= 2 ? storedTemperature : 0.4);
updateTemperature();
updateConsumerAuthField();
taskMenuToggle.addEventListener("click", (event) => { event.stopPropagation(); togglePopover(taskMenu, taskMenuToggle); });
modelMenu.addEventListener("click", (event) => event.stopPropagation());
taskMenu.addEventListener("click", (event) => event.stopPropagation());
sidebarContextMenu.addEventListener("click", (event) => event.stopPropagation());
projectHoverCard.addEventListener("mouseenter", cancelProjectHoverHide);
projectHoverCard.addEventListener("mouseleave", scheduleProjectHoverHide);
projectHoverCard.addEventListener("click", (event) => event.stopPropagation());
hoverProjectPin.addEventListener("click", () => { if (hoveredProjectId) toggleStored(pinnedProjects, hoveredProjectId, "fitz-pinned-projects"); });
hoverProjectPath.addEventListener("click", () => { const path = projectRecords.find((project) => project.id === hoveredProjectId)?.rootPath; if (path) void openProjectPath(path); });
hoverProjectEdit.addEventListener("click", () => { if (hoveredProjectId) openProjectRenameDialog(hoveredProjectId); });
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
connectionForm.addEventListener("submit", (event) => { event.preventDefault(); void saveConsumerConnection(); });
consumerConnectionAuth.addEventListener("change", updateConsumerAuthField);
cancelConnectionEdit.addEventListener("click", closeConnectionEditor);
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
    await syncAndLoadConsumerConnections(false);
    const [health, connection, identity] = await Promise.all([api("/health"), window.fitz.connectionInfo(), api("/api/v1/me")]); configuredHostOrigin = connection.origin; currentUserId = identity.data?.user?.id; administrator = identity.data?.authMode === "disabled" || identity.data?.user?.role === "administrator";
    applyNavigation();
    await loadModels();
    engineState.textContent = health.engine?.state ?? "UNLOADED";
    routeState.textContent = model.selectedOptions[0]?.textContent ?? "—";
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
  const response = await api("/v1/models"); const previous = preferredRoute ?? model.value;
  model.replaceChildren();
  const priority = new Map([["default", 0], ["fast", 1], ["smart", 2]]);
  const cards = [...(response.data ?? [])].filter((card: Json) => priority.has(String(card.id))).sort((left: Json, right: Json) => (priority.get(left.id) ?? 3) - (priority.get(right.id) ?? 3));
  for (const card of cards) {
    const option = new Option(card.display_name ?? card.id, card.id);
    option.dataset.group = "Routes";
    model.add(option);
  }
  if (previous && [...model.options].some((option) => option.value === previous)) model.value = previous;
  updateModelControls();
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
    }, (toggle, event) => openSidebarMenu("project", project.id, toggle, event), () => openNewChatForProject(project.id));
    const projectButton = projectItem.querySelector(".project-row") as HTMLButtonElement;
    projectButton.classList.toggle("active", project.id === currentProject && !currentSession && !newChatMode);
    projectButton.setAttribute("aria-expanded", String(expandedProjects.has(project.id)));
    projectItem.addEventListener("mouseenter", () => showProjectHover(project, projectItem));
    projectItem.addEventListener("mouseleave", scheduleProjectHoverHide);
    projectButton.addEventListener("focus", () => showProjectHover(project, projectItem));
    projectButton.addEventListener("blur", scheduleProjectHoverHide);
    group.append(projectItem);
    const children = document.createElement("div"); children.className = "project-children"; const childrenInner = document.createElement("div"); childrenInner.className = "project-children-inner"; children.append(childrenInner); group.append(children);
    const projectSessions = [...(sessionsByProject.get(project.id) ?? [])].sort((left, right) => Number(pinnedSessions.has(right.id)) - Number(pinnedSessions.has(left.id)));
      if (projectSessions.length === 0) {
        const emptyState = document.createElement("div"); emptyState.className = "tree-empty"; emptyState.textContent = "No chats"; childrenInner.append(emptyState);
      }
      for (const session of projectSessions) {
        const sessionItem = treeItem(session.title, "task-row", undefined, () => void selectSession(session.id, true, project.id), (toggle, event) => openSidebarMenu("task", session.id, toggle, event));
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
  else { sessionTokenEstimate = 0; updateContextMeter(); showLanding(); await loadArtifacts(); rememberLocation({ view: "conversation", projectId: id }); }
  refreshComposerState();
}

async function selectSession(id: string, rerender = true, projectId?: string): Promise<void> {
  hideChatHover();
  contextCompactStatus.hidden = true; contextCompactStatus.textContent = "";
  showConversationWorkspace();
  newChatMode = false;
  workspace.classList.remove("new-chat-open");
  newChatContext.hidden = true;
  if (projectId) currentProject = projectId;
  if (currentProject) { expandedProjects.add(currentProject); saveSet("fitz-expanded-projects", expandedProjects); }
  currentSession = id;
  const selectedSession = currentSessionRecord();
  selectedConnectionId = selectedSession?.connectionId ?? LOCAL_CONNECTION_ID;
  if (selectedSession?.routeId && [...model.options].some((option) => option.value === selectedSession.routeId)) model.value = selectedSession.routeId;
  updateModelControls();
  if (unreadSessions.delete(id)) saveSet("fitz-unread-sessions", unreadSessions);
  lastSequence = 0;
  if (rerender) renderProjectTree();
  updateTitles();
  messages.replaceChildren(loadingMessage("Loading conversation…"));
  try {
    const transcript = await api(`/api/v1/sessions/${id}/transcript`);
    messages.replaceChildren();
    activeWorkSummary = undefined;
    resourceSearchRoots.clear();
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
        transcriptTools.set(toolCallId, { row: appendToolActivity(toolName, input, toolCallId, true, entry.createdAt), toolName, input });
      }
      if (entry.kind === "tool-result") {
        const toolCallId = String(entry.content?.toolCallId ?? entry.id);
        const existing = transcriptTools.get(toolCallId);
        if (existing) completeToolActivity(existing.row, existing.toolName, existing.input, entry.content?.result, Boolean(entry.content?.isError));
        else completeToolActivity(appendToolActivity(String(entry.content?.toolName ?? "tool"), undefined, toolCallId, true, entry.createdAt), String(entry.content?.toolName ?? "tool"), undefined, entry.content?.result, Boolean(entry.content?.isError));
      }
      if (entry.kind === "compaction") appendContextActivity(entry.content?.manual === true ? "Context compacted" : "Context automatically compacted");
    }
    const pendingApprovals = await api(`/api/v1/sessions/${id}/tool-approvals?status=pending`);
    for (const approval of pendingApprovals.data ?? []) appendToolApproval(approval);
    updateContextMeter();
    if (!messages.childElementCount) showLanding(true);
    messages.scrollTop = messages.scrollHeight;
    await loadArtifacts();
  } catch (error) {
    messages.replaceChildren();
    appendMessage("system", errorMessage(error));
  }
  refreshComposerState();
  prompt.focus();
  rememberLocation({ view: "conversation", ...(currentProject ? { projectId: currentProject } : {}), sessionId: id });
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
  newChatProjectDetached = false;
  currentSession = undefined;
  sessionTokenEstimate = 0;
  contextCompactStatus.hidden = true; contextCompactStatus.textContent = "";
  expandedProjects.add(currentProject);
  saveSet("fitz-expanded-projects", expandedProjects);
  workspace.classList.add("new-chat-open");
  newChatProject.textContent = projectRecords.find((project) => project.id === currentProject)?.name ?? "Project";
  newChatProjectControl.hidden = false;
  renderConnectionChoices();
  newChatContext.hidden = false;
  prompt.value = "";
  resetComposerWarmup();
  composerAttachments.replaceChildren();
  composerAttachments.hidden = true;
  renderProjectTree();
  showNewChatLanding();
  void refreshBranchState();
  updateContextMeter();
  refreshComposerState();
  prompt.focus();
  rememberLocation({ view: "conversation", projectId: currentProject, newChat: true });
}

function openNewChatForProject(id: string): void { currentProject = id; expandedProjects.add(id); saveSet("fitz-expanded-projects", expandedProjects); openNewChat(); }

function showNewChatLanding(): void {
  messages.replaceChildren();
  activeWorkSummary = undefined;
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
    button.addEventListener("click", () => { prompt.value = label!; resizePrompt(); updateContextMeter(); refreshComposerState(); scheduleModelWarmup(); prompt.focus(); });
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
    const response = await api(`/api/v1/projects/${projectId}/sessions`, "POST", { title, connectionId: LOCAL_CONNECTION_ID, routeId: "default" });
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
  const sessions = sessionsByProject.get(id) ?? [];
  addMenuItem(pinnedProjects.has(id) ? "Unpin project" : "Pin project", () => toggleStored(pinnedProjects, id, "fitz-pinned-projects"), false, '<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>');
  addMenuItem("Open in Explorer", () => { if (project.rootPath) void openProjectPath(project.rootPath); }, false, '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>', !project.rootPath);
  addMenuItem("Create permanent worktree", () => openProjectWorktreeSetup(id), false, '<path d="M4 6h8M12 3l3 3-3 3M16 14H8M8 11l-3 3 3 3"></path>', !project.rootPath);
  addMenuItem("Edit project", () => openProjectRenameDialog(id), false, '<circle cx="10" cy="10" r="3"></circle><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"></path>');
  addMenuSeparator();
  addMenuItem("Archive chats", () => void archiveProjectChats(id), false, '<rect x="3" y="5" width="14" height="11" rx="2"></rect><path d="M3 8h14M8 11h4"></path>', sessions.length === 0);
  addMenuItem("Remove", () => openRemoveProjectDialog(id), false, '<path d="m5 5 10 10M15 5 5 15"></path>');
}

function buildTaskMenu(id: string): void {
  const session = (currentProject ? sessionsByProject.get(currentProject) : undefined)?.find((item) => item.id === id);
  const project = projectRecords.find((item) => item.id === currentProject);
  if (!session) return;
  addMenuItem(pinnedSessions.has(id) ? "Unpin chat" : "Pin chat", () => toggleStored(pinnedSessions, id, "fitz-pinned-sessions"), false, '<path d="m12.8 3 4.2 4.2-2.2 2.2-.5 3.4-2.1 2.1-7.1-7.1 2.1-2.1 3.4-.5z"></path><path d="m8.3 11.7-5 5"></path>');
  addMenuItem("Rename chat", () => { currentSession = id; openRenameDialog(); }, false, '<path d="M4 14.5V17h2.5L15 8.5 11.5 5z"></path><path d="m10.5 6 3.5 3.5"></path>');
  addMenuItem("Archive chat", () => { currentSession = id; void archiveCurrentTask(); }, true, '<rect x="3" y="5" width="14" height="11" rx="2"></rect><path d="M3 8h14M8 11h4"></path>');
  addMenuItem(unreadSessions.has(id) ? "Mark as read" : "Mark as unread", () => toggleStored(unreadSessions, id, "fitz-unread-sessions"), false, '<path d="M4 4.5h12v9H9l-4 3v-3H4z"></path>');
  if (project?.rootPath) {
    addMenuSeparator();
    addMenuItem("Open in Explorer", () => void openProjectPath(project.rootPath), false, '<path d="M3.5 6.5h5l1.5 2h6.5v7.5h-13z"></path><path d="M3.5 6.5V4h5l1.5 2"></path>');
    addMenuItem("Copy working directory", () => void copyValue(project.rootPath, "Working directory copied"), false, '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>');
  }
  addMenuItem("Copy session ID", () => void copyValue(id, "Session ID copied"), false, '<rect x="6" y="6" width="10" height="10" rx="2"></rect><path d="M13 6V4H4v9h2"></path>');
  addMenuItem("Copy deeplink", () => void copyValue(`fitz://sessions/${id}`, "Deeplink copied"), false, '<path d="m8 12 4-4"></path><path d="M6.5 13.5 5 15a3 3 0 0 1-4-4l2.5-2.5a3 3 0 0 1 4.2 0"></path><path d="M13.5 6.5 15 5a3 3 0 0 1 4 4l-2.5 2.5a3 3 0 0 1-4.2 0"></path>');
  addMenuSeparator();
  addMenuItem("Continue in new chat", () => void continueInNewChat(session), false, '<path d="M4 5h7a4 4 0 0 1 4 4v6"></path><path d="m12 12 3 3 3-3"></path>');
}

function addMenuItem(label: string, action: () => void, danger = false, icon?: string, disabled = false): void {
  const button = document.createElement("button"); button.type = "button"; button.classList.toggle("danger", danger); button.disabled = disabled;
  const text = document.createElement("span"); text.className = "menu-label"; text.textContent = label; if (icon) button.append(svg(icon)); button.append(text);
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

function openProjectWorktreeSetup(id: string): void { openNewChatForProject(id); newChatEnvironmentMenu.hidden = false; newChatEnvironmentControl.setAttribute("aria-expanded", "true"); createWorktreeForm.hidden = false; newWorktreeBranch.focus(); }

function openRemoveProjectDialog(id: string): void { const project = projectRecords.find((item) => item.id === id); if (!project) return; removeProjectTarget = id; removeProjectName.textContent = project.name; removeProjectDialog.showModal(); }

async function removeProject(): Promise<void> {
  if (!removeProjectTarget) return; const id = removeProjectTarget; setFormBusy(removeProjectForm, true);
  try { await api(`/api/v1/projects/${id}`, "DELETE"); pinnedProjects.delete(id); expandedProjects.delete(id); saveSet("fitz-pinned-projects", pinnedProjects); saveSet("fitz-expanded-projects", expandedProjects); removeProjectDialog.close(); removeProjectTarget = undefined; currentProject = currentProject === id ? undefined : currentProject; currentSession = undefined; await loadProjects(currentProject); showToast("Project removed"); }
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

async function continueInNewChat(session: Json): Promise<void> {
  if (!currentProject) return;
  try { const response = await api(`/api/v1/projects/${currentProject}/sessions`, "POST", { title: `Continue: ${session.title}` }); await loadProjects(currentProject, response.data.id); showToast("Created continuation chat"); }
  catch (error) { showToast(errorMessage(error)); }
}

async function openPlaybookPage(): Promise<void> {
  if (!pairingPage.hidden) { pairingCode.focus(); return; }
  closePopovers();
  setContextPanel(false);
  administrationPage.hidden = true;
  pluginsPage.hidden = true;
  connectionsPage.hidden = true;
  playbookPage.hidden = false;
  closeManagementEditor();
  setConversationInert(true);
  element("manage-playbooks").classList.add("active");
  connectionsButton.classList.remove("active");
  pluginsButton.classList.remove("active");
  administrationButton.classList.remove("active");
  playbookList.replaceChildren(panelEmpty("Loading playbooks…"));
  await loadManagementConfiguration(true);
  rememberLocation({ view: "playbooks" });
}

async function openConnectionsPage(): Promise<void> { if (!pairingPage.hidden) return; closePopovers(); setContextPanel(false); pairingPage.hidden = true; administrationPage.hidden = true; pluginsPage.hidden = true; playbookPage.hidden = true; connectionsPage.hidden = false; closeManagementEditor(); closeConnectionEditor(); setConversationInert(true); element("manage-playbooks").classList.remove("active"); administrationButton.classList.remove("active"); pluginsButton.classList.remove("active"); connectionsButton.classList.add("active"); await syncAndLoadConsumerConnections(false); rememberLocation({ view: "connections" }); }
async function openPluginsPage(): Promise<void> { if (!administrator || !pairingPage.hidden) return; closePopovers(); setContextPanel(false); pairingPage.hidden = true; administrationPage.hidden = true; playbookPage.hidden = true; connectionsPage.hidden = true; pluginsPage.hidden = false; closeManagementEditor(); closeConnectionEditor(); setConversationInert(true); element("manage-playbooks").classList.remove("active"); connectionsButton.classList.remove("active"); administrationButton.classList.remove("active"); pluginsButton.classList.add("active"); installedPlugins.replaceChildren(panelEmpty("Loading plugins…")); await loadPiPackages(false); rememberLocation({ view: "plugins" }); }
async function openAdministrationPage(): Promise<void> { if (!administrator || !pairingPage.hidden) return; closePopovers(); setContextPanel(false); pairingPage.hidden = true; playbookPage.hidden = true; connectionsPage.hidden = true; pluginsPage.hidden = true; administrationPage.hidden = false; closeManagementEditor(); setConversationInert(true); element("manage-playbooks").classList.remove("active"); connectionsButton.classList.remove("active"); pluginsButton.classList.remove("active"); administrationButton.classList.add("active"); adminUsers.replaceChildren(panelEmpty("Loading users…")); await loadAdministration(); rememberLocation({ view: "administration" }); }
function showPairingPage(message: string): void { closePopovers(); setContextPanel(false); administrationPage.hidden = true; playbookPage.hidden = true; connectionsPage.hidden = true; pluginsPage.hidden = true; pairingPage.hidden = false; closeManagementEditor(); setConversationInert(true); element("manage-playbooks").classList.remove("active"); connectionsButton.classList.remove("active"); pluginsButton.classList.remove("active"); administrationButton.classList.remove("active"); pairingDescription.textContent = message || "Enter a one-time code from your Fitz host."; pairingError.hidden = true; pairingError.textContent = ""; pairingCode.focus(); }
function showConversationWorkspace(): void { pairingPage.hidden = true; administrationPage.hidden = true; playbookPage.hidden = true; connectionsPage.hidden = true; pluginsPage.hidden = true; closeManagementEditor(); setConversationInert(false); element("manage-playbooks").classList.remove("active"); connectionsButton.classList.remove("active"); pluginsButton.classList.remove("active"); administrationButton.classList.remove("active"); }
function setConversationInert(inert: boolean): void { for (const area of [workspaceHeader, messages, composerDock]) { area.toggleAttribute("inert", inert); area.setAttribute("aria-hidden", String(inert)); } }

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
  if (!location || currentRun) return;
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

function setPluginView(view: "plugins" | "skills"): void {
  const showPlugins = view === "plugins";
  pluginsView.hidden = !showPlugins;
  skillsView.hidden = showPlugins;
  pluginsTab.classList.toggle("active", showPlugins);
  skillsTab.classList.toggle("active", !showPlugins);
  if (!showPlugins) renderPiSkills();
}

async function loadPiPackages(appendCatalog: boolean): Promise<void> {
  try {
    if (!appendCatalog) {
      const [packages, skills] = await Promise.all([
        api("/api/v1/management/pi/packages"),
        api("/api/v1/management/pi/skills"),
      ]);
      installedPiPackages = packages.data ?? [];
      installedPiSkills = skills.data ?? [];
      renderInstalledPiPackages();
      renderPiSkills();
    }
    await loadPiCatalog(appendCatalog);
  } catch (error) {
    installedPlugins.replaceChildren(panelEmpty(errorMessage(error)));
    pluginCatalog.replaceChildren();
    showToast(errorMessage(error));
  }
}

async function loadPiCatalog(append: boolean): Promise<void> {
  const offset = append ? piCatalogPackages.length : 0;
  const query = encodeURIComponent(pluginSearch.value.trim());
  const response = await api(`/api/v1/management/pi/catalog?query=${query}&offset=${offset}&limit=30`);
  piCatalogTotal = response.data?.total ?? 0;
  piCatalogPackages = append ? [...piCatalogPackages, ...(response.data?.packages ?? [])] : (response.data?.packages ?? []);
  renderPiCatalog();
}

function renderInstalledPiPackages(): void {
  installedPlugins.replaceChildren();
  if (!installedPiPackages.length) { installedPlugins.append(panelEmpty("No plugins installed")); return; }
  for (const entry of installedPiPackages) {
    const card = piPackageCard(entry.displayName, entry.description ?? entry.source, entry.version, piSourceWebsite(entry.source));
    const counts = Object.entries(entry.resources).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`);
    if (counts.length) card.querySelector(".plugin-meta")?.append(document.createTextNode(` · ${counts.join(" · ")}`));
    const actions = card.querySelector(".plugin-actions") as HTMLElement;
    actions.append(pluginAction(entry.enabled ? "Disable" : "Enable", () => mutatePiPackage("PUT", "/api/v1/management/pi/packages/enabled", { source: entry.source, enabled: !entry.enabled })), pluginAction("Update", () => mutatePiPackage("POST", "/api/v1/management/pi/packages/update", { source: entry.source })), pluginAction("Remove", () => mutatePiPackage("DELETE", "/api/v1/management/pi/packages", { source: entry.source }), true));
    installedPlugins.append(card);
  }
}

function renderPiCatalog(): void {
  pluginCatalog.replaceChildren();
  const installed = new Set(installedPiPackages.map((entry) => entry.source.replace(/^npm:/, "")));
  if (!piCatalogPackages.length) { pluginCatalog.append(panelEmpty("No matching Pi packages")); }
  for (const entry of piCatalogPackages) {
    const card = piPackageCard(entry.name, entry.description, entry.version, entry.links.homepage ?? entry.links.repository ?? entry.links.npm ?? npmPackageWebsite(entry.name));
    const actions = card.querySelector(".plugin-actions") as HTMLElement;
    if (installed.has(entry.name)) { const mark = document.createElement("span"); mark.className = "plugin-installed-mark"; mark.textContent = "✓ Installed"; actions.append(mark); }
    else actions.append(pluginInstallAction(entry.name));
    pluginCatalog.append(card);
  }
  loadMorePlugins.hidden = piCatalogPackages.length >= piCatalogTotal;
}

function renderPiSkills(): void {
  installedSkills.replaceChildren();
  const query = skillSearch.value.trim().toLowerCase();
  const visible = installedPiSkills.filter((skill) => !query || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query));
  if (!visible.length) { installedSkills.append(panelEmpty("No matching skills")); return; }
  for (const skill of visible) {
    const card = piPackageCard(skill.name, skill.description || skill.source, undefined, piSourceWebsite(skill.source));
    card.classList.add("skill-card");
    const actions = card.querySelector(".plugin-actions") as HTMLElement;
    const mark = document.createElement("span"); mark.className = "plugin-installed-mark"; mark.textContent = skill.enabled ? "✓" : "Disabled"; actions.append(mark);
    installedSkills.append(card);
  }
}

function piPackageCard(name: string, description: string, version?: string, website?: string): HTMLElement {
  const card = document.createElement("article"); card.className = "plugin-card";
  if (website) {
    card.classList.add("plugin-card-linked"); card.tabIndex = 0; card.setAttribute("role", "link"); card.title = "Open plugin website";
    card.addEventListener("click", (event) => { if (!(event.target as HTMLElement).closest(".plugin-actions")) void window.fitz.openExternal(website); });
    card.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest(".plugin-actions")) { event.preventDefault(); void window.fitz.openExternal(website); } });
  }
  const icon = document.createElement("span"); icon.className = "plugin-icon"; icon.append(sparkIcon());
  const copy = document.createElement("div"); copy.className = "plugin-copy";
  const heading = document.createElement("strong"); heading.textContent = name;
  const meta = document.createElement("span"); meta.className = "plugin-meta"; meta.textContent = `${description}${version ? ` · ${version}` : ""}`;
  copy.append(heading, meta); const actions = document.createElement("div"); actions.className = "plugin-actions"; card.append(icon, copy, actions); return card;
}

function piSourceWebsite(source: string): string | undefined { return source.startsWith("npm:") ? npmPackageWebsite(source.slice(4).replace(/@[^@/]+$/, "")) : undefined; }
function npmPackageWebsite(name: string): string { return `https://www.npmjs.com/package/${encodeURIComponent(name)}`; }

function pluginAction(label: string, action: () => Promise<void>, danger = false): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = danger ? "plugin-action danger" : "plugin-action"; button.textContent = label;
  button.addEventListener("click", async () => { button.disabled = true; const old = button.textContent; button.textContent = "Working…"; try { await action(); } finally { button.disabled = false; button.textContent = old; } }); return button;
}

function pluginInstallAction(name: string): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button"; button.className = "plugin-action"; button.textContent = "Install"; button.title = "Pi packages can run code with the same access as Fitz";
  button.addEventListener("click", async () => {
    if (button.dataset.confirm !== "true") { button.dataset.confirm = "true"; button.textContent = "Install?"; return; }
    button.disabled = true; button.textContent = "Installing…";
    try { await mutatePiPackage("POST", "/api/v1/management/pi/packages/install", { source: `npm:${name}` }); }
    finally { button.disabled = false; button.dataset.confirm = "false"; button.textContent = "Install"; }
  });
  button.addEventListener("mouseleave", () => { if (!button.disabled) { button.dataset.confirm = "false"; button.textContent = "Install"; } });
  return button;
}

async function mutatePiPackage(method: string, path: string, body: unknown): Promise<void> {
  try { await api(path, method, body); await loadPiPackages(false); showToast("Plugin configuration updated"); }
  catch (error) { showToast(errorMessage(error)); }
}

async function syncAndLoadConsumerConnections(reportFailure: boolean): Promise<void> {
  const results = await window.fitz.syncConsumerConnections();
  consumerConnectionRecords = await window.fitz.listConsumerConnections();
  await loadManagementConfiguration(false);
  renderConsumerConnections();
  renderConnectionChoices();
  const failed = results.filter((item) => !item.connected);
  if (reportFailure && failed.length) showToast(failed[0]?.error ?? "Connection failed");
}

function renderConsumerConnections(): void {
  consumerConnections.replaceChildren();
  const connectionRecords = connectionViews();
  if (!connectionRecords.length) { const empty = document.createElement("p"); empty.className = "connections-empty"; empty.textContent = "No APIs connected yet"; consumerConnections.append(empty); return; }
  const query = connectionSearch.value.trim().toLowerCase();
  const visible = connectionRecords.filter((connection) => !query || [connection.displayName, ...connection.availableModels.flatMap((model) => [model.id, model.displayName, model.modelId])].some((value) => String(value ?? "").toLowerCase().includes(query)));
  if (!visible.length) { consumerConnections.append(panelEmpty("No matching connections")); return; }
  const routes = managementConfiguration?.routes ?? [];
  for (const connection of visible) {
    const card = document.createElement("section"); card.className = "playbook-card consumer-playbook-card";
    const heading = document.createElement("div"); heading.className = "playbook-heading";
    const identity = document.createElement("div");
    const name = document.createElement("h3"); name.textContent = connection.displayName;
    identity.append(name);
    const actions = document.createElement("div"); actions.className = "playbook-actions";
    if (!connection.hosted) {
      const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "quiet-button compact-button"; refresh.textContent = "Refresh"; refresh.addEventListener("click", () => void testConsumerConnection(connection.source, refresh));
      const manage = document.createElement("button"); manage.type = "button"; manage.className = "quiet-button compact-button"; manage.textContent = "Edit"; manage.addEventListener("click", () => openConnectionEditor(connection.source));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "quiet-button compact-button danger"; remove.textContent = "Remove"; remove.addEventListener("click", () => { if (remove.dataset.confirm !== "true") { remove.dataset.confirm = "true"; remove.textContent = "Confirm"; return; } void removeConsumerConnection(connection.id); });
      actions.append(refresh, manage, remove);
    }
    heading.append(identity, actions); card.append(heading);
    if (!connection.availableModels.length) card.append(panelEmpty("No chat models available"));
    for (const consumerModel of connection.availableModels) {
      const recipeCard = document.createElement("article"); recipeCard.className = "recipe-card";
      const recipeDetails = document.createElement("div"); recipeDetails.className = "recipe-card-details";
      const modelName = document.createElement("span"); modelName.className = "recipe-display-name"; modelName.textContent = consumerModel.displayName ?? consumerModel.id;
      const labels = document.createElement("div"); labels.className = "recipe-card-labels";
      const modelLabel = document.createElement("span"); modelLabel.className = "recipe-card-label"; modelLabel.textContent = consumerModel.modelId ?? "API model";
      labels.append(modelLabel);
      if (consumerModel.contextTokens) { const contextLabel = document.createElement("span"); contextLabel.className = "recipe-card-label recipe-context-label"; contextLabel.textContent = `${formatTokenCount(consumerModel.contextTokens)} ctx`; labels.append(contextLabel); }
      recipeDetails.append(modelName, labels);
      const recipeActions = document.createElement("div"); recipeActions.className = "recipe-card-actions";
      const testButton = document.createElement("button"); testButton.type = "button"; testButton.className = "recipe-test-button"; testButton.setAttribute("aria-live", "polite"); testButton.addEventListener("click", () => void testRecipe({ id: consumerModel.recipeId, displayName: consumerModel.id }, recipeCard, testButton));
      const routeToggle = document.createElement("div"); routeToggle.className = "recipe-route-toggle"; routeToggle.setAttribute("role", "group"); routeToggle.setAttribute("aria-label", `${consumerModel.id} routing`);
      for (const definition of FIXED_ROUTES) {
        const routeId = connection.hosted ? definition.id : consumerFixedRouteId(connection.id, definition.id);
        const route = routes.find((item: Json) => item.id === routeId) ?? (!connection.hosted ? routes.find((item: Json) => item.id === `consumer--${definition.id}` && item.recipeId === consumerModel.recipeId) : undefined);
        const button = document.createElement("button"); button.type = "button"; button.className = `route-symbol route-${definition.id}`; button.title = definition.label; button.setAttribute("aria-label", `${definition.label} route`); button.setAttribute("aria-pressed", String(route?.recipeId === consumerModel.recipeId)); button.classList.toggle("active", route?.recipeId === consumerModel.recipeId); button.append(svg(definition.icon)); button.addEventListener("click", () => void assignConnectionRoute(connection, definition, consumerModel, button));
        routeToggle.append(button);
      }
      recipeActions.append(routeToggle, testButton); renderRecipeTestState(consumerModel.recipeId, recipeCard, testButton);
      recipeCard.append(recipeDetails, recipeActions); card.append(recipeCard);
    }
    consumerConnections.append(card);
  }
}

function connectionViews(): ConnectionView[] {
  const recipes = managementConfiguration?.recipes ?? [];
  const hostedModels = recipes
    .filter((recipe: Json) => !String(recipe.id).startsWith("consumer-recipe--") && recipe.capabilities?.chatCompletions !== false)
    .map((recipe: Json): ConnectionModelView => ({ id: String(recipe.id), routeId: "", recipeId: String(recipe.id), displayName: String(recipe.displayName ?? recipe.modelId ?? recipe.id), modelId: String(recipe.modelId ?? recipe.id), contextTokens: Number(recipe.contextTokens) }));
  const hostedConnection: HostedConnectionView = { id: LOCAL_CONNECTION_ID, displayName: String(managementConfiguration?.hostName ?? "This PC"), baseUrl: "", authType: "none", hasCredential: false, availableModels: hostedModels, updatedAt: "", hosted: true };
  return [hostedConnection, ...consumerConnectionRecords.map((connection): SavedConnectionView => ({ ...connection, hosted: false, availableModels: connection.models.map((model) => ({ ...model })), source: connection }))];
}

async function saveConsumerConnection(): Promise<void> {
  setFormBusy(connectionForm, true); setConnectionFormStatus("Connecting…");
  try {
    await window.fitz.saveConsumerConnection({ ...(consumerConnectionId.value ? { id: consumerConnectionId.value } : {}), displayName: consumerConnectionName.value.trim(), baseUrl: consumerConnectionUrl.value.trim(), authType: consumerConnectionAuth.value as "none" | "bearer", ...(consumerConnectionKey.value.trim() ? { apiKey: consumerConnectionKey.value.trim() } : {}) });
    closeConnectionEditor(); consumerConnectionRecords = await window.fitz.listConsumerConnections(); await loadManagementConfiguration(false); renderConsumerConnections(); renderConnectionChoices();
  } catch (error) { setConnectionFormStatus(errorMessage(error), true); }
  finally { setFormBusy(connectionForm, false); }
}

async function testConsumerConnection(connection: ConsumerConnectionSummary, button: HTMLButtonElement): Promise<void> { button.disabled = true; button.textContent = "Refreshing…"; try { await window.fitz.saveConsumerConnection({ id: connection.id, displayName: connection.displayName, baseUrl: connection.baseUrl, authType: connection.authType }); consumerConnectionRecords = await window.fitz.listConsumerConnections(); await loadManagementConfiguration(false); renderConsumerConnections(); renderConnectionChoices(); } catch (error) { button.disabled = false; button.textContent = "Failed"; button.title = errorMessage(error); } }
function openConnectionEditor(connection?: ConsumerConnectionSummary): void { resetConsumerConnectionForm(); connectionListView.hidden = true; connectionEditor.hidden = false; connectionEditorTitle.textContent = connection ? "Configure connection" : "New connection"; if (connection) { consumerConnectionId.value = connection.id; consumerConnectionName.value = connection.displayName; consumerConnectionUrl.value = connection.baseUrl; consumerConnectionAuth.value = connection.authType; consumerConnectionKey.placeholder = connection.hasCredential ? "Leave blank to keep current key" : "API key"; } updateConsumerAuthField(); consumerConnectionName.focus(); }
function closeConnectionEditor(): void { resetConsumerConnectionForm(); connectionEditor.hidden = true; connectionListView.hidden = false; }
async function removeConsumerConnection(id: string): Promise<void> { try { await window.fitz.removeConsumerConnection(id); consumerConnectionRecords = await window.fitz.listConsumerConnections(); if (selectedConnectionId === id) selectedConnectionId = LOCAL_CONNECTION_ID; await loadManagementConfiguration(false); renderConsumerConnections(); renderConnectionChoices(); } catch (error) { showToast(errorMessage(error)); } }
function resetConsumerConnectionForm(): void { connectionForm.reset(); consumerConnectionId.value = ""; consumerConnectionAuth.value = "bearer"; consumerConnectionKey.placeholder = "Stored securely"; setConnectionFormStatus(); updateConsumerAuthField(); }
function updateConsumerAuthField(): void { consumerApiKeyField.hidden = consumerConnectionAuth.value === "none"; consumerConnectionKey.required = consumerConnectionAuth.value === "bearer" && !consumerConnectionId.value; }
function setConnectionFormStatus(message?: string, error = false): void { connectionFormStatus.hidden = !message; connectionFormStatus.textContent = message ?? ""; connectionFormStatus.classList.toggle("error", error); }

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

async function loadManagementConfiguration(renderPage: boolean): Promise<void> {
  try {
    managementConfiguration = await api("/api/v1/management/status");
    syncContextLimit();
    updateContextMeter();
    renderConnectionChoices();
    if (renderPage) renderManagementPage();
  } catch (error) {
    if (renderPage) playbookList.replaceChildren(panelEmpty(`Management data is unavailable: ${errorMessage(error)}`));
  }
}

function syncContextLimit(): void {
  const session = currentSessionRecord();
  const connectionId = session?.connectionId ?? selectedConnectionId;
  const executionRouteId = connectionId === LOCAL_CONNECTION_ID ? model.value : consumerFixedRouteId(connectionId, model.value as FixedRouteId);
  const route = managementConfiguration?.routes?.find((item: Json) => item.id === executionRouteId) ?? managementConfiguration?.routes?.find((item: Json) => item.id === model.value);
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

function consumerFixedRouteId(connectionId: string, id: FixedRouteId): string { return `consumer--${connectionId}--route--${id}`; }

async function assignConnectionRoute(connection: ConnectionView, definition: (typeof FIXED_ROUTES)[number], consumerModel: ConnectionModelView, button: HTMLButtonElement): Promise<void> {
  const routeId = connection.hosted ? definition.id : consumerFixedRouteId(connection.id, definition.id);
  const current = managementConfiguration?.routes?.find((route: Json) => route.id === routeId);
  if (current?.recipeId === consumerModel.recipeId) return;
  button.disabled = true;
  try {
    await api(`/api/v1/management/routes/${routeId}`, "PUT", {
      displayName: definition.label,
      description: definition.id === "fast" ? "Lowest-latency route" : definition.id === "smart" ? "Highest-capability route" : "Primary route",
      recipeId: consumerModel.recipeId,
      enabled: true,
      isDefault: definition.id === "default",
    });
    await loadManagementConfiguration(false);
    renderConsumerConnections();
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

async function refreshBranchState(): Promise<void> {
  const rootPath = activeProject()?.rootPath;
  if (!rootPath) { currentBranch = "main"; availableBranches = [currentBranch]; newChatBranchLabel.textContent = currentBranch; renderBranchList(); return; }
  try {
    const state = await window.fitz.gitBranches(rootPath);
    currentBranch = state.current || "main";
    availableBranches = state.branches.length ? state.branches : [currentBranch];
    newChatBranchLabel.textContent = currentBranch;
    renderBranchList();
  } catch {
    currentBranch = "main"; availableBranches = [currentBranch]; newChatBranchLabel.textContent = currentBranch; renderBranchList();
  }
}

async function openBranchMenu(): Promise<void> {
  const opening = newChatBranchMenu.hidden;
  closePopovers();
  if (!opening) return;
  newChatBranchMenu.hidden = false;
  newChatBranchControl.setAttribute("aria-expanded", "true");
  branchSearch.value = "";
  showCreateBranch.hidden = false;
  createBranchForm.hidden = true;
  await refreshBranchState();
  branchSearch.focus();
}

function renderBranchList(): void {
  const query = branchSearch.value.trim().toLowerCase();
  branchList.replaceChildren();
  for (const branch of availableBranches.filter((value) => value.toLowerCase().includes(query))) {
    const button = document.createElement("button"); button.type = "button"; button.classList.toggle("selected", branch === currentBranch);
    button.append(svg('<circle cx="6" cy="4.5" r="1.5"></circle><circle cx="6" cy="15.5" r="1.5"></circle><circle cx="14" cy="7" r="1.5"></circle><path d="M6 6v8M7.5 12.5c4 0 6.5-1.5 6.5-4"></path>'), Object.assign(document.createElement("span"), { textContent: branch }));
    button.addEventListener("click", () => void checkoutBranch(branch)); branchList.append(button);
  }
  if (!branchList.childElementCount) branchList.append(panelEmpty("No matching branches"));
}

async function checkoutBranch(branch: string): Promise<void> {
  const rootPath = activeProject()?.rootPath; if (!rootPath || branch === currentBranch) { closePopovers(); return; }
  try { const state = await window.fitz.checkoutBranch(rootPath, branch); currentBranch = state.current; availableBranches = state.branches; newChatBranchLabel.textContent = currentBranch; closePopovers(); }
  catch (error) { showToast(errorMessage(error)); }
}

async function createAndCheckoutBranch(): Promise<void> {
  const rootPath = activeProject()?.rootPath; const branch = newBranchName.value.trim(); if (!rootPath || !branch) return;
  try { const state = await window.fitz.createBranch(rootPath, branch); currentBranch = state.current; availableBranches = state.branches; newChatBranchLabel.textContent = currentBranch; newBranchName.value = ""; closePopovers(); }
  catch (error) { showToast(errorMessage(error)); }
}

async function chooseEnvironment(choice: string): Promise<void> {
  if (choice === "local") { closePopovers(); return; }
  if (choice === "worktree") { createWorktreeForm.hidden = false; newWorktreeBranch.focus(); return; }
  if (choice === "usage") { closePopovers(); contextUsagePopover.hidden = false; contextMeter.setAttribute("aria-expanded", "true"); }
}

async function createWorktree(): Promise<void> {
  const project = activeProject(); const branch = newWorktreeBranch.value.trim(); if (!project?.rootPath || !branch) return;
  try {
    const worktree = await window.fitz.createWorktree(project.rootPath, branch);
    await api(`/api/v1/projects/${project.id}`, "PATCH", { rootPath: worktree.path });
    project.rootPath = worktree.path; currentBranch = worktree.branch; availableBranches = [worktree.branch];
    newChatBranchLabel.textContent = currentBranch; newWorktreeBranch.value = ""; closePopovers();
  } catch (error) { showToast(errorMessage(error)); }
}

function renderConnectionChoices(): void {
  const views = connectionViews();
  if (!views.some((connection) => connection.id === selectedConnectionId)) selectedConnectionId = LOCAL_CONNECTION_ID;
  const selected = views.find((connection) => connection.id === selectedConnectionId) ?? views[0];
  newChatEnvironmentLabel.textContent = selected?.displayName ?? "This PC";
  newChatConnectionList.replaceChildren();
  for (const connection of views) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.connectionId = connection.id;
    button.append(svg('<circle cx="10" cy="10" r="6"></circle><path d="M7 10h6M10 7v6"></path>'), Object.assign(document.createElement("span"), { textContent: connection.displayName }));
    if (connection.id === selectedConnectionId) button.append(Object.assign(document.createElement("b"), { textContent: "✓" }));
    button.addEventListener("click", () => { selectedConnectionId = connection.id; resetComposerWarmup(); scheduleModelWarmup(); renderConnectionChoices(); closePopovers(); });
    newChatConnectionList.append(button);
  }
}

async function updateSessionBinding(): Promise<void> {
  const session = currentSessionRecord();
  if (!session || !model.value) return;
  try {
    const response = await api(`/api/v1/sessions/${session.id}`, "PATCH", { connectionId: session.connectionId ?? LOCAL_CONNECTION_ID, routeId: model.value });
    Object.assign(session, response.data);
  } catch (error) { showToast(errorMessage(error)); }
}

function updateModelControls(): void {
  routeState.textContent = model.selectedOptions[0]?.textContent ?? "—";
  const effortLabel = effort.selectedOptions[0]?.textContent ?? "Medium";
  modelSummary.textContent = `${model.selectedOptions[0]?.textContent ?? "Model"} · ${effortLabel}`;
  modelValue.textContent = model.selectedOptions[0]?.textContent ?? "Model";
  effortValue.textContent = effortLabel;
  syncContextLimit();
  updateContextMeter();
}

function toggleAdvancedSettings(): void {
  const opening = advancedSettingsPanel.hidden;
  settingsSubmenu.hidden = true;
  for (const item of document.querySelectorAll(".setting-row")) item.classList.remove("active");
  advancedSettingsPanel.hidden = !opening;
  advancedSettings.setAttribute("aria-expanded", String(opening));
}

function updateTemperature(): void {
  temperatureValue.textContent = Number(temperature.value).toFixed(1);
  localStorage.setItem("fitz-temperature", temperature.value);
}

function openSettingsSubmenu(kind: "model" | "effort", row: HTMLButtonElement): void {
  const select = kind === "model" ? model : effort;
  advancedSettingsPanel.hidden = true;
  advancedSettings.setAttribute("aria-expanded", "false");
  settingsSubmenu.replaceChildren();
  let currentGroup = "";
  for (const option of [...select.options]) {
    const group = kind === "model" ? option.dataset.group ?? "" : "";
    if (group && group !== currentGroup) { const heading = document.createElement("small"); heading.className = "settings-submenu-heading"; heading.textContent = group; settingsSubmenu.append(heading); currentGroup = group; }
    const button = document.createElement("button"); button.type = "button"; button.classList.toggle("selected", option.value === select.value);
    const label = document.createElement("span"); label.textContent = option.textContent; button.append(label);
    button.addEventListener("click", (event) => { event.stopPropagation(); select.value = option.value; updateModelControls(); closePopovers(); }); settingsSubmenu.append(button);
  }
  for (const item of document.querySelectorAll(".setting-row")) item.classList.toggle("active", item === row);
  settingsSubmenu.style.top = `${Math.max(-8, row.offsetTop - 8)}px`;
  settingsSubmenu.classList.remove("open-left");
  settingsSubmenu.hidden = false;
  let bounds = settingsSubmenu.getBoundingClientRect();
  if (bounds.right > window.innerWidth - 16) { settingsSubmenu.classList.add("open-left"); bounds = settingsSubmenu.getBoundingClientRect(); }
  if (bounds.bottom > window.innerHeight - 16) settingsSubmenu.style.top = `${Number.parseFloat(settingsSubmenu.style.top) - (bounds.bottom - window.innerHeight + 16)}px`;
}

function initializeCustomSelects(): void {
  const enhance = (select: HTMLSelectElement) => {
    if (select.hidden || select.dataset.customMenu === "true") return;
    select.dataset.customMenu = "true";
    select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-expanded", "false");
    select.addEventListener("pointerdown", (event) => {
      if (select.disabled || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      select.focus();
      openCustomSelect(select);
    });
    select.addEventListener("click", (event) => { if (!select.disabled) { event.preventDefault(); event.stopPropagation(); } });
    select.addEventListener("keydown", (event) => {
      if (select.disabled || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      openCustomSelect(select, true);
    });
  };
  document.querySelectorAll<HTMLSelectElement>("select").forEach(enhance);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node instanceof HTMLSelectElement) enhance(node);
      node.querySelectorAll<HTMLSelectElement>("select").forEach(enhance);
    }
  }).observe(document.body, { childList: true, subtree: true });
  selectPopover.addEventListener("click", (event) => event.stopPropagation());
  selectPopover.addEventListener("keydown", (event) => {
    const choices = [...selectPopover.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); activeCustomSelect?.focus(); closePopovers(); return; }
    const next = event.key === "ArrowDown" ? Math.min(current + 1, choices.length - 1) : event.key === "ArrowUp" ? Math.max(current - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); choices[next]?.focus(); }
  });
}

function openCustomSelect(select: HTMLSelectElement, focusSelection = false): void {
  const reopening = activeCustomSelect === select && !selectPopover.hidden;
  closePopovers();
  if (reopening) return;
  activeCustomSelect = select;
  select.setAttribute("aria-expanded", "true");
  selectPopover.replaceChildren();
  let currentGroup = "";
  let selectedButton: HTMLButtonElement | undefined;
  for (const option of [...select.options]) {
    const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : "";
    if (group && group !== currentGroup) {
      const heading = document.createElement("small"); heading.className = "select-group-label"; heading.textContent = group; selectPopover.append(heading); currentGroup = group;
    }
    const button = document.createElement("button"); button.type = "button"; button.className = "select-option"; button.disabled = option.disabled; button.dataset.value = option.value; button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(option.selected));
    button.classList.toggle("selected", option.selected); button.textContent = option.textContent ?? option.value;
    if (option.selected) selectedButton = button;
    button.addEventListener("click", (event) => { event.stopPropagation(); select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); closePopovers(); select.focus(); });
    selectPopover.append(button);
  }
  const rect = select.getBoundingClientRect();
  selectPopover.style.width = `${Math.max(150, rect.width)}px`;
  selectPopover.style.left = `${Math.min(rect.left, window.innerWidth - Math.max(150, rect.width) - 8)}px`;
  selectPopover.style.top = `${rect.bottom + 5}px`;
  selectPopover.hidden = false;
  const menuRect = selectPopover.getBoundingClientRect();
  if (menuRect.bottom > window.innerHeight - 8 && rect.top > menuRect.height + 12) selectPopover.style.top = `${Math.max(8, rect.top - menuRect.height - 5)}px`;
  if (focusSelection) queueMicrotask(() => (selectedButton ?? selectPopover.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus());
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
  const opening = popover.hidden;
  closePopovers();
  popover.hidden = !opening;
  toggle.setAttribute("aria-expanded", String(opening));
}

function closePopovers(): void {
  if (activeCustomSelect) activeCustomSelect.setAttribute("aria-expanded", "false");
  activeCustomSelect = undefined;
  selectPopover.hidden = true;
  appMenuPopover.hidden = true;
  modelMenu.hidden = true;
  settingsSubmenu.hidden = true;
  advancedSettingsPanel.hidden = true;
  contextUsagePopover.hidden = true;
  accessModeMenu.hidden = true;
  taskMenu.hidden = true;
  sidebarContextMenu.hidden = true;
  newChatEnvironmentMenu.hidden = true;
  newChatBranchMenu.hidden = true;
  hideProjectHover();
  hideChatHover();
  modelToggle.setAttribute("aria-expanded", "false");
  advancedSettings.setAttribute("aria-expanded", "false");
  contextMeter.setAttribute("aria-expanded", "false");
  accessModeToggle.setAttribute("aria-expanded", "false");
  taskMenuToggle.setAttribute("aria-expanded", "false");
  newChatEnvironmentControl.setAttribute("aria-expanded", "false");
  newChatBranchControl.setAttribute("aria-expanded", "false");
  for (const row of document.querySelectorAll(".setting-row")) row.classList.remove("active");
  for (const toggle of projects.querySelectorAll(".tree-menu-toggle")) toggle.setAttribute("aria-expanded", "false");
  for (const toggle of document.querySelectorAll("[data-app-menu]")) toggle.setAttribute("aria-expanded", "false");
}

async function sendPrompt(submittedContent?: string, existingUserMessage?: HTMLElement): Promise<void> {
  const content = (submittedContent ?? prompt.value).trim();
  if (!content) return;
  if (!currentSession && newChatMode && currentProject) {
    try {
      const title = content.split(/\r?\n/, 1)[0]!.trim().slice(0, 80) || "New chat";
      const response = await api(`/api/v1/projects/${currentProject}/sessions`, "POST", { title, connectionId: selectedConnectionId, routeId: model.value as FixedRouteId });
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
  resetComposerWarmup();
  resizePrompt();
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  if (!existingUserMessage) appendMessage("user", content);
  const activity = appendRunActivity("Working");
  const runStartedAt = Date.now();
  sessionTokenEstimate += estimateTokens(content);
  updateContextMeter();
  setStatus("Queued", "loading");
  try {
    const response = await api("/api/v1/agent/runs", "POST", {
      model: model.value,
      max_tokens: Number(effort.value),
      temperature: Number(temperature.value),
      sessionId: currentSession,
      accessMode,
      messages: [{ role: "user", content }],
    });
    const runId = String(response.data.id);
    if (response.context?.compacted) appendContextActivity();
    currentRun = runId;
    lastSequence = 0;
    engineState.textContent = "QUEUED";
    refreshComposerState();
    await followRun(runId, activity, runStartedAt);
  } catch (error) {
    activity.remove();
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

async function followRun(runId: string, activity: HTMLElement, runStartedAt: number): Promise<void> {
  let assistant: HTMLElement | undefined;
  const toolActivities = new Map<string, { row: HTMLElement; toolName: string; input: unknown }>();
  const approvalActivities = new Map<string, HTMLElement>();
  let done = false;
  let queued = true;
  let reconnectAttempt = 0;
  let nextEnginePoll = 0;
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
      if (event.type === "run.queue.updated") {
        queued = event.data?.status === "queued";
        if (queued) { const position = Math.max(1, Number(event.data?.position ?? 1)); setStatus(`Queued ${position}`, "loading"); engineState.textContent = "QUEUED"; setRunActivity(activity, position === 1 ? "Queued · next" : `Queued · ${position - 1} ahead`, runStartedAt); }
        if (!contextPanel.hidden) void loadAgentQueue();
      }
      if (event.type === "run.started") { queued = false; setStatus("Working", "active"); engineState.textContent = "WORKING"; setRunActivity(activity, "Working", runStartedAt); }
      if (event.type === "assistant.delta") {
        if (!assistant) { activity.remove(); assistant = appendMessage("assistant", ""); }
        const delta = event.data.text ?? ""; appendMarkdown(assistant, delta); sessionTokenEstimate += estimateTokens(delta); updateContextMeter();
        messages.scrollTop = messages.scrollHeight;
      }
      if (event.type === "tool.approval.requested") {
        const approvalId = String(event.data?.approvalId ?? "");
        activity.remove();
        if (assistant) { markAssistantAsCommentary(assistant); assistant = undefined; }
        approvalActivities.set(approvalId, appendToolApproval({ id: approvalId, toolName: String(event.data?.toolName ?? "tool"), request: event.data?.input ?? {}, status: "pending" }));
        setStatus("Waiting for approval", "active");
        engineState.textContent = "WAITING";
      }
      if (event.type === "tool.approval.resolved") {
        const approvalId = String(event.data?.approvalId ?? "");
        const decision = event.data?.decision === "approved" ? "approved" : "denied";
        const approval = approvalActivities.get(approvalId) ?? messages.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(approvalId)}"]`);
        if (approval) resolveToolApprovalCard(approval, decision);
        setStatus("Working", "active");
        engineState.textContent = "WORKING";
      }
      if (event.type === "tool.started") {
        const toolName = String(event.data?.toolName ?? "tool");
        const toolCallId = String(event.data?.toolCallId ?? `${toolName}-${event.sequence}`);
        const input = event.data?.input;
        activity.remove();
        if (assistant) { markAssistantAsCommentary(assistant); assistant = undefined; }
        toolActivities.set(toolCallId, { row: appendToolActivity(toolName, input, toolCallId, true), toolName, input });
        setStatus(`Running ${toolName}`, "active");
        engineState.textContent = toolName.toUpperCase();
      }
      if (event.type === "tool.completed") {
        const toolCallId = String(event.data?.toolCallId ?? "");
        const existing = toolActivities.get(toolCallId);
        if (existing) completeToolActivity(existing.row, existing.toolName, existing.input, event.data?.result, Boolean(event.data?.isError));
        setStatus("Working", "active");
        engineState.textContent = "WORKING";
      }
      if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type)) {
        done = true;
        const success = event.type === "run.completed";
        setStatus(success ? "Ready" : event.type.slice(4), success ? "idle" : "error");
        engineState.textContent = success || event.type === "run.cancelled" ? "READY" : event.type.slice(4).toUpperCase();
        activity.remove();
        if (!success && event.data?.error && event.type !== "run.cancelled") appendMessage("system", event.data.error);
        if (success && !assistant) appendMessage("system", "The model completed without returning a response.");
      }
    }
    if (!done && !queued && !assistant && Date.now() >= nextEnginePoll) {
      nextEnginePoll = Date.now() + 1_000;
      try {
        const management = await api("/api/v1/management/status");
        const state = String(management.engine?.state ?? "");
        engineState.textContent = state || "WORKING";
        if (state === "READY" || state === "BUSY") setRunActivity(activity, "Thinking", runStartedAt);
        else if (state === "FAILED") activity.textContent = `Model failed: ${management.engine?.failureReason ?? "Unknown error"}`;
        else setRunActivity(activity, "Working", runStartedAt);
      } catch { setRunActivity(activity, "Working", runStartedAt); }
    }
    if (!done) await delay(350);
  }
}

async function loadArtifacts(): Promise<void> {
  artifacts.replaceChildren();
  composerAttachments.replaceChildren();
  composerAttachments.hidden = true;
  if (contextPanel.hidden) artifactPreview.replaceChildren(inspectorEmpty("Select a file or link in the conversation to inspect it here."));
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
  if (contextPanel.hidden) return;
  void loadAgentQueue().finally(() => { if (!contextPanel.hidden) queueRefreshTimer = setTimeout(scheduleQueueRefresh, 1_000); });
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
  setInspectorHeading(String(artifact.name ?? "Artifact"), `${formatBytes(Number(artifact.byteSize ?? 0))} · Attachment`, "file");
  inspectedResource = undefined; inspectedPreview = undefined; inspectorOpen.hidden = true; inspectorRenderToggle.hidden = true; setContextPanel(true);
  artifactPreview.replaceChildren(inspectorEmpty("Loading preview…"));
  try {
    const response = await window.fitz.request({ path: `/api/v1/artifacts/${artifact.id}/content`, responseType: "base64" });
    if (response.status >= 400) throw new HttpError("Artifact could not be loaded", response.status);
    artifactPreview.replaceChildren();
    if (artifact.kind === "text" || artifact.kind === "code") {
      const source = new TextDecoder().decode(base64Bytes(response.body));
      if (/\.(?:md|markdown)$/i.test(String(artifact.name ?? ""))) { const markdown = document.createElement("article"); markdown.className = "inspector-markdown message-body"; setMarkdown(markdown, source); artifactPreview.append(markdown); }
      else if (/\.html?$/i.test(String(artifact.name ?? ""))) artifactPreview.append(htmlPreviewFrame(source, String(artifact.name ?? "HTML preview")));
      else { const pre = document.createElement("pre"); pre.className = "inspector-source"; const code = document.createElement("code"); code.textContent = source; pre.append(code); artifactPreview.append(pre); }
      return;
    }
    if (["image", "audio", "video"].includes(artifact.kind)) {
      const node = document.createElement(artifact.kind === "image" ? "img" : artifact.kind) as HTMLImageElement | HTMLMediaElement;
      node.className = "inspector-media";
      node.setAttribute("src", `data:${artifact.mimeType};base64,${response.body}`);
      if (node instanceof HTMLMediaElement) node.controls = true;
      artifactPreview.append(node); return;
    }
    if (artifact.kind === "pdf") {
      const frame = document.createElement("iframe"); frame.className = "inspector-frame"; frame.setAttribute("sandbox", ""); frame.title = artifact.name; frame.src = `data:application/pdf;base64,${response.body}`; artifactPreview.append(frame); return;
    }
    artifactPreview.append(inspectorEmpty("Preview unavailable for this file type"));
  } catch (error) { artifactPreview.replaceChildren(inspectorError(errorMessage(error))); }
}

async function inspectResource(reference: string): Promise<void> {
  const version = ++inspectionVersion;
  inspectedPreview = undefined; inspectorRenderToggle.hidden = true;
  setContextPanel(true);
  artifactPreview.replaceChildren(inspectorEmpty("Loading preview…"));
  if (/^https?:\/\//i.test(reference)) {
    try {
      const url = new URL(reference);
      inspectedResource = { kind: "url", url: url.toString() };
      inspectedPreview = undefined; inspectorRenderToggle.hidden = true;
      setInspectorHeading(url.hostname, url.toString(), "url");
      inspectorOpen.hidden = false;
      const frame = document.createElement("iframe"); frame.className = "inspector-frame"; frame.title = url.toString(); frame.src = url.toString(); frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups-to-escape-sandbox"); frame.referrerPolicy = "no-referrer";
      artifactPreview.replaceChildren(frame);
    } catch { artifactPreview.replaceChildren(inspectorError("This URL is not valid.")); }
    return;
  }
  const projectRoot = String(activeProject()?.rootPath ?? "");
  if (!projectRoot) { setInspectorHeading("File unavailable", reference, "file"); artifactPreview.replaceChildren(inspectorError("Select a project before opening a local file.")); return; }
  setInspectorHeading(reference.split(/[\\/]/).pop() ?? reference, reference, "file");
  inspectorOpen.hidden = true;
  try {
    const preview = await window.fitz.previewResource({ projectRoot, reference, searchRoots: [...resourceSearchRoots] });
    if (version !== inspectionVersion) return;
    inspectedResource = { kind: "file", path: preview.path };
    inspectedPreview = preview; inspectorSourceMode = false; inspectorRenderToggle.setAttribute("aria-pressed", "false"); inspectorRenderToggle.title = "View source"; inspectorRenderToggle.setAttribute("aria-label", "View source"); inspectorRenderToggle.hidden = preview.kind !== "markdown" && preview.kind !== "html";
    setInspectorHeading(preview.name, `${preview.path}${preview.line ? ` · line ${preview.line}` : ""}`, preview.kind);
    inspectorOpen.hidden = false;
    renderResourcePreview(preview);
  } catch (error) {
    if (version !== inspectionVersion) return;
    inspectedResource = undefined; inspectedPreview = undefined; inspectorOpen.hidden = true; inspectorRenderToggle.hidden = true; artifactPreview.replaceChildren(inspectorError(resourcePreviewError(error, reference)));
  }
}

function resourcePreviewError(error: unknown, reference: string): string {
  const detail = errorMessage(error).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "");
  if (/\b(?:ENOENT|File not found:)\b/i.test(detail)) return `Could not find ${reference}. The file may have moved or the agent only mentioned its name.`;
  return detail;
}

function renderResourcePreview(preview: ResourcePreview): void {
  artifactPreview.replaceChildren();
  if (preview.kind === "markdown" && !inspectorSourceMode) {
    const markdown = document.createElement("article"); markdown.className = "inspector-markdown message-body"; setMarkdown(markdown, preview.content); artifactPreview.append(markdown); return;
  }
  if (preview.kind === "html" && !inspectorSourceMode) { artifactPreview.append(htmlPreviewFrame(preview.content, preview.name)); return; }
  const pre = document.createElement("pre"); pre.className = "inspector-source"; const code = document.createElement("code"); code.textContent = preview.content; pre.append(code); artifactPreview.append(pre);
  if (preview.line) requestAnimationFrame(() => { const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 19; artifactPreview.scrollTop = Math.max(0, (preview.line! - 3) * lineHeight); });
}

function htmlPreviewFrame(source: string, title: string): HTMLIFrameElement {
  const frame = document.createElement("iframe"); frame.className = "inspector-frame"; frame.title = title; frame.setAttribute("sandbox", ""); frame.srcdoc = source; return frame;
}

function setInspectorHeading(title: string, location: string, kind: "file" | "url" | ResourcePreview["kind"]): void {
  inspectorTitle.textContent = title; inspectorLocation.textContent = location;
  inspectorIcon.replaceChildren(kind === "url" ? svg('<circle cx="10" cy="10" r="7"></circle><path d="M3 10h14M10 3a11 11 0 0 1 0 14M10 3a11 11 0 0 0 0 14"></path>') : svg('<path d="M5 2.8h6l4 4v10.4H5z"></path><path d="M11 2.8v4h4"></path>'));
}

async function openInspectedResourceExternally(): Promise<void> {
  if (!inspectedResource) return;
  try { if (inspectedResource.kind === "url") await window.fitz.openExternal(inspectedResource.url); else await window.fitz.openPath(inspectedResource.path); }
  catch (error) { showToast(errorMessage(error)); }
}

function showLanding(hasTask = false): void {
  messages.replaceChildren();
  activeWorkSummary = undefined;
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

function syncConversationLayout(): void {
  const scrollbarWidth = Math.max(0, messages.offsetWidth - messages.clientWidth);
  workspace.style.setProperty("--conversation-scrollbar", `${scrollbarWidth}px`);
  workspace.style.setProperty("--composer-height", `${composerDock.offsetHeight}px`);
  updateScrollToBottom();
}

function updateScrollToBottom(): void {
  const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  scrollToBottom.hidden = distanceFromBottom < 48 || Boolean(messages.querySelector(".landing, .new-chat-landing"));
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
  if (role !== "commentary") finishWorkSummary(createdAt);
  const article = document.createElement("article"); article.className = `message ${role}`;
  const content = document.createElement("div"); content.className = "message-body"; if (role === "assistant" || role === "commentary") setMarkdown(content, text); else content.textContent = text; article.append(content); appendMessageActions(article, content, role, text, createdAt); messages.append(article); messages.scrollTop = messages.scrollHeight; return content;
}

function appendCommentary(text: string, createdAt?: string): HTMLElement {
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  const article = document.createElement("article"); article.className = "message commentary";
  const content = document.createElement("div"); content.className = "message-body"; setMarkdown(content, text); article.append(content); appendMessageActions(article, content, "commentary", text, createdAt);
  appendWorkNode(article, createdAt);
  return content;
}

function appendMessageActions(article: HTMLElement, content: HTMLElement, role: string, originalText: string, createdAt?: string): void {
  if (!["user", "assistant", "commentary"].includes(role)) return;
  const actions = document.createElement("div"); actions.className = "message-actions";
  const time = document.createElement("time"); time.className = "message-time"; time.dateTime = createdAt ?? new Date().toISOString(); time.textContent = formatMessageTimestamp(createdAt); actions.append(time);
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "message-action"; copy.title = "Copy message"; copy.setAttribute("aria-label", "Copy message");
  copy.append(svg('<rect x="7" y="7" width="9" height="9" rx="1.6"></rect><path d="M5.8 13.4H5A2 2 0 0 1 3 11.4V5a2 2 0 0 1 2-2h6.4a2 2 0 0 1 2 2v.8"></path>'));
  copy.addEventListener("click", () => void copyValue(content.innerText, "Copied message"));
  actions.append(copy);
  if (role === "user") {
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "message-action"; edit.title = "Edit message"; edit.setAttribute("aria-label", "Edit message");
    edit.append(svg('<path d="m4.2 14.8.7-3.2 7.8-7.8a1.45 1.45 0 0 1 2.05 2.05L7 13.65z"></path><path d="m11.7 4.8 2.05 2.05"></path>'));
    edit.addEventListener("click", () => startInlineMessageEdit(article, content, actions, originalText));
    actions.append(edit);
  }
  article.append(actions);
}

function formatMessageTimestamp(value?: string): string {
  const date = value ? new Date(value) : new Date();
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
  return `${weekday} ${time}`;
}

function startInlineMessageEdit(article: HTMLElement, content: HTMLElement, actions: HTMLElement, originalText: string): void {
  if (currentRun) { showToast("Wait for the current response before editing a message."); return; }
  const bubble = document.createElement("div"); bubble.className = "message-edit-bubble";
  const editor = document.createElement("textarea"); editor.className = "message-inline-editor"; editor.value = originalText; editor.setAttribute("aria-label", "Edit message");
  const controls = document.createElement("div"); controls.className = "message-edit-controls";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "message-edit-cancel"; cancel.textContent = "Cancel";
  const send = document.createElement("button"); send.type = "button"; send.className = "message-edit-send"; send.textContent = "Send";
  const restore = () => { bubble.replaceWith(content); actions.hidden = false; article.classList.remove("editing"); };
  const submit = () => {
    const revised = editor.value.trim();
    if (!revised) { editor.focus(); return; }
    content.textContent = revised;
    restore();
    void sendPrompt(revised, article);
  };
  cancel.addEventListener("click", restore); send.addEventListener("click", submit);
  editor.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); restore(); } if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } });
  controls.append(cancel, send); bubble.append(editor, controls); actions.hidden = true; article.classList.add("editing"); content.replaceWith(bubble); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
}

function markAssistantAsCommentary(content: HTMLElement): void {
  const article = content.closest<HTMLElement>(".message.assistant");
  if (!article) return;
  article.classList.remove("assistant");
  article.classList.add("commentary");
  appendWorkNode(article);
}

function appendToolActivity(toolName: string, input: unknown, toolCallId: string, running: boolean, createdAt?: string): HTMLElement {
  if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren();
  const row = document.createElement("div"); row.className = `message agent-activity${running ? " running" : ""}`; row.dataset.toolCallId = toolCallId; row.dataset.toolName = toolName;
  const summary = document.createElement("button"); summary.type = "button"; summary.className = "agent-activity-summary"; summary.setAttribute("aria-expanded", "false");
  const icon = document.createElement("span"); icon.className = "agent-activity-icon"; icon.append(activityIcon(toolName));
  const label = document.createElement("span"); label.className = "agent-activity-label"; label.textContent = describeToolActivity(toolName, input, running); label.title = label.textContent;
  registerResourceSearchRoot(toolName, input);
  const resource = toolResourceReference(toolName, input);
  if (resource) { label.classList.add("file-target"); label.tabIndex = 0; label.setAttribute("role", "link"); label.addEventListener("click", (event) => { event.stopPropagation(); void inspectResource(resource); }); label.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void inspectResource(resource); } }); }
  const chevron = document.createElement("span"); chevron.className = "agent-activity-chevron"; chevron.append(svg('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
  summary.append(icon, label, chevron);
  const details = document.createElement("div"); details.className = "agent-activity-details";
  if (toolName === "bash") renderShellActivity(details, input, running);
  else {
    if (input !== undefined) details.append(toolActivityDetail("Input", input, "tool-activity-input"));
    details.append(toolActivityDetail("Result", running ? undefined : null, "tool-activity-result"));
  }
  details.hidden = true;
  summary.addEventListener("click", () => { const open = details.hasAttribute("hidden"); details.hidden = !open; row.classList.toggle("open", open); summary.setAttribute("aria-expanded", String(open)); });
  row.append(summary, details); appendWorkNode(row, createdAt); return row;
}

function completeToolActivity(row: HTMLElement, toolName: string, input: unknown, result: unknown, isError: boolean): void {
  row.classList.remove("running"); row.classList.toggle("failed", isError);
  const label = row.querySelector<HTMLElement>(".agent-activity-label");
  if (label) { label.textContent = isError ? `${describeToolActivity(toolName, input, false)} (failed)` : describeToolActivity(toolName, input, false); label.title = label.textContent; }
  const resultValue = row.querySelector<HTMLElement>(".tool-activity-result .tool-activity-value");
  if (resultValue) resultValue.textContent = formatToolPayload(result, "No result returned");
  const shellOutput = row.querySelector<HTMLElement>(".shell-output");
  if (shellOutput) shellOutput.textContent = shellOutputText(result);
  const shellStatus = row.querySelector<HTMLElement>(".shell-status");
  if (shellStatus) { shellStatus.textContent = isError ? "× Failed" : "✓ Success"; shellStatus.classList.toggle("failed", isError); }
}

function renderShellActivity(details: HTMLElement, input: unknown, running: boolean): void {
  details.classList.add("shell-details");
  const title = document.createElement("span"); title.className = "shell-title"; title.textContent = "Shell";
  const command = document.createElement("pre"); command.className = "shell-command"; command.textContent = shellCommand(input);
  const output = document.createElement("pre"); output.className = "shell-output"; output.textContent = running ? "Running…" : "No output";
  const status = document.createElement("span"); status.className = "shell-status"; status.textContent = running ? "Running…" : "✓ Success";
  details.append(title, command, output, status);
}

function shellCommand(input: unknown): string {
  if (input && typeof input === "object") {
    const value = input as Json;
    const command = value.command ?? value.cmd;
    if (typeof command === "string") return command;
  }
  return formatToolPayload(input, "Command unavailable");
}

function shellOutputText(result: unknown): string {
  if (result && typeof result === "object") {
    const content = (result as Json).content;
    if (Array.isArray(content)) {
      const text = content.filter((item) => item && typeof item === "object" && typeof item.text === "string").map((item) => item.text).join("");
      if (text) return text.trimEnd();
    }
  }
  return formatToolPayload(result, "No output");
}

function toolActivityDetail(label: string, value: unknown, className: string): HTMLElement {
  const section = document.createElement("section"); section.className = `tool-activity-detail ${className}`;
  const heading = document.createElement("span"); heading.className = "tool-activity-detail-label"; heading.textContent = label;
  const content = document.createElement("pre"); content.className = "tool-activity-value"; content.textContent = formatToolPayload(value, "Waiting for result…");
  section.append(heading, content); return section;
}

function formatToolPayload(value: unknown, emptyLabel: string): string {
  if (value === undefined || value === null) return emptyLabel;
  const raw = typeof value === "string" ? value : safeStringify(value);
  const maximumCharacters = 50_000;
  return raw.length > maximumCharacters ? `${raw.slice(0, maximumCharacters)}\n… ${raw.length - maximumCharacters} more characters` : raw;
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
}

function appendContextActivity(text = "Context automatically compacted"): HTMLElement {
  finishWorkSummary();
  const row = document.createElement("div"); row.className = "message context-activity";
  const icon = document.createElement("span"); icon.className = "agent-activity-icon"; icon.append(contextActivityIcon());
  const label = document.createElement("span"); label.className = "agent-activity-label"; label.textContent = text;
  row.append(icon, label); messages.append(row); messages.scrollTop = messages.scrollHeight; return row;
}

function appendToolApproval(approval: Json): HTMLElement {
  const row = document.createElement("section"); row.className = "message tool-approval"; row.dataset.approvalId = String(approval.id ?? "");
  const heading = document.createElement("div"); heading.className = "tool-approval-heading";
  heading.append(activityIcon(String(approval.toolName ?? "tool")), Object.assign(document.createElement("span"), { textContent: `Allow ${String(approval.toolName ?? "tool")}?` }));
  const request = document.createElement("pre"); request.className = "tool-approval-request"; request.textContent = formatToolPayload(approval.request, "No arguments");
  const actions = document.createElement("div"); actions.className = "tool-approval-actions";
  const deny = document.createElement("button"); deny.type = "button"; deny.textContent = "Deny";
  const approve = document.createElement("button"); approve.type = "button"; approve.className = "approve-tool"; approve.textContent = "Approve";
  deny.addEventListener("click", () => void decideToolApproval(row, "denied")); approve.addEventListener("click", () => void decideToolApproval(row, "approved"));
  const statusText = document.createElement("span"); statusText.className = "tool-approval-status";
  actions.append(deny, approve); row.append(heading, request, actions, statusText); messages.append(row); messages.scrollTop = messages.scrollHeight;
  if (approval.status === "approved" || approval.status === "denied") resolveToolApprovalCard(row, approval.status);
  return row;
}

async function decideToolApproval(row: HTMLElement, decision: "approved" | "denied"): Promise<void> {
  const approvalId = row.dataset.approvalId; if (!approvalId) return;
  for (const button of row.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  const statusText = row.querySelector<HTMLElement>(".tool-approval-status"); if (statusText) statusText.textContent = decision === "approved" ? "Approving…" : "Denying…";
  try { const response = await api(`/api/v1/tool-approvals/${approvalId}/decision`, "POST", { decision }); resolveToolApprovalCard(row, response.data?.status === "approved" ? "approved" : "denied"); }
  catch (error) { for (const button of row.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false; if (statusText) statusText.textContent = ""; showToast(errorMessage(error)); }
}

function resolveToolApprovalCard(row: HTMLElement, decision: "approved" | "denied"): void {
  row.classList.add("resolved"); const statusText = row.querySelector<HTMLElement>(".tool-approval-status"); if (statusText) statusText.textContent = decision === "approved" ? "Approved" : "Denied";
}

function describeToolActivity(toolName: string, input: unknown, running: boolean): string {
  const value = input && typeof input === "object" ? input as Json : {};
  const target = String(value.path ?? value.file_path ?? value.filePath ?? value.command ?? value.cmd ?? value.pattern ?? value.query ?? "").trim();
  const verb = running
    ? ({ bash: "Running", edit: "Editing", write: "Writing", read: "Reading", grep: "Searching", find: "Finding", ls: "Listing" } as Json)[toolName] ?? "Running"
    : ({ bash: "Ran", edit: "Edited", write: "Wrote", read: "Read", grep: "Searched", find: "Found", ls: "Listed" } as Json)[toolName] ?? "Ran";
  return target ? `${verb} ${target}` : `${verb} ${friendlyToolName(toolName)}`;
}

function toolResourceReference(toolName: string, input: unknown): string | undefined {
  if (!["edit", "write", "read"].includes(toolName) || !input || typeof input !== "object") return undefined;
  const value = input as Json; const path = value.path ?? value.file_path ?? value.filePath;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

function registerResourceSearchRoot(toolName: string, input: unknown): void {
  if (!input || typeof input !== "object") return;
  const value = input as Json; const path = value.path ?? value.file_path ?? value.filePath;
  if (typeof path !== "string" || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path.trim())) return;
  const normalized = path.trim();
  resourceSearchRoots.delete(normalized); resourceSearchRoots.add(normalized);
  while (resourceSearchRoots.size > 32) resourceSearchRoots.delete(resourceSearchRoots.values().next().value!);
  void toolName;
}

function friendlyToolName(toolName: string): string { return toolName.replaceAll("_", " "); }

function appendRunActivity(text: string): HTMLElement { const value = document.createElement("div"); value.className = "message run-activity"; value.textContent = text; appendWorkNode(value); return value; }

function appendWorkNode(node: HTMLElement, createdAt?: string): void {
  const work = ensureWorkSummary(createdAt);
  work.lastAt = Math.max(work.lastAt, activityTimestamp(createdAt));
  work.details.append(node);
  messages.scrollTop = messages.scrollHeight;
}

function ensureWorkSummary(createdAt?: string): NonNullable<typeof activeWorkSummary> {
  if (activeWorkSummary) return activeWorkSummary;
  const root = document.createElement("section"); root.className = "work-summary open";
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "work-summary-toggle"; toggle.setAttribute("aria-expanded", "true");
  const label = document.createElement("span"); label.className = "work-summary-label"; label.textContent = "Working…";
  const chevron = document.createElement("span"); chevron.className = "work-summary-chevron"; chevron.append(svg('<path d="m8 5.5 4.5 4.5L8 14.5"></path>'));
  const details = document.createElement("div"); details.className = "work-summary-details";
  toggle.append(label, chevron);
  toggle.addEventListener("click", () => {
    const open = details.hasAttribute("hidden");
    details.hidden = !open;
    root.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  root.append(toggle, details); messages.append(root);
  const timestamp = activityTimestamp(createdAt);
  activeWorkSummary = { root, toggle, details, startedAt: timestamp, lastAt: timestamp };
  return activeWorkSummary;
}

function finishWorkSummary(completedAt?: string): void {
  const work = activeWorkSummary;
  if (!work) return;
  const endedAt = Math.max(work.lastAt, activityTimestamp(completedAt));
  const label = work.toggle.querySelector<HTMLElement>(".work-summary-label");
  if (label) label.textContent = `Worked for ${formatElapsed(endedAt - work.startedAt)}`;
  work.details.hidden = true;
  work.root.classList.remove("open");
  work.toggle.setAttribute("aria-expanded", "false");
  activeWorkSummary = undefined;
}

function activityTimestamp(value?: string): number {
  if (value) { const timestamp = Date.parse(value); if (Number.isFinite(timestamp)) return timestamp; }
  return Date.now();
}

function setRunActivity(activity: HTMLElement, label: string, startedAt: number): void {
  activity.textContent = `${label}… ${formatElapsed(Date.now() - startedAt)}`;
}

function setAccessMode(mode: AccessMode): void { accessMode = mode; localStorage.setItem("fitz-access-mode", mode); renderAccessMode(); closePopovers(); }

function renderAccessMode(): void {
  const values: Record<AccessMode, { label: string; icon: string }> = {
    full: { label: "Full access", icon: '<path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M10 7v3.2M10 13h.01"></path>' },
    ask: { label: "Ask first", icon: '<path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M8.4 8.1a1.8 1.8 0 1 1 2.5 1.7c-.8.4-.9.8-.9 1.3M10 13.7h.01"></path>' },
    "read-only": { label: "Read only", icon: '<rect x="4.2" y="8.5" width="11.6" height="8" rx="2"></rect><path d="M6.8 8.5V6.3a3.2 3.2 0 0 1 6.4 0v2.2"></path>' },
  };
  accessModeLabel.textContent = values[accessMode].label; accessModeIcon.innerHTML = values[accessMode].icon; accessModeToggle.dataset.mode = accessMode;
  for (const choice of accessModeMenu.querySelectorAll<HTMLButtonElement>("[data-access-mode]")) choice.classList.toggle("selected", choice.dataset.accessMode === accessMode);
}

function refreshComposerState(): void {
  const ready = Boolean((currentSession || (newChatMode && currentProject)) && model.value);
  prompt.disabled = !ready || Boolean(currentRun);
  model.disabled = model.options.length === 0 || Boolean(currentRun);
  effort.disabled = Boolean(currentRun);
  temperature.disabled = Boolean(currentRun);
  advancedSettings.disabled = Boolean(currentRun);
  modelToggle.disabled = model.options.length === 0 || Boolean(currentRun);
  accessModeToggle.disabled = Boolean(currentRun);
  attachButton.disabled = !currentSession || Boolean(currentRun);
  contextCompactButton.disabled = !currentSession || Boolean(currentRun);
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
  taskTitle.textContent = "";
  taskMenuToggle.hidden = !session;
}

function showChatHover(session: Json, project: Json, anchor: HTMLElement): void {
  hideProjectHover();
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

function showProjectHover(project: Json, anchor: HTMLElement): void {
  cancelProjectHoverHide(); hideChatHover(); hoveredProjectId = project.id;
  const taskCount = (sessionsByProject.get(project.id) ?? []).length;
  hoverProjectTitle.textContent = project.name;
  hoverProjectTaskCount.textContent = `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`;
  hoverProjectPathLabel.textContent = project.rootPath || "No source folder";
  hoverProjectPath.disabled = !project.rootPath;
  const pinned = pinnedProjects.has(project.id);
  hoverProjectPin.setAttribute("aria-pressed", String(pinned));
  hoverProjectPin.setAttribute("aria-label", pinned ? "Unpin project" : "Pin project");
  hoverProjectPin.title = pinned ? "Unpin project" : "Pin project";
  const bounds = anchor.getBoundingClientRect();
  projectHoverCard.hidden = false;
  const cardBounds = projectHoverCard.getBoundingClientRect();
  projectHoverCard.style.left = `${Math.max(8, Math.min(window.innerWidth - cardBounds.width - 8, bounds.right + 10))}px`;
  projectHoverCard.style.top = `${Math.max(52, Math.min(window.innerHeight - cardBounds.height - 8, bounds.top))}px`;
}

function cancelProjectHoverHide(): void { if (projectHoverHideTimer) clearTimeout(projectHoverHideTimer); projectHoverHideTimer = undefined; }
function scheduleProjectHoverHide(): void { cancelProjectHoverHide(); projectHoverHideTimer = setTimeout(hideProjectHover, 120); }
function hideProjectHover(): void { cancelProjectHoverHide(); projectHoverCard.hidden = true; hoveredProjectId = undefined; }

function setContextPanel(open: boolean): void {
  contextPanel.hidden = !open;
  inspectorResizer.hidden = !open;
  workspace.classList.toggle("inspector-open", open);
  shell.classList.toggle("context-open", open);
  contextToggle.setAttribute("aria-expanded", String(open));
  if (!open) inspectionVersion += 1;
}

function toggleSidebar(): void { shell.classList.toggle("sidebar-collapsed"); closePopovers(); }
function resizePrompt(): void { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; }
function resetComposerWarmup(): void { composerHadText = false; if (modelWarmupTimer) clearTimeout(modelWarmupTimer); modelWarmupTimer = undefined; }
function scheduleModelWarmup(): void {
  const hasText = prompt.value.length > 0;
  if (!hasText) { resetComposerWarmup(); return; }
  if (composerHadText || currentRun || !model.value) return;
  composerHadText = true;
  modelWarmupTimer = setTimeout(() => {
    modelWarmupTimer = undefined;
    speculativeWarmupActive = true;
    updateModelLoadingSpinner();
    void api("/api/v1/inference/warm", "POST", { model: model.value, connectionId: selectedConnectionId })
      .catch(() => { composerHadText = false; })
      .finally(() => { speculativeWarmupActive = false; updateModelLoadingSpinner(); });
  }, 120);
}
function updateModelLoadingSpinner(): void { const loading = speculativeWarmupActive || ["QUEUED", "PREPARING", "LOADING"].includes(engineState.textContent ?? ""); contextMeter.classList.toggle("model-loading", loading); if (loading) contextMeter.setAttribute("aria-label", "Loading model"); }
function updateContextMeter(): void { const usedTokens = sessionTokenEstimate + estimateTokens(prompt.value); const used = Math.min(100, (usedTokens / contextTokenLimit) * 100); contextMeter.style.setProperty("--context-used", `${used}%`); contextPercent.textContent = `${Math.round(used)}% full`; contextTokens.textContent = `≈${formatTokenCount(usedTokens)} / ${formatTokenCount(contextTokenLimit)} tokens used`; contextMeter.setAttribute("aria-label", `Context window ${Math.round(used)}% full, approximately ${formatTokenCount(usedTokens)} of ${formatTokenCount(contextTokenLimit)} tokens used`); updateModelLoadingSpinner(); }

async function compactCurrentSession(): Promise<void> {
  if (!currentSession || currentRun) return;
  contextCompactButton.disabled = true; contextCompactStatus.hidden = false; contextCompactStatus.textContent = "Compacting…";
  try {
    const response = await api(`/api/v1/sessions/${currentSession}/compact`, "POST", { model: model.value || "default" });
    sessionTokenEstimate = Number(response.data?.estimatedContextTokens ?? sessionTokenEstimate); updateContextMeter(); appendContextActivity("Context compacted"); contextCompactStatus.textContent = `Reduced ${formatTokenCount(Number(response.data?.estimatedInputTokens ?? 0))} to ${formatTokenCount(sessionTokenEstimate)} tokens`;
  } catch (error) { contextCompactStatus.textContent = errorMessage(error); }
  finally { contextCompactButton.disabled = false; }
}

function beginSidebarResize(event: PointerEvent): void {
  event.preventDefault(); sidebarResizer.classList.add("dragging"); sidebarResizer.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => setSidebarWidth(moveEvent.clientX);
  const finish = () => { sidebarResizer.classList.remove("dragging"); sidebarResizer.removeEventListener("pointermove", move); localStorage.setItem("fitz-sidebar-width", String(sidebarWidth())); };
  sidebarResizer.addEventListener("pointermove", move); sidebarResizer.addEventListener("pointerup", finish, { once: true }); sidebarResizer.addEventListener("pointercancel", finish, { once: true });
}

function resizeSidebarWithKeyboard(event: KeyboardEvent): void { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setSidebarWidth(sidebarWidth() + (event.key === "ArrowRight" ? 12 : -12)); localStorage.setItem("fitz-sidebar-width", String(sidebarWidth())); }
function setSidebarWidth(value: number): void { shell.style.setProperty("--sidebar-width", `${Math.max(240, Math.min(520, value))}px`); sidebarResizer.setAttribute("aria-valuenow", String(Math.round(sidebarWidth()))); }
function sidebarWidth(): number { return Number.parseFloat(getComputedStyle(shell).getPropertyValue("--sidebar-width")) || 254; }
function restoreSidebarWidth(): void { const saved = Number(localStorage.getItem("fitz-sidebar-width")); if (Number.isFinite(saved) && saved > 0) setSidebarWidth(saved); }
function beginInspectorResize(event: PointerEvent): void {
  event.preventDefault(); inspectorResizer.classList.add("dragging"); inspectorResizer.setPointerCapture(event.pointerId);
  const move = (moveEvent: PointerEvent) => setInspectorWidth(workspace.getBoundingClientRect().right - moveEvent.clientX);
  const finish = () => { inspectorResizer.classList.remove("dragging"); inspectorResizer.removeEventListener("pointermove", move); localStorage.setItem("fitz-inspector-width", String(inspectorWidth())); };
  inspectorResizer.addEventListener("pointermove", move); inspectorResizer.addEventListener("pointerup", finish, { once: true }); inspectorResizer.addEventListener("pointercancel", finish, { once: true });
}
function resizeInspectorWithKeyboard(event: KeyboardEvent): void { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setInspectorWidth(inspectorWidth() + (event.key === "ArrowLeft" ? 12 : -12)); localStorage.setItem("fitz-inspector-width", String(inspectorWidth())); }
function setInspectorWidth(value: number): void { const maximum = Math.max(300, Math.min(760, workspace.getBoundingClientRect().width - 420)); workspace.style.setProperty("--inspector-width", `${Math.max(300, Math.min(maximum, value))}px`); inspectorResizer.setAttribute("aria-valuenow", String(Math.round(inspectorWidth()))); }
function inspectorWidth(): number { return Number.parseFloat(getComputedStyle(workspace).getPropertyValue("--inspector-width")) || 400; }
function restoreInspectorWidth(): void { const saved = Number(localStorage.getItem("fitz-inspector-width")); if (Number.isFinite(saved) && saved > 0) setInspectorWidth(saved); }
function setStatus(text: string, state: string): void { status.textContent = text; status.dataset.state = state; }
function setConnection(text: string, state: string): void { connectionDetail.textContent = text; connectionStatus.dataset.state = state; }
function setFormBusy(formElement: HTMLFormElement, busy: boolean): void { for (const control of formElement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy; }
function showToast(text: string): void { if (toastTimer) clearTimeout(toastTimer); toast.textContent = text; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 3_200); }
function panelEmpty(text: string): HTMLElement { const value = document.createElement("div"); value.className = "panel-empty"; value.textContent = text; return value; }
function inspectorEmpty(text: string): HTMLElement { const value = document.createElement("div"); value.className = "inspector-empty"; value.textContent = text; return value; }
function inspectorError(text: string): HTMLElement { const value = document.createElement("div"); value.className = "inspector-error"; value.textContent = text; return value; }
function loadingMessage(text: string): HTMLElement { const value = document.createElement("div"); value.className = "panel-empty"; value.textContent = text; return value; }
function treeItem(label: string, className: string, icon: SVGElement | undefined, action: () => void, menu: (toggle: HTMLButtonElement, event: MouseEvent) => void, quickAction?: () => void): HTMLElement {
  const item = document.createElement("div"); item.className = "tree-item";
  const value = document.createElement("button"); value.type = "button"; value.className = className; const text = document.createElement("span"); text.textContent = label; if (icon) value.append(icon); value.append(text); value.addEventListener("click", action);
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "tree-menu-toggle"; toggle.title = `${label} actions`; toggle.setAttribute("aria-label", `${label} actions`); toggle.setAttribute("aria-expanded", "false"); toggle.append(svg('<circle cx="5" cy="10" r="1"></circle><circle cx="10" cy="10" r="1"></circle><circle cx="15" cy="10" r="1"></circle>'));
  toggle.addEventListener("click", (event) => menu(toggle, event)); value.addEventListener("contextmenu", (event) => menu(toggle, event)); item.append(value);
  if (quickAction) { const quick = document.createElement("button"); quick.type = "button"; quick.className = "tree-quick-action"; quick.title = `New chat in ${label}`; quick.setAttribute("aria-label", `New chat in ${label}`); quick.append(svg('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path>', "0 0 24 24")); quick.addEventListener("click", (event) => { event.stopPropagation(); quickAction(); }); item.append(quick); }
  item.append(toggle); return item;
}

function storedSet(key: string): Set<string> { try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []); } catch { return new Set(); } }
function storedAccessMode(): AccessMode { const value = localStorage.getItem("fitz-access-mode"); return value === "ask" || value === "read-only" ? value : "full"; }
function saveSet(key: string, values: Set<string>): void { localStorage.setItem(key, JSON.stringify([...values])); }

async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const response = await window.fitz.request({ path, method, ...(body !== undefined ? { body } : {}) });
  let parsed: Json;
  try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
  if (response.status >= 400) throw new HttpError(parsed.error?.message ?? parsed.error ?? `Request failed (${response.status})`, response.status);
  return parsed;
}

function svg(path: string, viewBox = "0 0 20 20"): SVGElement { const value = document.createElementNS("http://www.w3.org/2000/svg", "svg"); value.setAttribute("viewBox", viewBox); value.setAttribute("aria-hidden", "true"); value.innerHTML = path; return value; }
function folderIcon(): SVGElement { return svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>', "0 0 24 24"); }
function sparkIcon(): SVGElement { return svg('<path d="M10 2.8c.5 3.7 2.4 5.8 6.2 7.2-3.8 1.4-5.7 3.5-6.2 7.2-.5-3.7-2.4-5.8-6.2-7.2C7.6 8.6 9.5 6.5 10 2.8Z"></path>'); }
function activityIcon(toolName: string): SVGElement {
  if (toolName === "edit" || toolName === "write") return svg('<path d="m4.2 14.8.7-3.2 7.8-7.8a1.45 1.45 0 0 1 2.05 2.05L7 13.65z"></path><path d="m11.7 4.8 2.05 2.05"></path>');
  if (["bash", "grep", "find", "ls", "read"].includes(toolName)) return svg('<rect x="2.8" y="3.2" width="14.4" height="13.6" rx="2.3"></rect><path d="m6 7 2.2 2L6 11M10.4 12h3.1"></path>');
  return svg('<path d="M10 2.8c.45 3.5 2.2 5.45 5.8 7.2-3.6 1.75-5.35 3.7-5.8 7.2-.45-3.5-2.2-5.45-5.8-7.2C7.8 8.25 9.55 6.3 10 2.8Z"></path>');
}
function contextActivityIcon(): SVGElement { return svg('<path d="M4 3.5h8l3 3v10H4z"></path><path d="M12 3.5v3h3M6.5 10h6M6.5 13h4"></path><path d="m2.5 12-1.2 1.2L2.5 14.4"></path>'); }
function terminalCloudIcon(): SVGElement { return svg('<path d="M6.2 16.4c-2 0-3.7-1.6-3.7-3.6 0-1.2.6-2.3 1.5-3-.4-1.8.5-3.6 2.1-4.4.7-1.7 2.4-2.8 4.2-2.8 1.5 0 2.9.7 3.8 1.9 1.8-.1 3.3 1.3 3.4 3.1 1 .7 1.7 1.9 1.7 3.2 0 1.5-.8 2.8-2.1 3.5-.5 1.8-2.1 3-4 3-.8 0-1.6-.2-2.2-.7-.7.6-1.6.9-2.5.9-.8 0-1.6-.3-2.2-.7z"></path><path d="m6.8 8 1.8 2-1.8 2M10.7 12.3h2.7"></path>'); }
function element(id: string): HTMLElement { const value = document.getElementById(id); if (!value) throw new Error(`Missing #${id}`); return value; }
function query(selector: string): HTMLElement { const value = document.querySelector<HTMLElement>(selector); if (!value) throw new Error(`Missing ${selector}`); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }
function base64Bytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }

function formatElapsed(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}
function estimateTokens(value: string): number { return value ? Math.max(1, Math.ceil(value.length / 4)) : 0; }
function estimateTranscriptContext(entries: Json[]): number {
  const checkpoint = [...entries].reverse().find((entry) => entry.kind === "compaction" && entry.content?.manual === true && typeof entry.content?.summary === "string" && Number.isFinite(Number(entry.content?.throughSequence)));
  const throughSequence = checkpoint ? Number(checkpoint.content.throughSequence) : -1; let total = checkpoint ? estimateTokens(`Conversation summary:\n${checkpoint.content.summary}`) : 0;
  for (const entry of entries) if (entry.kind === "message" && typeof entry.content?.text === "string" && Number(entry.sequence) > throughSequence) total += estimateTokens(entry.content.text);
  return total;
}
function formatTokenCount(value: number): string { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)); }
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
