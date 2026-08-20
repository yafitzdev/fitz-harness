import { appendMarkdown, setMarkdown } from "./markdown.js";
import { estimateTokens } from "./context-estimate.js";
import { MessageActions } from "./ui/chat/message-actions.js";
import { AssistantPerformance } from "./ui/chat/assistant-performance.js";
import { ActivityTimeline } from "./ui/chat/activity-timeline.js";
import { AgentRunController } from "./ui/chat/agent-run-controller.js";
import { AgentPlanPanel } from "./ui/chat/agent-plan-panel.js";
import { RunRecoveryView } from "./ui/chat/run-recovery-view.js";
import { MediaJobFeed } from "./ui/chat/media-job-feed.js";
import { MediaJobTracker, type MediaJobSummary } from "./ui/chat/media-job-tracker.js";
import { Composer, type ComposerSubmission } from "./ui/chat/composer.js";
import { ConversationLanding } from "./ui/chat/conversation-landing.js";
import { ConversationMessageFeed, type MessageAttachment } from "./ui/chat/conversation-message-feed.js";
import { ConversationTranscript } from "./ui/chat/conversation-transcript.js";
import { findDurableUserArticle } from "./ui/chat/conversation-turn-dom.js";
import { ConversationContextController } from "./ui/chat/conversation-context.js";
import { ConversationSessionController } from "./ui/chat/conversation-session.js";
import { querySessionTranscript } from "./ui/chat/session-query-client.js";
import { PromptSubmissionController } from "./ui/chat/prompt-submission.js";
import { MediaCreationForm } from "./ui/chat/media-creation-form.js";
import { ConnectionWorkspaceController, type FixedRouteId } from "./ui/connections/connection-workspace.js";
import { textRouteOptions, textRouteRecipe } from "./ui/routes/text-route-presentation.js";
import { InspectorPanel } from "./ui/inspector/inspector-panel.js";
import { InAppBrowser } from "./ui/browser/in-app-browser.js";
import { AdaptiveWorkspace } from "./ui/layout/adaptive-workspace.js";
import { ConversationLayout } from "./ui/layout/conversation-layout.js";
import { ManagementPageLayout, managementRefreshIcon } from "./ui/layout/management-page.js";
import { WorkspacePageController } from "./ui/layout/workspace-pages.js";
import { AppNavigationController } from "./ui/navigation/app-navigation.js";
import { CustomSelectController } from "./ui/primitives/custom-select.js";
import { ActionStatusView, type ActionStatusTone } from "./ui/primitives/action-status.js";
import { requiredElement as element, requiredQuery as query, svgIcon as svg, textBlock } from "./ui/primitives/dom.js";
import { suppressNativeTooltips } from "./ui/primitives/native-tooltip-policy.js";
import { ResizablePane } from "./ui/primitives/resizable-pane.js";
import { OverlayHost } from "./ui/primitives/overlay-host.js";
import { PluginsPageController } from "./ui/plugins/plugins-page.js";
import { ModelsPageController } from "./ui/models/models-page.js";
import { AdministrationPageController } from "./ui/administration/administration-page.js";
import { createHostingPageClient, HostingPageController } from "./ui/administration/hosting-page-controller.js";
import { createUsagePageClient, UsagePageController } from "./ui/usage/usage-page.js";
import { PlaybookWorkspaceController } from "./ui/playbooks/playbook-workspace.js";
import { ProjectsController } from "./ui/projects/projects.js";
import { ProjectSidebarController } from "./ui/sidebar/project-sidebar.js";
import { SidebarActivityController } from "./ui/sidebar/sidebar-activity.js";
import { WorkQueueController } from "./ui/queue/work-queue.js";
import { ArtifactController } from "./ui/artifacts/artifact-controller.js";
import { assertHostContract, HostRequestError } from "./client-error.js";
import { HostApiClient } from "./host-api-client.js";
import { parseManagementConfiguration, parseManagementRoute, type ChatDefaults, type ManagementConfiguration } from "./management-configuration.js";
import type { EditedUserTurn, EditUserTurnRequest, RegenerateAssistantTurnRequest, RegeneratedAssistantTurn } from "@fitz/protocol";

type Json = Record<string, any>;
type ApiData<T> = { data: T };

suppressNativeTooltips();

let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let sidebarActivity: SidebarActivityController | undefined;
let currentUserId: string | undefined;
let managementConfiguration: ManagementConfiguration | undefined;
let initialNavigationPending = true;

const shell = query(".app-shell");
const workspaceHeader = query(".workspace-header");
const messages = element("messages");
const workspace = query(".workspace");
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
const overlayHost = new OverlayHost(document);
const actionStatus = new ActionStatusView(document);
const administrationPage = element("administration-page");
const administrationButton = element("manage-administration") as HTMLButtonElement;
const hostApi = new HostApiClient(window.fitz);
const api = (path: string, method = "GET", body?: unknown): Promise<Json> => hostApi.request<Json>(path, method, body);

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
  description: "Configure recipes from your engine folders.",
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
  tabs: [
    { id: "hosting-users-tab", label: "Users", active: true },
    { id: "hosting-usage-tab", label: "Usage" },
    { id: "hosting-advanced-tab", label: "Advanced" },
  ],
  actions: [{ id: "refresh-administration", icon: managementRefreshIcon, label: "Refresh administration" }],
});
administrationLayout.addContent({
  title: "Hosting",
  description: "Host your models, manage people, and understand how the service is used.",
  body: [element("administration-sections")],
});
let conversationLayout: ConversationLayout | undefined;
let adaptiveWorkspace: AdaptiveWorkspace | undefined;
let closeBrowserPreview = (): void => {};
let syncBrowserPreview = (): void => {};
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
  onLayoutChange: () => { adaptiveWorkspace?.sync(); conversationLayout?.sync(); syncBrowserPreview(); },
  onOpenChange: (open) => { if (!open) closeBrowserPreview(); },
  onContentViewChange: () => closeBrowserPreview(),
});
const inAppBrowser = new InAppBrowser({ mount: inspectorPanel.element, bridge: window.fitz, showStatus });
closeBrowserPreview = () => inAppBrowser.close();
syncBrowserPreview = () => inAppBrowser.syncBounds();
const composer = new Composer({
  mount: workspace,
  overlayHost,
  getProjectRoot: () => String(projects?.activeProject()?.rootPath ?? "") || undefined,
  bridge: window.fitz,
  closeAllPopovers: closePopovers,
  onRouteChange: () => handleRouteChange(),
  onEffortChange: () => { refreshAgentTopology(); conversationContext.refresh(); },
  onCompact: () => conversationContext.compact(),
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
    } else return sendPrompt(submission);
  },
  onInput: (text) => {
    conversationContext.refresh();
    refreshComposerState();
    agentRuns.scheduleWarmup(text, composer.controls.routeId);
  },
  onValueChange: () => { conversationContext.refresh(); refreshComposerState(); },
  onAttach: () => artifactController.choose(),
  onDismissProject: showNewChatLanding,
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
const agentPlanPanel = new AgentPlanPanel(composer.root);
const conversationContext = new ConversationContextController({
  draft: () => composer.value,
  estimateTokens,
  configuredLimit: () => {
    const topology = managementConfiguration?.agentTopologies?.[composer.controls.routeId];
    const resolved = Number(topology?.orchestratorContextTokens);
    if (Number.isFinite(resolved) && resolved > 0) return resolved;
    const recipe = textRouteRecipe(managementConfiguration, composer.controls.routeId as FixedRouteId);
    const value = Number(recipe?.contextTokens);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  },
  updateMeter: (tokens, limit) => composer.controls.updateContext(tokens, limit),
  currentSessionId: () => projects.currentSessionId,
  routeId: () => composer.controls.routeId,
  compact: async (sessionId, routeId) => (await api(`/api/v1/sessions/${sessionId}/compact`, "POST", { model: routeId })).data,
  refreshSessionEstimate: async (sessionId) => {
    const response = await querySessionTranscript(api, sessionId, { limit: 1 });
    const estimate = Number(response.page.estimatedContextTokens);
    return Number.isFinite(estimate) && estimate >= 0 ? estimate : undefined;
  },
  setStatus: (message, loading) => composer.controls.setContextStatus(message, loading),
  appendContext: (message) => activityTimeline.appendContext(message),
  refreshControls: refreshComposerState,
  errorMessage,
});
conversationLayout = new ConversationLayout({ workspace, messages, composer: composer.root, scrollButton: composer.scrollButton, inspectorWidth: () => inspectorPanel.width() });
adaptiveWorkspace = new AdaptiveWorkspace({ shell, workspace, onLayoutChange: () => conversationLayout?.sync() });
new CustomSelectController(overlayHost, selectPopover, closePopovers);
const projectSidebar = new ProjectSidebarController({
  mount: element("projects"),
  pinnedMount: element("pinned"),
  pinnedSection: element("pinned-section"),
  chatsMount: element("chats"),
  overlayHost,
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
  showConversationWorkspace: () => appNavigation.showConversation(),
  leaveNewChat: () => conversationSessions.leaveNewChat(),
  renderTree,
  refreshComposerState,
  rememberLocation: (location) => appNavigation.remember(location),
  onSessionSelected: (sessionId) => conversationSessions.selectSession(sessionId),
  onNoSession: () => conversationSessions.showNoSession(),
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
  registerGeneratedFile: (path, action) => inspectorPanel.registerGeneratedFile(path, action),
  appendMessage,
  appendCommentary,
  rebuildHistory: (history) => composer.rebuildHistory(history),
  resetPlan: () => agentPlanPanel.reset(),
  loadEarlier: async (beforeSequence) => {
    const sessionId = projects.currentSessionId;
    if (!sessionId) return { data: [], page: { hasEarlier: false } };
    return querySessionTranscript(api, sessionId, { before: beforeSequence, limit: 250 });
  },
});
const conversationLanding = new ConversationLanding({
  messages,
  clearActivity: () => activityTimeline.clear(),
  createProject: () => projectSidebar.beginCreateProject(),
  retryConnection: async () => { await window.fitz.retryLocalHost(); await initialize(); },
  updateTitles,
});
const agentQueue = new WorkQueueController({
  list: element("request-queue"),
  count: element("queue-count"),
  api,
  showStatus,
  errorMessage,
});
sidebarActivity = new SidebarActivityController({
  api,
  onChange: () => renderTree(),
});
const artifactController = new ArtifactController({
  list: element("artifacts"),
  fileInput: element("artifact-file") as HTMLInputElement,
  pickButton: element("add-artifact") as HTMLButtonElement,
  getSessionId: () => projects.currentSessionId,
  isNewChat: () => conversationSessions.newChat,
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
  subscribeAgentEvents: (input, listener) => window.fitz.subscribeAgentEvents(input, listener),
  appendAssistant: (runId, createdAt) => appendMessage("assistant", "", createdAt, runId),
  appendAssistantDelta: (target, delta) => appendMarkdown(target, delta),
  replaceAssistant: (target, text) => setMarkdown(target, text),
  loadFinalAssistant: async (runId) => {
    const sessionId = projects.currentSessionId;
    if (!sessionId) return undefined;
    const response = await querySessionTranscript(api, sessionId);
    const entry = [...response.data].reverse().find((candidate: Json) =>
      candidate.kind === "message" && candidate.role === "assistant"
      && candidate.content?.runId === runId && candidate.content?.phase === "final");
    const text = typeof entry?.content?.text === "string" ? entry.content.text : "";
    return text ? { text, ...(typeof entry?.createdAt === "string" ? { createdAt: entry.createdAt } : {}) } : undefined;
  },
  appendSystem: (message) => { appendMessage("system", message); },
  appendChangeSummary: (files) => appendChangeSummary(files),
  registerGeneratedFile: (path, action) => inspectorPanel.registerGeneratedFile(path, action),
  addTokenEstimate: (text) => { conversationContext.add(text); conversationContext.refresh(); },
  recalibrateEstimate: (tokens) => conversationContext.recalibrate(tokens),
  setStatus,
  setEngineState: (state) => { engineState.textContent = state; },
  refreshControls: refreshAgentRunState,
  queueVisible: () => inspectorPanel.isOpen,
  refreshQueue: () => agentQueue.refresh(),
  showStatus,
  errorMessage,
  terminalReplayError: (error) => error instanceof HostRequestError,
  updatePlan: (result) => { agentPlanPanel.updateFromToolResult(result); },
  clearPlan: () => agentPlanPanel.reset(),
  onRunSettled: async () => { await loadManagementConfiguration(false); },
  refreshAssistantPerformance: (runId) => assistantPerformance.refresh(runId),
  onMediaJobSubmitted: (jobId, toolName) => {
    const modality = toolName === "generate_image" ? "image" : toolName === "generate_audio" ? "audio" : "video";
    mediaJobFeed.render({ id: jobId, modality, status: "queued" });
    mediaJobs.watch(jobId);
  },
});
const runRecovery = new RunRecoveryView({
  messages,
  resume: (runId, confirmUnsafe, onAccepted) => agentRuns.resume(runId, confirmUnsafe, onAccepted),
});
const promptSubmission = new PromptSubmissionController({
  draft: () => composer.submission,
  peekAttachments: () => composer.peekPastedAttachments(),
  consumeAttachments: (attachments) => { composer.consumePastedAttachments(attachments); },
  sessionId: () => projects.currentSessionId,
  isSessionCurrent: (sessionId) => projects.currentSessionId === sessionId,
  settings: () => ({
    routeId: composer.controls.routeId,
    effort: composer.controls.effort,
    maxTokens: composer.controls.maxTokens,
    temperature: composer.controls.temperature,
    accessMode: composer.controls.accessMode,
  }),
  ensureSession: (title, routeId) => conversationSessions.ensurePromptSession(title, routeId),
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
    return artifact as { id: string; name: string; mimeType: string; kind: string; byteSize?: number };
  },
  discardUploadedAttachment: (sessionId, artifactId) => artifactController.discardUpload(sessionId, artifactId),
  clearLanding: () => { if (messages.querySelector(".landing, .new-chat-landing")) messages.replaceChildren(); },
  appendUser: (content, attachments) => { appendMessage("user", content, undefined, undefined, attachments); },
  persistUserMessage: async (sessionId, content, clientMessageId) => {
    await api(`/api/v1/sessions/${sessionId}/messages`, "POST", { text: content, clientMessageId });
  },
  appendSteer: (content) => activityTimeline.appendSteer(content),
  pushHistory: (content) => composer.pushHistory(content),
  addTokenEstimate: (content) => conversationContext.add(content),
  refreshContext: () => conversationContext.refresh(),
  refreshControls: refreshComposerState,
  runId: () => agentRuns.runId,
  submitMedia: async ({ routeId, clientRequestId, modality, operation, prompt, sessionId, size, seed, negativePrompt, lyrics, durationSeconds, fps, refs }) => {
    const response = await api("/api/v1/media/jobs", "POST", {
      routeId,
      clientRequestId,
      modality,
      params: {
        prompt,
        ...(operation !== undefined ? { operation } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(negativePrompt !== undefined ? { negativePrompt } : {}),
        ...(lyrics !== undefined ? { lyrics } : {}),
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
  startRun: (request, onAccepted) => agentRuns.start(request, onAccepted),
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
  recipeEditorEyebrow: element("recipe-editor-eyebrow"),
  recipeEditorDescription: element("recipe-editor-description"),
  recipeRename: element("recipe-rename") as HTMLButtonElement,
  recipeIdentityFields: element("recipe-identity-fields"),
}, {
  api,
  reloadConfiguration: () => loadManagementConfiguration(true),
  showStatus,
  errorMessage,
  onRouteChange: (path) => appNavigation.rememberRoute("playbooks", path),
});
const connectionWorkspace = new ConnectionWorkspaceController({
  mount: workspace,
  bridge: window.fitz,
  api,
  reloadConfiguration: () => loadManagementConfiguration(false),
  updateRouteConfiguration: applyManagementRoute,
  updateCloudRouteConfiguration: applyCloudRoute,
  closePopovers,
  showStatus,
  errorMessage,
  onRouteChange: (path) => appNavigation.rememberRoute("connections", path),
});
const workspacePages = new WorkspacePageController({
  pages: {
    playbooks: playbookPage,
    connections: connectionWorkspace.root,
    plugins: pluginsPage,
    models: modelsPage,
    administration: administrationPage,
  },
  navigation: {
    playbooks: element("manage-playbooks"),
    connections: connectionsButton,
    plugins: pluginsButton,
    models: modelsButton,
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
  resend: (text, article, originalText) => editUserMessage(text, article, originalText),
  regenerate: (article) => regenerateAssistantResponse(article),
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
  openAttachment: (attachment) => { void inspectorPanel.previewArtifact(attachment); },
  loadAttachmentPreview: async (attachment) => {
    if (!attachment.mimeType.startsWith("image/")) return undefined;
    const response = await window.fitz.request({ path: `/api/v1/artifacts/${encodeURIComponent(attachment.id)}/content`, responseType: "base64" });
    if (response.status < 200 || response.status >= 300) return undefined;
    return `data:${attachment.mimeType};base64,${response.body}`;
  },
});
const administrationPageController = new AdministrationPageController({
  sections: administrationPage,
  createUserForm: element("create-user-form") as HTMLFormElement,
  createUserName: element("create-user-name") as HTMLInputElement,
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
  isAdministrator: () => true,
  currentUserId: () => currentUserId,
  showStatus,
  errorMessage,
});
const hostingPageController = new HostingPageController({
  enabled: element("hosting-enabled") as HTMLInputElement,
  stateLabel: document.getElementById("hosting-state-label") ?? undefined,
  stateMessage: document.getElementById("hosting-state-message") ?? undefined,
  copyUrl: element("copy-hosting-url") as HTMLButtonElement,
  repair: element("repair-hosting") as HTMLButtonElement,
  advancedStatus: element("hosting-advanced-status"),
  startAtLogin: element("hosting-start-at-login") as HTMLInputElement,
  configPath: element("hosting-config-path"),
  copyConfigPath: element("copy-config-path") as HTMLButtonElement,
  configJson: element("hosting-config-json") as HTMLTextAreaElement,
  reloadConfig: element("reload-hosting-config") as HTMLButtonElement,
  validateConfig: element("validate-hosting-config") as HTMLButtonElement,
  saveConfig: element("save-hosting-config") as HTMLButtonElement,
  configStatus: element("hosting-config-status"),
}, {
  api: createHostingPageClient(api),
  copyText: (value) => window.fitz.copyText(value),
  showStatus: (message, tone = "neutral") => showStatus(message, tone),
  errorMessage,
  onConfiguration: (configuration) => applyChatDefaults(configuration?.defaults),
});
const usagePageController = new UsagePageController({
  root: element("usage-dashboard"),
  api: createUsagePageClient(api),
  errorMessage,
});
const hostingPanels: Record<string, HTMLElement> = {
  "hosting-users-tab": element("hosting-users-panel"),
  "hosting-usage-tab": element("hosting-usage-panel"),
  "hosting-advanced-tab": element("hosting-advanced-panel"),
};
let activeHostingTab = "hosting-users-tab";
administrationLayout.onTabSelect((id) => {
  activeHostingTab = id;
  for (const [panelId, panel] of Object.entries(hostingPanels)) panel.hidden = panelId !== id;
  if (id === "hosting-usage-tab") void usagePageController.load();
  if (id === "hosting-advanced-tab") void Promise.all([administrationPageController.loadAdvanced(), hostingPageController.load()]);
});
element("refresh-administration").addEventListener("click", () => {
  if (activeHostingTab === "hosting-users-tab") void administrationPageController.loadUsers();
  else if (activeHostingTab === "hosting-usage-tab") void usagePageController.load();
  else void Promise.all([administrationPageController.loadAdvanced(), hostingPageController.load()]);
});
const conversationSessions = new ConversationSessionController({
  api,
  projects: {
    get currentSessionId() { return projects.currentSessionId; },
    get currentProjectId() { return projects.currentProjectId; },
    get projects() { return projects.projects; },
    activeProject: () => projects.activeProject(),
    currentSessionRecord: () => {
      const session = projects.currentSessionRecord();
      return session && typeof session.routeId === "string" ? { routeId: session.routeId } : undefined;
    },
    setCurrentProject: (id) => projects.setCurrentProject(id),
    beginNewChat: () => projects.beginNewChat(),
    startSessionInProject: (projectId, session) => projects.startSessionInProject(projectId, session as Parameters<typeof projects.startSessionInProject>[1]),
    startChat: (session) => projects.startChat(session as Parameters<typeof projects.startChat>[0]),
  },
  sidebar: {
    ensureExpanded: (projectId) => projectSidebar.ensureExpanded(projectId),
    beginCreateProject: () => projectSidebar.beginCreateProject(),
  },
  workspace,
  messages,
  composer: {
    resetContextStatus: () => composer.controls.resetContextStatus(),
    resetForNewChat: () => composer.controls.resetForNewChat(),
    setRoute: (routeId) => composer.controls.setRoute(routeId),
    enterNewChat: (projectName) => composer.enterNewChat(projectName),
    exitNewChat: () => composer.exitNewChat(),
    refreshBranches: () => composer.refreshBranches(),
    focus: () => composer.focus(),
  },
  inspector: { reset: () => inspectorPanel.reset(), setChat: (id) => inspectorPanel.setChat(id) },
  context: {
    reset: () => conversationContext.reset(),
    restore: (tokens) => conversationContext.restore(tokens),
    refresh: () => conversationContext.refresh(),
  },
  transcript: {
    restore: (entries, page) => conversationTranscript.restore(entries, page),
    eventSequenceForRun: (runId) => conversationTranscript.eventSequenceForRun(runId),
  },
  runs: {
    active: () => agentRuns.active,
    detach: () => agentRuns.detach(),
    attach: (state, afterSequence) => { void agentRuns.attach(state as Parameters<typeof agentRuns.attach>[0], afterSequence); },
  },
  recovery: { clear: () => runRecovery.clear(), show: (state) => runRecovery.show(state as Parameters<typeof runRecovery.show>[0]) },
  assistantPerformance: { reset: () => assistantPerformance.reset() },
  plan: {
    reset: () => agentPlanPanel.reset(),
    update: (plan) => agentPlanPanel.update(plan as Parameters<AgentPlanPanel["update"]>[0]),
  },
  mediaJobs: {
    reset: () => mediaJobs.reset(),
    watch: (jobId) => mediaJobs.watch(jobId),
    failureMessage: (jobId, fallback) => mediaJobs.failureMessage(jobId, fallback),
  },
  mediaFeed: { reset: () => mediaJobFeed.reset(), render: (job, failure, artifact) => mediaJobFeed.render(job, failure, artifact) },
  activity: {
    appendApproval: (approval) => activityTimeline.appendApproval(approval),
    finishWork: (completedAt, placement) => activityTimeline.finishWork(completedAt, placement),
  },
  artifacts: { load: () => artifactController.load() },
  showConversation: () => appNavigation.showConversation(),
  showStatus: (message, tone) => showStatus(message, tone),
  errorMessage,
  renderTree,
  showNewChatLanding,
  showLanding,
  prepareNewChat: () => connectionWorkspace.setConfiguration(managementConfiguration),
  refreshControls: refreshComposerState,
  resetWarmup: () => agentRuns.resetWarmup(),
  remember: (location) => appNavigation.remember(location),
  loadingMessage,
  appendSystem: (message) => { appendMessage("system", message); },
});
const appNavigation = new AppNavigationController({
  blocked: () => agentRuns.active,
  closePopovers,
  closeInspector: () => { inAppBrowser.close(); inspectorPanel.close(); },
  closeEditors: () => {
    playbookWorkspace.closeEditor(false);
    connectionWorkspace.closeEditor(false);
  },
  pages: workspacePages,
  navigation: {
    playbooks: element("manage-playbooks"),
    connections: connectionsButton,
    plugins: pluginsButton,
    models: modelsButton,
    administration: administrationButton,
  },
  management: {
    playbooks: {
      load: async () => { playbookWorkspace.showLoading(); await loadManagementConfiguration(true); },
      openRoute: (path) => playbookWorkspace.openRoute(path),
    },
    connections: {
      load: async () => { await loadManagementConfiguration(false); await connectionWorkspace.sync(false); },
      openRoute: (path) => connectionWorkspace.openRoute(path),
    },
    plugins: {
      load: async () => { pluginsPageController.showLoading(); await pluginsPageController.load(false); },
    },
    models: {
      load: async () => { modelsPageController.showLoading(); await modelsPageController.load(false); },
    },
    administration: {
      load: async () => { administrationPageController.showLoading(); await administrationPageController.loadUsers(); },
    },
  },
  replayConversation: async (location) => {
    const [kind, id] = location.path ?? [];
    const projectId = typeof location.context?.projectId === "string" ? location.context.projectId : undefined;
    if (kind === "new" && projectId) openNewChatForProject(projectId);
    else if (kind === "new") openNewChat();
    else if (kind === "session" && id) await projects.selectSession(id, true, projectId);
    else if (kind === "project" && id) await projects.selectProject(id);
  },
});
appNavigation.applyAvailability();
appNavigation.showConversation();
void initialize();
window.fitz.onHostReady(() => void initialize());

window.fitz.onNavigationCommand((command) => void appNavigation.navigate(command === "back" ? -1 : 1));
document.addEventListener("auxclick", (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  if (inAppBrowser.visible) void window.fitz.browserAction(event.button === 3 ? "back" : "forward");
  else void appNavigation.navigate(event.button === 3 ? -1 : 1);
});
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "n") { event.preventDefault(); openNewChat(); }
  if (event.ctrlKey && event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); if (shell.classList.contains("sidebar-collapsed")) toggleSidebar(); projectSidebar.beginRenameCurrentSession(); }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); void projects.archiveCurrentTask(); }
  if (event.key === "Escape") { if (inAppBrowser.visible) inAppBrowser.close(); else if (playbookWorkspace.editorOpen) playbookWorkspace.closeEditor(); else if (connectionWorkspace.editorOpen) connectionWorkspace.closeEditor(); else closePopovers(); }
});

element("new-project").addEventListener("click", () => projectSidebar.beginCreateProject());
element("new-session").addEventListener("click", openNewChat);
element("new-standalone-chat").addEventListener("click", openNewChat);
element("manage-playbooks").addEventListener("click", () => void appNavigation.openManagement("playbooks"));
connectionsButton.addEventListener("click", () => void appNavigation.openManagement("connections"));
pluginsButton.addEventListener("click", () => void appNavigation.openManagement("plugins"));
modelsButton.addEventListener("click", () => void appNavigation.openManagement("models"));
administrationButton.addEventListener("click", () => void appNavigation.openManagement("administration"));
element("sidebar-menu").addEventListener("click", toggleSidebar);
element("navigate-back").addEventListener("click", () => void appNavigation.navigate(-1));
element("navigate-forward").addEventListener("click", () => void appNavigation.navigate(1));
for (const windowButton of document.querySelectorAll<HTMLButtonElement>("[data-window-action]")) {
  windowButton.addEventListener("click", () => {
    void window.fitz.windowAction(windowButton.dataset.windowAction as "minimize" | "maximize" | "close")
      .catch((error) => showStatus(errorMessage(error), "error"));
  });
}
inspectorArtifacts.addEventListener("click", () => inspectorPanel.toggle());
window.addEventListener("fitz:open-resource", (event) => {
  const reference = (event as CustomEvent<{ reference?: string }>).detail?.reference;
  if (!reference) return;
  if (/^https?:\/\//i.test(reference)) { inspectorPanel.open(); void inAppBrowser.open(reference); }
  else void inspectorPanel.inspect(reference);
});
element("context-add").addEventListener("click", () => artifactController.choose());
document.addEventListener("click", closePopovers);

let initialization: Promise<void> | undefined;
let initialized = false;
async function initialize(): Promise<void> {
  if (initialized) return;
  if (initialization) return initialization;
  const attempt = initializeLocalWorkspace();
  initialization = attempt;
  void attempt.finally(() => { if (initialization === attempt) initialization = undefined; });
  return attempt;
}

async function initializeLocalWorkspace(): Promise<void> {
  try {
    setStatus("Starting local services", "loading");
    const health = await api("/health");
    assertHostContract(health);
    const identity = await api("/api/v1/me");
    await connectionWorkspace.sync(false);
    currentUserId = identity.data?.user?.id;
    engineState.textContent = health.engine?.state ?? "UNLOADED";
    routeState.textContent = composer.controls.routeLabel;
    setStatus(health.engine?.state ?? "Ready", "idle");
    await projects.load(undefined, undefined, !initialNavigationPending);
    sidebarActivity?.start();
    if (initialNavigationPending) {
      initialNavigationPending = false;
      openNewChat();
    }
    await loadManagementConfiguration(false);
    // The hosting switch now lives in the sidebar, so refresh its state on boot.
    void hostingPageController.load();
    initialized = true;
  } catch (error) {
    console.warn("Local Fitz services are not ready yet", error);
    engineState.textContent = "STARTING";
    setStatus("Starting local services", "loading");
    void window.fitz.retryLocalHost().catch(() => false);
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
  refreshAgentTopology();
  conversationContext.refresh();
}

function refreshAgentTopology(): void {
  composer.controls.setAgentTopology(managementConfiguration?.agentTopologies?.[composer.controls.routeId]);
}

function renderTree(): void {
  const processingSessionIds = new Set(sidebarActivity?.processingSessionIds ?? []);
  // Keep the just-admitted selected run visible before the next durable queue
  // poll observes it. The queue remains the source of truth once a run is
  // detached or the user navigates to another chat.
  if (agentRuns.active && agentRuns.activeSessionId) processingSessionIds.add(agentRuns.activeSessionId);
  projectSidebar.render({ projects: projects.projects, sessionsByProject: projects.sessionsByProject, chats: projects.chats, currentProjectId: projects.currentProjectId, currentSessionId: projects.currentSessionId, processingSessionIds, newChat: conversationSessions.newChat });
  updateTitles();
}

/** Starts a standalone chat with no project attached (top "new chat" icon, Ctrl+N, File > New chat). */
function openNewChat(): void { conversationSessions.beginNewChat(false); }

function openNewChatForProject(id: string): void { conversationSessions.openNewChatForProject(id); }

function showNewChatLanding(): void {
  conversationLanding.showNewChat();
}

function openProjectWorktreeSetup(id: string): void { openNewChatForProject(id); composer.openWorktreeSetup(); }

async function copyValue(value: string, message: string): Promise<void> {
  try { await window.fitz.copyText(value); showStatus(message, "success"); }
  catch (error) { showStatus(errorMessage(error), "error"); }
}

function setConversationInert(inert: boolean): void {
  if (inert) {
    composer.closePopovers();
    agentPlanPanel.reset();
  }
  composer.root.hidden = inert;
  for (const area of [workspaceHeader, messages, composer.root]) {
    area.toggleAttribute("inert", inert);
    area.setAttribute("aria-hidden", String(inert));
  }
}

async function loadManagementConfiguration(renderPage: boolean): Promise<ManagementConfiguration | undefined> {
  try {
    const firstConfiguration = !managementConfiguration;
    managementConfiguration = parseManagementConfiguration(await hostApi.request<unknown>("/api/v1/management/status"));
    applyChatDefaults(managementConfiguration.chatDefaults);
    conversationContext.refresh();
    connectionWorkspace.setConfiguration(managementConfiguration);
    rebuildRouteLabels();
    if (firstConfiguration && conversationSessions.newChat) composer.controls.resetForNewChat();
    playbookWorkspace.setConfiguration(managementConfiguration);
    if (renderPage) playbookWorkspace.render();
  } catch (error) {
    if (renderPage) playbookWorkspace.showUnavailable(errorMessage(error));
  }
  return managementConfiguration;
}

function applyChatDefaults(defaults: ChatDefaults | undefined): void {
  const route = typeof defaults?.route === "string" ? defaults.route : "default";
  const effort = defaults?.effort === "light" || defaults?.effort === "high" ? defaults.effort : "normal";
  composer.controls.setDefaults(route, effort);
}

function applyManagementRoute(routeId: string, route: Json | undefined): void {
  if (!managementConfiguration) return;
  const routes = (managementConfiguration.routes ?? []).filter((item: Json) => item.id !== routeId);
  if (route) routes.push(parseManagementRoute(route));
  managementConfiguration = { ...managementConfiguration, routes };
  conversationContext.refresh();
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
  refreshAgentTopology();
  agentRuns.resetWarmup();
  if (projects.currentSessionId) void updateSessionBinding();
  conversationContext.refresh();
}

function closePopovers(): void {
  overlayHost.closeAll();
  composer.closePopovers();
  projectSidebar.resetMenuToggles();
}

async function sendPrompt(submittedContent?: string | ComposerSubmission, existingUserMessage?: HTMLElement, persistedMessageId?: string): Promise<void> {
  await promptSubmission.submit(submittedContent, existingUserMessage, persistedMessageId);
}

// While the agent is reasoning the composer stays unlocked. Sending inserts the
// message into the running conversation: the host forwards it to the active stream
// (Pi queues it as a steering message) and emits a `user.steer` event when it is
// delivered. We render the message here, inside the agent's work feed next to the
// tool calls and reasoning, so the user gets immediate feedback.
async function steerPrompt(content: string): Promise<void> {
  await promptSubmission.steer(content);
}

function scheduleQueueRefresh(): void {
  if (queueRefreshTimer) clearTimeout(queueRefreshTimer); queueRefreshTimer = undefined;
  if (!inspectorPanel.isOpen) return;
  void agentQueue.refresh().finally(() => { if (inspectorPanel.isOpen) queueRefreshTimer = setTimeout(scheduleQueueRefresh, 1_000); });
}

function showLanding(hasTask = false): void {
  conversationLanding.showHome(hasTask);
}

function appendMessage(role: string, text: string, createdAt?: string, runId?: string, attachments: readonly MessageAttachment[] = [], metadata?: { id?: string; sequence?: number }): HTMLElement {
  const content = conversationMessages.append(role, text, createdAt, attachments, metadata);
  if (role === "assistant" && runId) {
    const article = content.closest<HTMLElement>("article.message");
    if (article) article.dataset.runId = runId;
    assistantPerformance.track(content, runId, createdAt);
  }
  return content;
}

async function regenerateAssistantResponse(article: HTMLElement): Promise<void> {
  if (agentRuns.active) { showStatus("Wait for the current response before regenerating.", "error"); return; }
  const mediaJobId = article.dataset.mediaRegenerateJobId;
  if (mediaJobId) { await mediaJobFeed.regenerate(mediaJobId); return; }
  const sessionId = projects.currentSessionId;
  const runId = article.dataset.runId;
  if (!sessionId || !runId) { showStatus("This response cannot be regenerated.", "error"); return; }
  let userArticle: HTMLElement | null = article.previousElementSibling as HTMLElement | null;
  while (userArticle && !userArticle.matches("article.message.user")) userArticle = userArticle.previousElementSibling as HTMLElement | null;
  if (!userArticle) { showStatus("Load the original prompt before regenerating this response.", "error"); return; }
  try {
    const request = { runId } satisfies RegenerateAssistantTurnRequest;
    const response = await hostApi.request<ApiData<RegeneratedAssistantTurn>>(`/api/v1/sessions/${sessionId}/regenerate`, "POST", request);
    if (projects.currentSessionId !== sessionId) return;
    const prompt = response.data.prompt.trim();
    if (!prompt) throw new Error("The original prompt is unavailable");
    const promptSequence = Number(response.data.sequence);
    if (!Number.isSafeInteger(promptSequence) || promptSequence < 1 || promptSequence >= Number.MAX_SAFE_INTEGER) throw new Error("The regenerated transcript position is unavailable");
    const retainedContextTokens = Number(response.data.estimatedContextTokens);
    if (!Number.isFinite(retainedContextTokens) || retainedContextTokens < 0) throw new Error("The regenerated context estimate is unavailable");
    userArticle = findDurableUserArticle(messages, article, runId, {
      messageId: response.data.messageId,
      sequence: promptSequence,
      prompt,
    }) ?? userArticle;
    userArticle.dataset.transcriptId = response.data.messageId;
    userArticle.dataset.transcriptSequence = String(promptSequence);
    let next = userArticle.nextElementSibling;
    while (next) { const remove = next; next = next.nextElementSibling; remove.remove(); }
    conversationTranscript.truncateFrom(promptSequence + 1);
    activityTimeline.clear();
    agentPlanPanel.reset();
    conversationContext.recalibrate(retainedContextTokens);
    await sendPrompt(prompt, userArticle, response.data.messageId);
  } catch (error) { showStatus(errorMessage(error), "error"); }
}

async function editUserMessage(text: string, article: HTMLElement, originalText: string): Promise<void> {
  try {
    if (agentRuns.active) throw new Error("Wait for the current response before editing a message.");
    const sessionId = projects.currentSessionId;
    if (!sessionId) throw new Error("This message is not attached to a session.");
    const request: EditUserTurnRequest = {
      text,
      originalText,
      ...(article.dataset.transcriptId ? { messageId: article.dataset.transcriptId } : {}),
      ...(article.dataset.transcriptSequence ? { sequence: Number(article.dataset.transcriptSequence) } : {}),
    };
    const response = await hostApi.request<ApiData<EditedUserTurn>>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/edit`, "POST", request);
    if (projects.currentSessionId !== sessionId) return;
    const editSequence = Number(response.data.sequence);
    if (!Number.isSafeInteger(editSequence) || editSequence < 0) throw new Error("The edited transcript position is unavailable");
    const retainedContextTokens = Number(response.data.estimatedContextTokens);
    if (!Number.isFinite(retainedContextTokens) || retainedContextTokens < 0) throw new Error("The edited context estimate is unavailable");
    article.dataset.transcriptId = response.data.messageId;
    article.dataset.transcriptSequence = String(editSequence);
    let next = article.nextElementSibling;
    while (next) { const remove = next; next = next.nextElementSibling; remove.remove(); }
    conversationTranscript.truncateFrom(editSequence);
    activityTimeline.clear();
    agentPlanPanel.reset();
    conversationContext.recalibrate(retainedContextTokens);
    await sendPrompt(text, article, response.data.messageId);
    composer.pushHistory(text);
  } catch (error) {
    showStatus(errorMessage(error), "error");
    throw error;
  }
}

function appendCommentary(text: string, createdAt?: string): HTMLElement {
  return conversationMessages.appendCommentary(text, createdAt);
}

function appendChangeSummary(files: Array<{ path: string; action: "edited" | "created" }>): void {
  conversationMessages.appendChangeSummary(files);
}

function refreshComposerState(): void {
  const ready = Boolean((projects.currentSessionId || conversationSessions.newChat) && composer.controls.routeId);
  artifactController.setEnabled(Boolean(projects.currentSessionId));
  // The attach button also unlocks in a new chat so files can be staged for the first message.
  composer.setState({ ready, running: agentRuns.active, generating: mediaJobs.active, hasSession: Boolean(projects.currentSessionId || conversationSessions.newChat) });
}

function refreshAgentRunState(): void {
  refreshComposerState();
  renderTree();
  void sidebarActivity?.refresh();
}

function updateTitles(): void {
  const project = projects.activeProject();
  projectTitle.textContent = project?.name ?? "Fitz Codex";
  taskTitle.textContent = "";
}

function toggleSidebar(): void { adaptiveWorkspace?.toggleSidebar(); inAppBrowser.syncBounds(); closePopovers(); }

function setStatus(text: string, state: string): void { composer.setStatus(text, state); }
function showStatus(text: string, tone: ActionStatusTone): void { actionStatus.show(text, tone); }
function panelEmpty(text: string): HTMLElement { return textBlock("panel-empty", text); }
function loadingMessage(text: string): HTMLElement { return textBlock("panel-empty", text); }
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, ""); }
