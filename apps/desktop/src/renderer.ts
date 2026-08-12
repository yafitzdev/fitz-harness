import { isActiveMediaJobStatus } from "@fitz/protocol";
import { appendMarkdown } from "./markdown.js";
import { estimateTokens } from "./context-estimate.js";
import { MessageActions } from "./ui/chat/message-actions.js";
import { AssistantPerformance } from "./ui/chat/assistant-performance.js";
import { ActivityTimeline } from "./ui/chat/activity-timeline.js";
import { AgentRunController } from "./ui/chat/agent-run-controller.js";
import { RunRecoveryView } from "./ui/chat/run-recovery-view.js";
import { MediaJobFeed } from "./ui/chat/media-job-feed.js";
import { MediaJobTracker, type MediaJobSummary } from "./ui/chat/media-job-tracker.js";
import { Composer, type ComposerSubmission } from "./ui/chat/composer.js";
import { ConversationLanding } from "./ui/chat/conversation-landing.js";
import { ConversationMessageFeed } from "./ui/chat/conversation-message-feed.js";
import { ConversationTranscript } from "./ui/chat/conversation-transcript.js";
import { PromptSubmissionController } from "./ui/chat/prompt-submission.js";
import { MediaCreationForm } from "./ui/chat/media-creation-form.js";
import { ConnectionWorkspaceController, type FixedRouteId } from "./ui/connections/connection-workspace.js";
import { textRouteOptions, textRouteRecipe } from "./ui/routes/text-route-presentation.js";
import { InspectorPanel } from "./ui/inspector/inspector-panel.js";
import { AdaptiveWorkspace } from "./ui/layout/adaptive-workspace.js";
import { ConversationLayout } from "./ui/layout/conversation-layout.js";
import { ManagementPageLayout, managementRefreshIcon } from "./ui/layout/management-page.js";
import { WorkspacePageController } from "./ui/layout/workspace-pages.js";
import { canOpenManagementView, managementNavigationVisibility } from "./ui/navigation/navigation-policy.js";
import { NavigationHistoryController, type AppLocation } from "./ui/navigation/navigation-history.js";
import { ApplicationMenuController } from "./ui/navigation/application-menu.js";
import { CustomSelectController } from "./ui/primitives/custom-select.js";
import type { ActionStatusTone } from "./ui/primitives/action-status.js";
import { requiredElement as element, requiredQuery as query, svgIcon as svg, textBlock } from "./ui/primitives/dom.js";
import { ResizablePane } from "./ui/primitives/resizable-pane.js";
import { PluginsPageController } from "./ui/plugins/plugins-page.js";
import { ModelsPageController } from "./ui/models/models-page.js";
import { AdministrationPageController } from "./ui/administration/administration-page.js";
import { UsagePageController } from "./ui/usage/usage-page.js";
import { PlaybookWorkspaceController } from "./ui/playbooks/playbook-workspace.js";
import { ProjectsController } from "./ui/projects/projects.js";
import { ProjectSidebarController } from "./ui/sidebar/project-sidebar.js";
import { WorkQueueController } from "./ui/queue/work-queue.js";
import { ArtifactController } from "./ui/artifacts/artifact-controller.js";
import { assertHostContract, HostRequestError, parseHostError } from "./client-error.js";

type Json = Record<string, any>;

let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTokenEstimate = 0;
let contextTokenLimit = 131_072;
let configuredHostOrigin = "Fitz host";
let administrator = false;
let currentUserId: string | undefined;
let managementConfiguration: Json | undefined;
let newChatMode = false;
let newChatProjectDetached = false;
// The Inspector is contained to the chat it was opened in: switching chats
// (or projects, or starting a new chat) closes it and drops its tabs, and
// the artifact repository re-scopes to the session, so a chat never inherits
// another chat's files or previews.
let inspectorChatId: string | undefined;

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
const inspectorRenderToggle = element("inspector-render-toggle") as HTMLButtonElement;
const inspectorArtifacts = element("inspector-artifacts") as HTMLButtonElement;
const updateButton = element("update") as HTMLButtonElement;
const selectPopover = element("select-popover");
const sidebarResizer = element("sidebar-resizer");
const playbookPage = element("playbook-page");
const connectionsButton = element("manage-connections") as HTMLButtonElement;
const pluginsPage = element("plugins-page");
const pluginsButton = element("manage-plugins") as HTMLButtonElement;
const modelsPage = element("models-page");
const modelsButton = element("manage-models") as HTMLButtonElement;
const pairingPage = element("pairing-page");
const pairingForm = element("pairing-form") as HTMLFormElement;
const pairingCode = element("pairing-code") as HTMLInputElement;
const pairingDisplayName = element("pairing-display-name") as HTMLInputElement;
const pairingDeviceName = element("pairing-device-name") as HTMLInputElement;
const pairingDescription = element("pairing-description");
const pairingError = element("pairing-error");
const administrationPage = element("administration-page");
const administrationButton = element("manage-administration") as HTMLButtonElement;
const usagePage = element("usage-page");
const usageButton = element("manage-usage") as HTMLButtonElement;

// Every management tab is built from the same layout component: a header with
// tabs and actions plus one or more content columns, so switching between
// Connections, Playbooks, Plugins, and Administration never shifts the chrome.
const playbookLayout = new ManagementPageLayout(playbookPage, {
  actions: [{ id: "refresh-playbooks", icon: managementRefreshIcon, label: "Refresh engines" }],
});
playbookLayout.addContent({
  id: "management-browser",
  title: "Playbooks",
  titleId: "management-title",
  description: "Configure and test recipes from your engine folders.",
  descriptionId: "management-description",
  search: { id: "playbook-search", placeholder: "Search playbooks" },
  body: [element("playbook-list")],
  before: element("management-editor"),
});
const pluginsLayout = new ManagementPageLayout(pluginsPage, {
  tabs: [
    { id: "extension-tab", label: "Extensions", dataset: { type: "extension" }, active: true },
    { id: "skill-tab", label: "Skills", dataset: { type: "skill" } },
    { id: "prompt-tab", label: "Prompts", dataset: { type: "prompt" } },
  ],
  actions: [{ id: "refresh-plugins", icon: managementRefreshIcon, label: "Refresh packages" }],
});
pluginsLayout.addContent({
  id: "plugins-view",
  title: "Extensions",
  titleId: "plugins-title",
  description: "Extend Pi with packages from the community catalog.",
  search: { id: "plugin-search", placeholder: "Search plugins" },
  body: [element("plugins-installed-section"), element("plugins-skills-section"), element("plugins-discover-section")],
});
const modelsLayout = new ManagementPageLayout(modelsPage, {
  tabs: [
    { id: "llm-tab", label: "LLMs", dataset: { category: "llm" }, active: true },
    { id: "vision-tab", label: "Vision", dataset: { category: "vision" } },
  ],
  actions: [{ id: "refresh-models", icon: managementRefreshIcon, label: "Refresh models" }],
});
modelsLayout.addContent({
  id: "models-view",
  title: "LLMs",
  titleId: "models-title",
  description: "Browse text models and image or video generation models on Hugging Face.",
  search: { id: "model-search", placeholder: "Search models" },
  body: [element("models-downloaded-section"), element("models-discover-section")],
});
const administrationLayout = new ManagementPageLayout(administrationPage, {
  actions: [{ id: "refresh-administration", icon: managementRefreshIcon, label: "Refresh administration" }],
});
administrationLayout.addContent({
  title: "Administration",
  description: "Pair devices, manage users, and control their access.",
  body: [element("administration-sections")],
});
const usageLayout = new ManagementPageLayout(usagePage, {
  actions: [{ id: "refresh-usage", icon: managementRefreshIcon, label: "Refresh usage" }],
});
usageLayout.addContent({
  title: "Usage",
  description: "Requests, latency, tokens, and media activity across this host.",
  body: [element("usage-dashboard")],
});

let conversationLayout: ConversationLayout | undefined;
let adaptiveWorkspace: AdaptiveWorkspace | undefined;
const sidebarPane = new ResizablePane({
  divider: sidebarResizer, storageKey: "fitz-sidebar-width", defaultValue: 254, minimum: 240, maximum: 520,
  pointerValue: (event) => event.clientX,
  apply: (value) => shell.style.setProperty("--sidebar-width", `${value}px`),
});
const inspectorPanel = new InspectorPanel({
  mount: workspace,
  tabMount: workspaceHeader,
  getProjectRoot: () => String(projects?.activeProject()?.rootPath ?? ""),
  getSearchRoots: () => activityTimeline.searchRoots(),
  showStatus,
  renderToggle: inspectorRenderToggle,
  onLayoutChange: () => { adaptiveWorkspace?.sync(); conversationLayout?.sync(); },
});
const composer = new Composer({
  mount: workspace,
  getProjectRoot: () => String(projects?.activeProject()?.rootPath ?? "") || undefined,
  bridge: window.fitz,
  closeAllPopovers: closePopovers,
  onRouteChange: () => handleRouteChange(),
  onCompact: compactCurrentSession,
  onSubmit: (submission) => {
    // Media commands submit straight to the media-job pipeline, which runs on
    // its own queue, so they are allowed while the agent is busy. Everything
    // else steers or cancels the active run; with an empty draft and a media
    // job in flight the send button stops that job instead.
    if (agentRuns.active && !submission.mediaCommand) {
      if (submission.content.trim().length > 0) void steerPrompt(submission.content);
      else void agentRuns.cancel();
    } else if (mediaJobs.active && !submission.mediaCommand && submission.content.trim().length === 0) {
      void mediaJobs.cancelActive().catch((error) => showStatus(errorMessage(error), "error"));
    } else void sendPrompt(submission);
  },
  onInput: (text) => {
    updateContextMeter();
    refreshComposerState();
    agentRuns.scheduleWarmup(text, composer.controls.routeId);
  },
  onValueChange: () => { updateContextMeter(); refreshComposerState(); },
  onAttach: () => artifactController.choose(),
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
  onError: (message) => showStatus(message, "error"),
  isRunning: () => agentRuns.active,
});
conversationLayout = new ConversationLayout({ workspace, messages, composer: composer.root, scrollButton: composer.scrollButton, inspectorWidth: () => inspectorPanel.width() });
adaptiveWorkspace = new AdaptiveWorkspace({ shell, workspace, onLayoutChange: () => conversationLayout?.sync() });
const customSelects = new CustomSelectController(selectPopover, closePopovers);
const projectSidebar = new ProjectSidebarController({
  mount: element("projects"),
  pinnedMount: element("pinned"),
  pinnedSection: element("pinned-section"),
  chatsMount: element("chats"),
  closePopovers,
  selectProject: (projectId) => void projects.selectProject(projectId),
  selectSession: (sessionId, projectId) => void projects.selectSession(sessionId, true, projectId),
  newChat: openNewChatForProject,
  openProjectPath: (path) => void projects.openProjectPath(path),
  createWorktree: openProjectWorktreeSetup,
  archiveProjectChats: (projectId) => void projects.archiveProjectChats(projectId),
  removeProject: (projectId) => void projects.removeProject(projectId),
  renameSession: (sessionId, projectId, title) => void projects.renameSession(sessionId, projectId, title),
  renameProject: (projectId, name) => void projects.renameProject(projectId, name),
  createProject: (name, rootPath) => { void projects.createProject(name, rootPath).then((created) => { if (created && projects.currentProjectId) openNewChatForProject(projects.currentProjectId); }); },
  chooseFolder: () => window.fitz.chooseFolder(),
  onError: (error) => showStatus(errorMessage(error), "error"),
  archiveSession: (sessionId, projectId) => { projects.setCurrentProject(projectId); projects.setCurrentSession(sessionId); void projects.archiveCurrentTask(); },
  removeSession: (sessionId, projectId) => projects.removeSession(sessionId, projectId),
  copyValue: (value, message) => void copyValue(value, message),
  continueSession: (session, projectId) => void projects.continueInNewChat(session, projectId),
});
const projects = new ProjectsController({
  api,
  bridge: { openPath: (path) => window.fitz.openPath(path) },
  sidebar: {
    ensureExpanded: (projectId) => projectSidebar.ensureExpanded(projectId),
    hasExpandedProjects: () => projectSidebar.hasExpandedProjects(),
    removeProjectState: (projectId) => projectSidebar.removeProjectState(projectId),
  },
  showStatus,
  errorMessage,
  closePopovers,
  showConversationWorkspace,
  leaveNewChat: () => { newChatMode = false; workspace.classList.remove("new-chat-open"); composer.exitNewChat(); },
  renderTree,
  refreshComposerState,
  rememberLocation: (location) => navigationHistory.remember(location),
  onSessionSelected: async (sessionId) => {
    const isCurrent = () => projects.currentSessionId === sessionId;
    agentRuns.detach();
    assistantPerformance.reset();
    runRecovery.clear();
    mediaJobs.reset();
    mediaJobFeed.reset();
    if (sessionId !== inspectorChatId) { inspectorPanel.reset(); inspectorPanel.setChat(sessionId); inspectorChatId = sessionId; }
    composer.controls.resetContextStatus();
    const selectedSession = projects.currentSessionRecord();
    if (selectedSession?.routeId) composer.controls.setRoute(selectedSession.routeId);
    syncComposerContext();
    messages.replaceChildren(loadingMessage("Loading conversation…"));
    try {
      const transcript = await api(`/api/v1/sessions/${sessionId}/transcript`);
      if (!isCurrent()) return;
      sessionTokenEstimate = conversationTranscript.restore(transcript.data ?? [], transcript.page ?? {});
      const pendingApprovals = await api(`/api/v1/sessions/${sessionId}/tool-approvals?status=pending`);
      if (!isCurrent()) return;
      for (const approval of pendingApprovals.data ?? []) activityTimeline.appendApproval(approval);
      const runState = await api(`/api/v1/sessions/${sessionId}/agent-run-state`);
      if (!isCurrent()) return;
      if (runState.data?.status === "queued" || runState.data?.status === "running") {
        void agentRuns.attach(runState.data, conversationTranscript.eventSequenceForRun(String(runState.data.id)));
      } else if (runState.data?.resumable) runRecovery.show(runState.data);
      updateContextMeter();
      if (!messages.childElementCount) showLanding(true);
      messages.scrollTop = messages.scrollHeight;
      const sessionArtifacts = await artifactController.load();
      if (!isCurrent()) return;
      await loadMediaJobs(sessionId, sessionArtifacts, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      messages.replaceChildren();
      appendMessage("system", errorMessage(error));
    }
    if (!isCurrent()) return;
    refreshComposerState();
    composer.focus();
    navigationHistory.remember({ view: "conversation", ...(projects.currentProjectId ? { projectId: projects.currentProjectId } : {}), sessionId });
  },
  onNoSession: async () => {
    mediaJobs.reset();
    mediaJobFeed.reset();
    inspectorPanel.reset();
    inspectorPanel.setChat(undefined);
    inspectorChatId = undefined;
    sessionTokenEstimate = 0;
    updateContextMeter();
    if (projects.currentProjectId) openNewChatForProject(projects.currentProjectId);
    else showLanding();
    await artifactController.load();
  },
});
const activityTimeline = new ActivityTimeline({
  messages,
  projectRoot: () => projects.activeProject()?.rootPath ?? "",
  inspectResource: (reference) => inspectorPanel.inspect(reference),
  decideApproval: async (approvalId, decision, request) => {
    const response = await api(`/api/v1/tool-approvals/${approvalId}/decision`, "POST", { decision, ...(request ? { request } : {}) });
    return response.data?.status === "approved" ? "approved" : "denied";
  },
  showStatus,
});
const conversationTranscript = new ConversationTranscript({
  messages,
  activity: activityTimeline,
  appendMessage,
  appendCommentary,
  rebuildHistory: (history) => composer.rebuildHistory(history),
  loadEarlier: async (beforeSequence) => {
    const sessionId = projects.currentSessionId;
    if (!sessionId) return { data: [], page: { hasEarlier: false } };
    const response = await api(`/api/v1/sessions/${sessionId}/transcript?before=${beforeSequence}&limit=250`);
    return { data: Array.isArray(response.data) ? response.data : [], page: response.page ?? {} };
  },
});
const conversationLanding = new ConversationLanding({
  messages,
  clearActivity: () => activityTimeline.clear(),
  project: () => projects.projects.find((item) => item.id === projects.currentProjectId),
  projectDetached: () => newChatProjectDetached,
  setDraft: (value) => composer.setDraft(value),
  focusComposer: () => composer.focus(),
  createProject: () => projectSidebar.beginCreateProject(),
  retryConnection: () => initialize(),
  updateTitles,
});
const agentQueue = new WorkQueueController({
  list: element("request-queue"),
  count: element("queue-count"),
  api,
  showStatus,
  errorMessage,
});
const artifactController = new ArtifactController({
  list: element("artifacts"),
  fileInput: element("artifact-file") as HTMLInputElement,
  pickButton: element("add-artifact") as HTMLButtonElement,
  getSessionId: () => projects.currentSessionId,
  isNewChat: () => newChatMode,
  api,
  setSessionArtifacts: (items) => inspectorPanel.setSessionArtifacts(items),
  previewArtifact: (artifact, source, list) => inspectorPanel.previewArtifact(artifact, source, list),
  openInspector: () => inspectorPanel.open(),
  clearChips: () => composer.clearArtifactChips(),
  addChip: (name, detail, preview, remove) => composer.addArtifactChip(name, detail, preview, remove),
  stageFile: (file) => composer.attachFile(file),
  showStatus,
  errorMessage,
});
const mediaJobFeed = new MediaJobFeed({
  messages,
  appendWork: (row, createdAt) => activityTimeline.appendWork(row, createdAt),
  finishWork: (completedAt) => activityTimeline.finishWork(completedAt),
  appendAssistant: (text, createdAt) => conversationMessages.appendDetached("assistant", text, createdAt),
  openArtifact: (artifact) => inspectorPanel.previewArtifact(artifact),
  retry: async (job) => (await api(`/api/v1/media/jobs/${encodeURIComponent(job.id)}/retry`, "POST")).data as MediaJobSummary,
  editImage: async (job, prompt) => {
    const response = await api(`/api/v1/media/jobs/${encodeURIComponent(job.id)}/edits`, "POST", { prompt });
    return response.data as MediaJobSummary;
  },
  animateImage: async (job, prompt) => {
    const response = await api(`/api/v1/media/jobs/${encodeURIComponent(job.id)}/animations`, "POST", { prompt });
    return response.data as MediaJobSummary;
  },
  watch: (jobId) => mediaJobs.watch(jobId),
  showStatus,
  errorMessage,
});
const mediaJobs = new MediaJobTracker({
  api,
  onActiveChange: refreshComposerState,
  onProgress: (job) => mediaJobFeed.render(job),
  onTerminal: async (job, failure) => {
    if (job.sessionId && job.sessionId !== projects.currentSessionId) return;
    const artifactsForSession = job.status === "completed" ? await artifactController.load() : [];
    const artifact = job.artifactId ? artifactsForSession.find((item) => item.id === job.artifactId) : undefined;
    mediaJobFeed.render(job, failure, artifact);
    if (artifact) await inspectorPanel.previewArtifact(artifact);
  },
});
// Pre-submission media creation UI embedded in the chat: /image, /video, and
// /audio commands render this card so the user reviews prompt + parameters
// before the job is created.
const mediaCreationForm = new MediaCreationForm({ messages });
const agentRuns = new AgentRunController({
  messages,
  activity: activityTimeline,
  api,
  appendAssistant: (runId, createdAt) => appendMessage("assistant", "", createdAt, runId),
  appendAssistantDelta: (target, delta) => appendMarkdown(target, delta),
  appendSystem: (message) => { appendMessage("system", message); },
  appendChangeSummary: (files) => appendChangeSummary(files),
  addTokenEstimate: (text) => { sessionTokenEstimate += estimateTokens(text); updateContextMeter(); },
  recalibrateEstimate: (tokens) => { sessionTokenEstimate = tokens; updateContextMeter(); },
  setStatus,
  setEngineState: (state) => { engineState.textContent = state; },
  refreshControls: refreshComposerState,
  queueVisible: () => inspectorPanel.isOpen,
  refreshQueue: () => agentQueue.refresh(),
  showStatus,
  errorMessage,
  terminalReplayError: (error) => error instanceof HostRequestError,
  refreshAssistantPerformance: (runId) => assistantPerformance.refresh(runId),
  onMediaJobSubmitted: (jobId, toolName) => {
    const modality = toolName === "generate_image" ? "image" : toolName === "generate_audio" ? "audio" : "video";
    mediaJobFeed.render({ id: jobId, modality, status: "queued" });
    mediaJobs.watch(jobId);
  },
});
const runRecovery = new RunRecoveryView({
  messages,
  resume: (runId, confirmUnsafe) => agentRuns.resume(runId, confirmUnsafe),
});
const promptSubmission = new PromptSubmissionController({
  draft: () => composer.submission,
  consumeAttachments: () => composer.consumePastedAttachments(),
  sessionId: () => projects.currentSessionId,
  settings: () => ({
    routeId: composer.controls.routeId,
    maxTokens: composer.controls.maxTokens,
    temperature: composer.controls.temperature,
    accessMode: composer.controls.accessMode,
  }),
  ensureSession: ensurePromptSession,
  openNewChat,
  clearDraft: () => composer.clearDraft(),
  setDraft: (value) => composer.setDraft(value),
  resetWarmup: () => agentRuns.resetWarmup(),
  uploadAttachment: async (sessionId, attachment) => {
    const artifact = await artifactController.uploadData(sessionId, {
      name: attachment.kind === "image" ? `screenshot-${Date.now()}.png` : attachment.name,
      mimeType: attachment.mimeType,
      contentBase64: attachment.dataUrl.split(",")[1]!,
    });
    return artifact as { id: string };
  },
  clearLanding: () => { if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren(); },
  appendUser: (content) => { appendMessage("user", content); },
  persistUserMessage: async (sessionId, content, clientMessageId) => {
    await api(`/api/v1/sessions/${sessionId}/messages`, "POST", { text: content, clientMessageId });
  },
  appendSteer: (content) => activityTimeline.appendSteer(content),
  pushHistory: (content) => composer.pushHistory(content),
  addTokenEstimate: (content) => { sessionTokenEstimate += estimateTokens(content); },
  refreshContext: updateContextMeter,
  refreshControls: refreshComposerState,
  runId: () => agentRuns.runId,
  submitMedia: async ({ routeId, modality, operation, prompt, sessionId, size, seed, negativePrompt, durationSeconds, fps, refs }) => {
    const response = await api("/api/v1/media/jobs", "POST", {
      routeId,
      modality,
      params: {
        prompt,
        ...(operation !== undefined ? { operation } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(negativePrompt !== undefined ? { negativePrompt } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(fps !== undefined ? { fps } : {}),
        ...(refs && refs.length > 0 ? { refs } : {}),
      },
      sessionId,
    });
    return response.data as { id: string };
  },
  onMediaJobSubmitted: (jobId, modality) => {
    mediaJobFeed.render({ id: jobId, modality, status: "queued" });
    mediaJobs.watch(jobId);
  },
  showMediaCreation: ({ modality, prompt, refs, submit }) => {
    mediaCreationForm.show({ modality, prompt, refs, onCreate: submit });
  },
  startRun: (request) => agentRuns.start(request),
  steerRun: (content) => agentRuns.steer(content),
  showError: (message) => { appendMessage("system", message); },
  errorMessage,
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
  engineRuntimeId: element("engine-runtime-id") as HTMLInputElement,
  engineManagedFields: element("engine-managed-fields"),
  engineRuntimeField: element("engine-runtime-field"),
  engineBaseUrlField: element("engine-base-url-field"),
  engineRuntimeIdField: element("engine-runtime-id-field"),
  engineEditorTitle: element("engine-editor-title"),
  recipeForm: element("recipe-form") as HTMLFormElement,
  recipePlaybookId: element("recipe-playbook-id") as HTMLInputElement,
  recipeId: element("recipe-id") as HTMLInputElement,
  recipeDisplayName: element("recipe-display-name") as HTMLInputElement,
  recipeAdapter: element("recipe-adapter") as HTMLInputElement,
  recipeModelId: element("recipe-model-id") as HTMLInputElement,
  recipeContextTokens: element("recipe-context-tokens") as HTMLInputElement,
  recipeConfiguration: element("recipe-configuration"),
  recipeEditorTitle: element("recipe-editor-title"),
}, {
  api,
  reloadConfiguration: () => loadManagementConfiguration(true),
  showStatus,
  errorMessage,
});
const connectionWorkspace = new ConnectionWorkspaceController({
  mount: workspace,
  bridge: window.fitz,
  api,
  reloadConfiguration: () => loadManagementConfiguration(false),
  updateRouteConfiguration: applyManagementRoute,
  updateCloudRouteConfiguration: applyCloudRoute,
  testRecipe: (recipe, card, button) => playbookWorkspace.testRecipe(recipe, card, button),
  renderRecipeTestState: (recipeId, card, button) => playbookWorkspace.renderRecipeTestState(recipeId, card, button),
  closePopovers,
  showStatus,
  errorMessage,
});
const workspacePages = new WorkspacePageController({
  pages: {
    playbooks: playbookPage,
    connections: connectionWorkspace.root,
    plugins: pluginsPage,
    models: modelsPage,
    usage: usagePage,
    administration: administrationPage,
    pairing: pairingPage,
  },
  navigation: {
    playbooks: element("manage-playbooks"),
    connections: connectionsButton,
    plugins: pluginsButton,
    models: modelsButton,
    usage: usageButton,
    administration: administrationButton,
  },
  setConversationInert,
});
const pluginsPageController = new PluginsPageController({
  page: pluginsPage,
  api,
  openExternal: (url) => window.fitz.openExternal(url),
  showStatus,
  errorMessage,
});
const modelsPageController = new ModelsPageController({
  page: modelsPage,
  api,
  openExternal: (url) => window.fitz.openExternal(url),
  openPath: (path) => window.fitz.openPath(path),
  showStatus,
  errorMessage,
});
const messageActions = new MessageActions({
  canEdit: () => !agentRuns.active,
  onEditBlocked: () => showStatus("Wait for the current response before editing a message.", "error"),
  copyText: (text) => window.fitz.copyText(text),
  resend: (text, article) => sendPrompt(text, article),
});
const assistantPerformance = new AssistantPerformance({
  api,
  apply: (target, usage) => messageActions.setPerformance(target, usage),
});
const conversationMessages = new ConversationMessageFeed({
  messages,
  activity: activityTimeline,
  actions: messageActions,
  runActive: () => agentRuns.active,
  projectRoot: () => projects.activeProject()?.rootPath ?? "",
});
const administrationPageController = new AdministrationPageController({
  refresh: element("refresh-administration") as HTMLButtonElement,
  sections: administrationPage,
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
  adminTrash: element("admin-trash"),
  adminSnapshots: element("admin-snapshots"),
  adminToolActions: element("admin-tool-actions"),
  emptyTrashButton: element("empty-trash-button") as HTMLButtonElement,
  gcRetentionButton: element("gc-retention-button") as HTMLButtonElement,
  emptyTrashConfirmation: element("empty-trash-confirmation"),
  emptyTrashConfirmationText: element("empty-trash-confirmation-text"),
  cancelEmptyTrash: element("cancel-empty-trash") as HTMLButtonElement,
  confirmEmptyTrash: element("confirm-empty-trash") as HTMLButtonElement,
  diagnosticGeneratedAt: element("diagnostic-generated-at"),
  diagnosticSummary: element("diagnostic-summary"),
  diagnosticMetrics: element("diagnostic-metrics"),
  diagnosticFailures: element("diagnostic-failures"),
  diagnosticExportStatus: element("diagnostic-export-status"),
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
  storageSummary: element("storage-summary"),
  storageIssues: element("storage-issues"),
  storageBackups: element("storage-backups"),
  storageQuota: element("storage-quota") as HTMLInputElement,
  verifyStorage: element("verify-storage") as HTMLButtonElement,
  collectStorageGarbage: element("collect-storage-garbage") as HTMLButtonElement,
  createStorageBackup: element("create-storage-backup") as HTMLButtonElement,
  saveStorageQuota: element("save-storage-quota") as HTMLButtonElement,
  storageRestoreConfirmation: element("storage-restore-confirmation"),
  storageRestoreConfirmationText: element("storage-restore-confirmation-text"),
  cancelStorageRestore: element("cancel-storage-restore") as HTMLButtonElement,
  confirmStorageRestore: element("confirm-storage-restore") as HTMLButtonElement,
}, {
  api,
  bridge: window.fitz,
  isAdministrator: () => administrator,
  currentUserId: () => currentUserId,
  showStatus,
  errorMessage,
});
const usagePageController = new UsagePageController({
  root: element("usage-dashboard"),
  refresh: element("refresh-usage") as HTMLButtonElement,
  api,
  errorMessage,
});
const navigationHistory = new NavigationHistoryController({
  blocked: () => agentRuns.active,
  replay: replayLocation,
});
const appMenus = new ApplicationMenuController({
  popover: element("app-menu-popover"),
  toggles: [...document.querySelectorAll<HTMLButtonElement>("[data-app-menu]")],
  newChat: openNewChat,
  newProject: () => projectSidebar.beginCreateProject(),
  toggleSidebar,
  editCommand: (command) => window.fitz.editCommand(command),
  windowAction: (action) => window.fitz.windowAction(action),
  openExternal: (url) => window.fitz.openExternal(url),
  showStatus,
  errorMessage,
  closeOthers: () => {
    customSelects.close();
    composer.closePopovers();
    projectSidebar.hideMenu();
    projectSidebar.resetMenuToggles();
  },
});
void initialize();

window.fitz.onNavigationCommand((command) => void navigationHistory.navigate(command === "back" ? -1 : 1));
document.addEventListener("auxclick", (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  void navigationHistory.navigate(event.button === 3 ? -1 : 1);
});
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewChat(); }
  if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); if (shell.classList.contains("sidebar-collapsed")) toggleSidebar(); projectSidebar.beginRenameCurrentSession(); }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); void projects.archiveCurrentTask(); }
  if (event.key === "Escape") { if (playbookWorkspace.editorOpen) playbookWorkspace.closeEditor(); else if (connectionWorkspace.editorOpen) connectionWorkspace.closeEditor(); else closePopovers(); }
});

element("new-project").addEventListener("click", () => projectSidebar.beginCreateProject());
element("new-session").addEventListener("click", openNewChat);
element("new-standalone-chat").addEventListener("click", openNewChat);
element("manage-playbooks").addEventListener("click", () => void openPlaybookPage());
connectionsButton.addEventListener("click", () => void openConnectionsPage());
pluginsButton.addEventListener("click", () => void openPluginsPage());
modelsButton.addEventListener("click", () => void openModelsPage());
usageButton.addEventListener("click", () => void openUsagePage());
administrationButton.addEventListener("click", () => void openAdministrationPage());
element("sidebar-menu").addEventListener("click", toggleSidebar);
for (const windowButton of document.querySelectorAll<HTMLButtonElement>("[data-window-action]")) {
  windowButton.addEventListener("click", () => {
    void window.fitz.windowAction(windowButton.dataset.windowAction as "minimize" | "maximize" | "close")
      .catch((error) => showStatus(errorMessage(error), "error"));
  });
}
connectionStatus.addEventListener("click", () => void initialize());
inspectorArtifacts.addEventListener("click", () => inspectorPanel.toggle());
window.addEventListener("fitz:open-resource", (event) => {
  const reference = (event as CustomEvent<{ reference?: string }>).detail?.reference;
  if (reference) void inspectorPanel.inspect(reference);
});
window.addEventListener("fitz:resource-appeared", (event) => {
  const reference = (event as CustomEvent<{ reference?: string }>).detail?.reference;
  if (reference) inspectorPanel.registerReference(reference);
});
element("context-add").addEventListener("click", () => artifactController.choose());
pairingForm.addEventListener("submit", (event) => { event.preventDefault(); void pairDevice(); });
document.addEventListener("click", closePopovers);

async function initialize(): Promise<void> {
  try {
    setConnection("Connecting…", "loading");
    setStatus("Connecting", "loading");
    await connectionWorkspace.sync(false);
    const [health, connection, identity] = await Promise.all([api("/health"), window.fitz.connectionInfo(), api("/api/v1/me")]);
    assertHostContract(health);
    configuredHostOrigin = connection.origin; currentUserId = identity.data?.user?.id; administrator = identity.data?.authMode === "disabled" || identity.data?.user?.role === "administrator";
    applyNavigation();
    engineState.textContent = health.engine?.state ?? "UNLOADED";
    routeState.textContent = composer.controls.routeLabel;
    setConnection(configuredHostOrigin.replace(/^https?:\/\//, ""), "active");
    setStatus(health.engine?.state ?? "Ready", "idle");
    showConversationWorkspace();
    await projects.load();
    void loadManagementConfiguration(false);
  } catch (error) {
    if (error instanceof HostRequestError && error.status === 401) {
      const bootstrapped = await window.fitz.bootstrapLocalDevice().catch(() => false);
      if (bootstrapped) { await initialize(); return; }
      currentUserId = undefined; administrator = false; administrationButton.hidden = true; configuredHostOrigin = (await window.fitz.connectionInfo()).origin; setConnection("Pair device", "error"); setStatus("Pairing required", "error"); showPairingPage(`Enter a one-time code to connect to ${configuredHostOrigin}.`);
    }
    else { setConnection("Click to retry", "error"); setStatus("Offline", "error"); showConnectionFailure(errorMessage(error)); }
  } finally {
    refreshComposerState();
  }
}

// Connections and chat resolve labels through one shared role formatter. Cloud
// roles are owned by cloudRoutes, not the host-owned routes array.
function rebuildRouteLabels(preferredRoute?: string): void {
  const options = textRouteOptions(managementConfiguration);
  if (!options.length) return;
  composer.controls.setRoutes(options, preferredRoute);
  routeState.textContent = composer.controls.routeLabel;
  syncComposerContext();
}

function renderTree(): void {
  projectSidebar.render({ projects: projects.projects, sessionsByProject: projects.sessionsByProject, chats: projects.chats, currentProjectId: projects.currentProjectId, currentSessionId: projects.currentSessionId, newChat: newChatMode });
  updateTitles();
}

/** Starts a standalone chat with no project attached (top "new chat" icon, Ctrl+N, File > New chat). */
function openNewChat(): void { beginNewChat(false); }

/** Starts a new chat bound to the current project (per-project "+" quick action, project flows). */
function openProjectNewChat(): void { beginNewChat(true); }

function beginNewChat(projectBound: boolean): void {
  if (agentRuns.active) { showStatus("Stop the current response before starting a new chat", "error"); return; }
  showConversationWorkspace();
  inspectorPanel.reset();
  inspectorPanel.setChat(undefined);
  inspectorChatId = undefined;
  if (projectBound) {
    if (projects.projects.length === 0) { projectSidebar.beginCreateProject(); return; }
    projects.setCurrentProject(projects.currentProjectId ?? projects.projects[0]!.id);
    if (!projects.currentProjectId) return;
    projectSidebar.ensureExpanded(projects.currentProjectId);
  } else projects.setCurrentProject(undefined);
  projects.beginNewChat();
  newChatMode = true;
  newChatProjectDetached = false;
  sessionTokenEstimate = 0;
  composer.controls.resetContextStatus();
  workspace.classList.add("new-chat-open");
  connectionWorkspace.setConfiguration(managementConfiguration);
  composer.enterNewChat(projectBound ? projects.activeProject()?.name ?? "Project" : undefined);
  agentRuns.resetWarmup();
  renderTree();
  showNewChatLanding();
  void composer.refreshBranches();
  updateContextMeter();
  refreshComposerState();
  composer.focus();
  navigationHistory.remember({ view: "conversation", ...(projectBound && projects.currentProjectId ? { projectId: projects.currentProjectId } : {}), newChat: true });
}

function openNewChatForProject(id: string): void { projects.setCurrentProject(id); projectSidebar.ensureExpanded(id); openProjectNewChat(); }

function showNewChatLanding(): void {
  conversationLanding.showNewChat();
}

function openProjectWorktreeSetup(id: string): void { openNewChatForProject(id); composer.openWorktreeSetup(); }

async function copyValue(value: string, message: string): Promise<void> {
  try { await window.fitz.copyText(value); showStatus(message, "success"); }
  catch (error) { showStatus(errorMessage(error), "error"); }
}

async function openPlaybookPage(): Promise<void> {
  if (!canOpenManagementView("playbooks", administrator) || !pairingPage.hidden) { if (!pairingPage.hidden) pairingCode.focus(); return; }
  closePopovers();
  inspectorPanel.close();
  playbookWorkspace.closeEditor();
  workspacePages.show("playbooks");
  playbookWorkspace.showLoading();
  await loadManagementConfiguration(true);
  navigationHistory.remember({ view: "playbooks" });
}

async function openConnectionsPage(): Promise<void> { if (!pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); connectionWorkspace.closeEditor(); workspacePages.show("connections"); await connectionWorkspace.sync(false); navigationHistory.remember({ view: "connections" }); }
async function openPluginsPage(): Promise<void> { if (!canOpenManagementView("plugins", administrator) || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); connectionWorkspace.closeEditor(); workspacePages.show("plugins"); pluginsPageController.showLoading(); await pluginsPageController.load(false); navigationHistory.remember({ view: "plugins" }); }
async function openModelsPage(): Promise<void> { if (!canOpenManagementView("models", administrator) || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); connectionWorkspace.closeEditor(); workspacePages.show("models"); modelsPageController.showLoading(); await modelsPageController.load(false); navigationHistory.remember({ view: "models" }); }
async function openUsagePage(): Promise<void> { if (!canOpenManagementView("usage", administrator) || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); connectionWorkspace.closeEditor(); workspacePages.show("usage"); await usagePageController.load(); navigationHistory.remember({ view: "usage" }); }
async function openAdministrationPage(): Promise<void> { if (!canOpenManagementView("administration", administrator) || !pairingPage.hidden) return; closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); workspacePages.show("administration"); administrationPageController.showLoading(); await administrationPageController.load(); navigationHistory.remember({ view: "administration" }); }
function showPairingPage(message: string): void { closePopovers(); inspectorPanel.close(); playbookWorkspace.closeEditor(); workspacePages.show("pairing"); pairingDescription.textContent = message || "Enter a one-time code from your Fitz host."; pairingError.hidden = true; pairingError.textContent = ""; pairingCode.focus(); }
function showConversationWorkspace(): void { playbookWorkspace.closeEditor(); workspacePages.show("conversation"); }
function setConversationInert(inert: boolean): void { for (const area of [workspaceHeader, messages, composer.root]) { area.toggleAttribute("inert", inert); area.setAttribute("aria-hidden", String(inert)); } }

async function replayLocation(location: AppLocation): Promise<void> {
  if (location.view === "playbooks") await openPlaybookPage();
  else if (location.view === "connections") await openConnectionsPage();
  else if (location.view === "plugins") await openPluginsPage();
  else if (location.view === "models") await openModelsPage();
  else if (location.view === "usage") await openUsagePage();
  else if (location.view === "administration") await openAdministrationPage();
  else if (location.view === "conversation") {
    if (location.newChat && location.projectId) openNewChatForProject(location.projectId);
    else if (location.newChat) openNewChat();
    else if (location.sessionId) await projects.selectSession(location.sessionId, true, location.projectId);
    else if (location.projectId) await projects.selectProject(location.projectId);
  }
}

function applyNavigation(): void {
  const visibility = managementNavigationVisibility(administrator);
  element("manage-playbooks").hidden = !visibility.playbooks;
  connectionsButton.hidden = !visibility.connections;
  pluginsButton.hidden = !visibility.plugins;
  modelsButton.hidden = !visibility.models;
  usageButton.hidden = !visibility.usage;
  administrationButton.hidden = !visibility.administration;
}

async function pairDevice(): Promise<void> {
  setFormBusy(pairingForm, true); pairingError.hidden = true; pairingError.textContent = "";
  try {
    const response = await window.fitz.pairDevice({ code: pairingCode.value.trim(), displayName: pairingDisplayName.value.trim(), deviceName: pairingDeviceName.value.trim() }); let parsed: Json;
    try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
    if (response.status >= 400) throw parseHostError(parsed, response.status);
    pairingCode.value = ""; await initialize();
  } catch (error) { pairingError.textContent = errorMessage(error); pairingError.hidden = false; }
  finally { setFormBusy(pairingForm, false); }
}

async function loadManagementConfiguration(renderPage: boolean): Promise<Json | undefined> {
  try {
    managementConfiguration = await api(administrator ? "/api/v1/management/status" : "/api/v1/configuration");
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

function applyManagementRoute(routeId: string, route: Json | undefined): void {
  if (!managementConfiguration) return;
  const routes = (managementConfiguration.routes ?? []).filter((item: Json) => item.id !== routeId);
  if (route) routes.push(route);
  managementConfiguration = { ...managementConfiguration, routes };
  syncContextLimit();
  updateContextMeter();
  rebuildRouteLabels();
  playbookWorkspace.setConfiguration(managementConfiguration);
}

function applyCloudRoute(role: "smart" | "fast", recipeId: string | undefined): void {
  if (!managementConfiguration) return;
  managementConfiguration = {
    ...managementConfiguration,
    cloudRoutes: { ...(managementConfiguration.cloudRoutes ?? {}), [role]: recipeId },
  };
  rebuildRouteLabels();
  connectionWorkspace.setConfiguration(managementConfiguration);
}

function syncContextLimit(): void {
  const recipe = textRouteRecipe(managementConfiguration, composer.controls.routeId as FixedRouteId);
  const contextTokens = Number(recipe?.contextTokens);
  if (Number.isFinite(contextTokens) && contextTokens > 0) contextTokenLimit = contextTokens;
}

async function updateSessionBinding(): Promise<void> {
  const session = projects.currentSessionRecord();
  if (!session || !composer.controls.routeId) return;
  try {
    const response = await api(`/api/v1/sessions/${session.id}`, "PATCH", { routeId: composer.controls.routeId });
    Object.assign(session, response.data);
  } catch (error) { showStatus(errorMessage(error), "error"); }
}

function handleRouteChange(): void {
  routeState.textContent = composer.controls.routeLabel;
  agentRuns.resetWarmup();
  if (projects.currentSessionId) void updateSessionBinding();
  syncComposerContext();
}

function syncComposerContext(): void {
  syncContextLimit();
  updateContextMeter();
}

function closePopovers(): void { appMenus.close(); }

async function sendPrompt(submittedContent?: string | ComposerSubmission, existingUserMessage?: HTMLElement): Promise<void> {
  await promptSubmission.submit(submittedContent, existingUserMessage);
}

// While the agent is reasoning the composer stays unlocked. Sending inserts the
// message into the running conversation: the host forwards it to the active stream
// (Pi queues it as a steering message) and emits a `user.steer` event when it is
// delivered. We render the message here, inside the agent's work feed next to the
// tool calls and reasoning, so the user gets immediate feedback.
async function steerPrompt(content: string): Promise<void> {
  await promptSubmission.steer(content);
}

async function ensurePromptSession(title: string, routeId?: string): Promise<string | undefined> {
  if (projects.currentSessionId) return projects.currentSessionId;
  if (!newChatMode) return undefined;
  const payload = { title, ...(routeId ? { routeId: routeId as FixedRouteId } : {}) };
  const response = projects.currentProjectId
    ? await api(`/api/v1/projects/${projects.currentProjectId}/sessions`, "POST", payload)
    : await api("/api/v1/chats", "POST", payload);
  newChatMode = false;
  workspace.classList.remove("new-chat-open");
  composer.exitNewChat();
  if (projects.currentProjectId) projects.startSessionInProject(projects.currentProjectId, response.data);
  else projects.startChat(response.data);
  // Scope artifacts before the first run can stream files into the conversation.
  inspectorPanel.setChat(response.data.id);
  inspectorChatId = response.data.id;
  return response.data.id as string;
}

async function loadMediaJobs(sessionId: string, sessionArtifacts: Json[], isCurrent: () => boolean = () => true): Promise<void> {
  const response = await api(`/api/v1/media/jobs?sessionId=${encodeURIComponent(sessionId)}&limit=100&includeLineage=true`);
  if (!isCurrent()) return;
  const jobs = Array.isArray(response.data) ? [...response.data].reverse() as MediaJobSummary[] : [];
  let hasActiveJob = false;
  for (const job of jobs) {
    if (!isCurrent()) return;
    const artifact = job.artifactId ? sessionArtifacts.find((item) => item.id === job.artifactId) : undefined;
    if (isActiveMediaJobStatus(job.status)) {
      hasActiveJob = true;
      mediaJobFeed.render(job, undefined, artifact);
      mediaJobs.watch(job.id);
      continue;
    }
    const failure = job.status === "completed"
      ? undefined
      : await mediaJobs.failureMessage(job.id, job.errorCode ?? `Media generation ${job.status}`);
    if (!isCurrent()) return;
    mediaJobFeed.render(job, failure, artifact);
  }
  if (!isCurrent()) return;
  // Transcript replay owns the single reasoning summary. Terminal media jobs
  // render as detached peer results and must not manufacture one summary each.
  if (!hasActiveJob) activityTimeline.finishWork(undefined, "next-message");
  messages.scrollTop = messages.scrollHeight;
}

function scheduleQueueRefresh(): void {
  if (queueRefreshTimer) clearTimeout(queueRefreshTimer); queueRefreshTimer = undefined;
  if (!inspectorPanel.isOpen) return;
  void agentQueue.refresh().finally(() => { if (inspectorPanel.isOpen) queueRefreshTimer = setTimeout(scheduleQueueRefresh, 1_000); });
}

function showLanding(hasTask = false): void {
  conversationLanding.showHome(hasTask);
}

function showConnectionFailure(detail: string): void {
  conversationLanding.showConnectionFailure(detail);
}

function appendMessage(role: string, text: string, createdAt?: string, runId?: string): HTMLElement {
  const content = conversationMessages.append(role, text, createdAt);
  if (role === "assistant" && runId) assistantPerformance.track(content, runId, createdAt);
  return content;
}

function appendCommentary(text: string, createdAt?: string): HTMLElement {
  return conversationMessages.appendCommentary(text, createdAt);
}

function appendChangeSummary(files: Array<{ path: string; action: "edited" | "created" }>): void {
  conversationMessages.appendChangeSummary(files);
}

function refreshComposerState(): void {
  const ready = Boolean((projects.currentSessionId || newChatMode) && composer.controls.routeId);
  artifactController.setEnabled(Boolean(projects.currentSessionId));
  // The attach button also unlocks in a new chat so files can be staged for the first message.
  composer.setState({ ready, running: agentRuns.active, generating: mediaJobs.active, hasSession: Boolean(projects.currentSessionId || newChatMode) });
}

function updateTitles(): void {
  const project = projects.activeProject();
  projectTitle.textContent = project?.name ?? "Fitz Codex";
  taskTitle.textContent = "";
}

function toggleSidebar(): void { adaptiveWorkspace?.toggleSidebar(); closePopovers(); }
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
/** Action feedback is deliberately silent; operations render durable state in their own UI. */
function showStatus(_text: string, _tone: ActionStatusTone): void {}
function panelEmpty(text: string): HTMLElement { return textBlock("panel-empty", text); }
function loadingMessage(text: string): HTMLElement { return textBlock("panel-empty", text); }
async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const response = await window.fitz.request({ path, method, ...(body !== undefined ? { body } : {}) });
  let parsed: Json;
  try { parsed = JSON.parse(response.body) as Json; } catch { parsed = { error: response.body }; }
  if (response.status >= 400) throw parseHostError(parsed, response.status);
  return parsed;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function formatTokenCount(value: number): string { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)); }
