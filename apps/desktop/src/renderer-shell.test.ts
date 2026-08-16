import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./renderer/index.html", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./markdown.ts", import.meta.url), "utf8");
const syntaxHighlighting = readFileSync(new URL("./syntax-highlighting.ts", import.meta.url), "utf8");
const conversationLayout = readFileSync(new URL("./ui/layout/conversation-layout.ts", import.meta.url), "utf8");
const workspacePages = readFileSync(new URL("./ui/layout/workspace-pages.ts", import.meta.url), "utf8");
const managementPage = readFileSync(new URL("./ui/layout/management-page.ts", import.meta.url), "utf8");
const collapsibleSection = readFileSync(new URL("./ui/layout/collapsible-section.ts", import.meta.url), "utf8");
const resizablePane = readFileSync(new URL("./ui/primitives/resizable-pane.ts", import.meta.url), "utf8");
const customSelect = readFileSync(new URL("./ui/primitives/custom-select.ts", import.meta.url), "utf8");
const contextMenu = readFileSync(new URL("./ui/primitives/context-menu.ts", import.meta.url), "utf8");
const overlayHost = readFileSync(new URL("./ui/primitives/overlay-host.ts", import.meta.url), "utf8");
const overlayHostCss = readFileSync(new URL("./ui/primitives/overlay-host.css", import.meta.url), "utf8");
const messageActions = readFileSync(new URL("./ui/chat/message-actions.ts", import.meta.url), "utf8");
const activityTimeline = readFileSync(new URL("./ui/chat/activity-timeline.ts", import.meta.url), "utf8");
const toolActivity = readFileSync(new URL("./ui/chat/tool-activity.ts", import.meta.url), "utf8");
const reasoningView = readFileSync(new URL("./ui/chat/reasoning-view.ts", import.meta.url), "utf8");
const agentRunController = readFileSync(new URL("./ui/chat/agent-run-controller.ts", import.meta.url), "utf8");
const agentPlanPanel = readFileSync(new URL("./ui/chat/agent-plan-panel.ts", import.meta.url), "utf8");
const mediaJobFeed = readFileSync(new URL("./ui/chat/media-job-feed.ts", import.meta.url), "utf8");
const conversationMessageFeed = readFileSync(new URL("./ui/chat/conversation-message-feed.ts", import.meta.url), "utf8");
const conversationLanding = readFileSync(new URL("./ui/chat/conversation-landing.ts", import.meta.url), "utf8");
const conversationTranscript = readFileSync(new URL("./ui/chat/conversation-transcript.ts", import.meta.url), "utf8");
const conversationContext = readFileSync(new URL("./ui/chat/conversation-context.ts", import.meta.url), "utf8");
const conversationSession = readFileSync(new URL("./ui/chat/conversation-session.ts", import.meta.url), "utf8");
const promptSubmission = readFileSync(new URL("./ui/chat/prompt-submission.ts", import.meta.url), "utf8");
const agentQueue = readFileSync(new URL("./ui/queue/work-queue.ts", import.meta.url), "utf8");
const artifactController = readFileSync(new URL("./ui/artifacts/artifact-controller.ts", import.meta.url), "utf8");
const appNavigation = readFileSync(new URL("./ui/navigation/app-navigation.ts", import.meta.url), "utf8");
const navigationHistory = readFileSync(new URL("./ui/navigation/navigation-history.ts", import.meta.url), "utf8");
const composerControls = readFileSync(new URL("./ui/chat/composer-controls.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("./ui/chat/composer.ts", import.meta.url), "utf8");
const connectionWorkspace = readFileSync(new URL("./ui/connections/connection-workspace.ts", import.meta.url), "utf8");
const textRoutePresentation = readFileSync(new URL("./ui/routes/text-route-presentation.ts", import.meta.url), "utf8");
const pluginCatalog = readFileSync(new URL("./ui/plugins/plugin-catalog.ts", import.meta.url), "utf8");
const administrationPage = readFileSync(new URL("./ui/administration/administration-page.ts", import.meta.url), "utf8");
const desktopUpdateController = readFileSync(new URL("./ui/administration/desktop-update-controller.ts", import.meta.url), "utf8");
const diagnosticsController = readFileSync(new URL("./ui/administration/diagnostics-controller.ts", import.meta.url), "utf8");
const hostingPageController = readFileSync(new URL("./ui/administration/hosting-page-controller.ts", import.meta.url), "utf8");
const safetyRecoveryController = readFileSync(new URL("./ui/administration/safety-recovery-controller.ts", import.meta.url), "utf8");
const playbookWorkspace = readFileSync(new URL("./ui/playbooks/playbook-workspace.ts", import.meta.url), "utf8");
const resourceInspector = readFileSync(new URL("./ui/inspector/resource-inspector.ts", import.meta.url), "utf8");
const inspectorPanel = readFileSync(new URL("./ui/inspector/inspector-panel.ts", import.meta.url), "utf8");
const inAppBrowser = readFileSync(new URL("./ui/browser/in-app-browser.ts", import.meta.url), "utf8");
const artifactRepository = readFileSync(new URL("./ui/inspector/artifact-repository.ts", import.meta.url), "utf8");
const resourcePreview = readFileSync(new URL("./resource-preview.ts", import.meta.url), "utf8");
const projectSidebar = readFileSync(new URL("./ui/sidebar/project-sidebar.ts", import.meta.url), "utf8");
const projects = readFileSync(new URL("./ui/projects/projects.ts", import.meta.url), "utf8");
const composerCss = readFileSync(new URL("./ui/chat/composer.css", import.meta.url), "utf8");
const composerControlsCss = readFileSync(new URL("./ui/chat/composer-controls.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("./ui/theme/tokens.css", import.meta.url), "utf8");
const styles = [
  readFileSync(new URL("./renderer/styles.css", import.meta.url), "utf8"),
  tokensCss,
  overlayHostCss,
  readFileSync(new URL("./ui/primitives/scroll-surface.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/message-actions.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/activity-timeline.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/agent-plan-panel.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/media-creation-form.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/reasoning-view.css", import.meta.url), "utf8"),
  composerControlsCss,
  composerCss,
  readFileSync(new URL("./ui/connections/connection-workspace.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/plugins/plugin-catalog.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/administration/administration-page.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/playbooks/playbook-workspace.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/sidebar/project-sidebar.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/inspector/inspector-panel.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/browser/in-app-browser.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/layout/management-page.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/layout/collapsible-section.css", import.meta.url), "utf8"),
].join("\n");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

describe("desktop renderer shell", () => {
  it("wires every visible shell action to a renderer interaction", () => {
    const rendererActions = [
      "sidebar-menu",
      "navigate-back",
      "navigate-forward",
      "sidebar-resizer",
      "new-session",
      "new-standalone-chat",
      "manage-playbooks",
      "new-project",
      "inspector-artifacts",
      "context-add",
      "add-artifact",
      "update",
    ];
    for (const id of rendererActions) {
      expect(html, `missing control #${id}`).toContain(`id="${id}"`);
      expect(renderer, `missing renderer binding for #${id}`).toContain(`element("${id}")`);
    }
    for (const id of ["attach", "send", "model-toggle", "context-meter", "context-compact", "advanced-settings", "scroll-to-bottom"]) {
      expect(composer, `missing composer control #${id}`).toContain(`id="${id}"`);
      expect(composer, `missing composer binding for #${id}`).toContain(`this.el<HTMLButtonElement>("#${id}")`);
    }
  });

  it("always starts the desktop on a fresh Local · Medium chat", () => {
    expect(renderer).toContain("let initialNavigationPending = true");
    expect(renderer).toContain("await projects.load(undefined, undefined, !initialNavigationPending)");
    expect(renderer).toContain("initialNavigationPending = false");
    expect(renderer).toContain("openNewChat()");
    expect(conversationSession).toContain("this.#options.composer.resetForNewChat()");
    expect(composerControls).toContain('private defaultRoute = "default"');
    expect(composerControls).toContain('private defaultEffort: AgentEffort = "normal"');
    expect(renderer).toContain("applyChatDefaults(managementConfiguration.chatDefaults)");
    expect(textRoutePresentation).toContain('{ id: "default", label: "Local", ownership: "host" }');
  });

  it("sheds composer text when the chat window is squeezed instead of mangling", () => {
    // The composer docks into the conversation column, so its width tracks the
    // chat window (and the Inspector stealing space). Width container queries
    // drop text in two stages: the access label goes icon-only first, then the
    // model name hides leaving the route and effort ("Smart · Medium").
    expect(composerCss).toContain("container-type: inline-size");
    expect(composerCss).toContain("container-name: composer");
    expect(composerCss).toContain("@container composer (max-width: 480px)");
    expect(composerCss).toContain("#access-mode-label { display: none; }");
    expect(composerCss).toContain("@container composer (max-width: 380px)");
    // The summary is the stable route / effort contract; resolved model
    // details remain available in the settings menu.
    expect(composer).toContain('id="model-route"');
    expect(composer).not.toContain('id="model-name"');
    expect(composer).toContain('id="model-effort"');
    expect(composerControls).toContain("displayName?: string");
    expect(composerControls).not.toContain("modelName");
    expect(composerControls).toContain("accessModeToggle.title = value.label");
    // One formatter passes the short route name alongside every "route · model" label.
    expect(renderer).toContain("textRouteOptions(managementConfiguration)");
    expect(textRoutePresentation).toContain("displayName: definition.label");
  });

  it("keeps chat actions in the sidebar menu and keyboard shortcuts, not the header", () => {
    expect(html).not.toContain('id="task-menu-toggle"');
    expect(html).not.toContain('id="task-menu"');
    expect(html).not.toContain('id="task-info-toggle"');
    expect(html).not.toContain('id="task-info"');
    expect(renderer).not.toContain("populateTaskInfo");
    expect(renderer).not.toContain('element("rename-task")');
    // The rename/archive shortcuts survive the menu removal.
    expect(renderer).toContain('event.ctrlKey && event.altKey && event.key.toLowerCase() === "r"');
    expect(renderer).toContain('event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a"');
  });

  it("uses inline sidebar editing and avoids blocking dialogs or browser prompts", () => {
    expect(html).not.toContain("<dialog");
    expect(html).toContain('id="management-editor"');
    expect(html).toContain('id="engine-form" class="management-editor-form"');
    expect(html).toContain('id="recipe-form" class="management-editor-form"');
    expect(html).not.toContain('id="route-form"');
    expect(renderer).not.toContain("window.prompt(");
    expect(renderer).not.toContain("window.alert(");
  });

  it("uses one integrated title bar with history and window controls", () => {
    expect(html).toContain('class="app-titlebar drag-region"');
    expect(html).toContain('class="titlebar-navigation"');
    expect(html).not.toContain('class="titlebar-navigation no-drag"');
    expect(styles).toContain(".no-drag, button, select, textarea, input { -webkit-app-region: no-drag; }");
    expect(html).toContain('class="workspace-header"');
    expect(html).not.toContain('class="workspace-header drag-region"');
    expect(html).not.toContain('data-app-menu=');
    expect(html).toContain('id="navigate-back"');
    expect(html).toContain('id="navigate-forward"');
    expect(html).toContain('data-window-action="minimize"');
    expect(main).toContain("frame: false");
    expect(html).not.toContain('id="app-menu-popover"');
    expect(renderer).toContain('element("navigate-back").addEventListener("click", () => void appNavigation.navigate(-1))');
    expect(renderer).toContain('element("navigate-forward").addEventListener("click", () => void appNavigation.navigate(1))');
    expect(main).toContain('ipcMain.handle("fitz:edit-command"');
    expect(main).not.toContain('ipcMain.handle("fitz:show-menu"');
    expect(main).toContain('ipcMain.handle("fitz:window-action"');
    expect(main).not.toContain("window.getBounds()");
    expect(styles).toContain("grid-template-rows: 32px minmax(0, 1fr)");
    expect(tokensCss).toContain("--workspace-header-height: 40px");
    expect(styles).toContain("grid-template-rows: var(--workspace-header-height) minmax(0, 1fr)");
    expect(styles).toContain(".management-page-header { height: var(--workspace-header-height)");
    expect(styles).toContain("top: var(--workspace-header-height); right: 0; bottom: 0");
    expect(html).not.toContain('id="sidebar-restore"');
  });

  it("maps mouse back and forward buttons to Fitz navigation history", () => {
    expect(main).toContain('window.on("app-command"');
    expect(main).toContain('command === "browser-backward"');
    expect(main).toContain('command === "browser-forward"');
    expect(main).toContain('browser.handleMouseNavigation(direction)');
    expect(main).toContain('window.webContents.send("fitz:navigation-command", direction)');
    expect(preload).toContain('onNavigationCommand(listener: (command: "back" | "forward")');
    expect(preload).toContain('ipcRenderer.on("fitz:navigation-command", handler)');
    expect(renderer).toContain('window.fitz.onNavigationCommand((command) => void appNavigation.navigate');
    expect(renderer).toContain('document.addEventListener("auxclick"');
    expect(renderer).toContain('event.button !== 3 && event.button !== 4');
    expect(navigationHistory).toContain('view: NavigableWorkspacePage;');
    expect(navigationHistory).toContain('path?: string[];');
    expect(renderer).toContain('onRouteChange: (path) => appNavigation.rememberRoute("playbooks", path)');
    expect(renderer).toContain('onRouteChange: (path) => appNavigation.rememberRoute("connections", path)');
    expect(appNavigation).toContain('async openManagement(view: ManagementView)');
    expect(appNavigation).toContain('if (location.path) this.#options.management[location.view].openRoute?.(location.path)');
    expect(navigationHistory).toContain('this.#entries.splice(this.#index + 1)');
    expect(navigationHistory).toContain('async navigate(offset: -1 | 1)');
  });

  it("keeps one desktop instance and focuses it on repeated launches", () => {
    expect(main).toContain('const primaryInstance = desktopSmoke || app.requestSingleInstanceLock()');
    expect(main).toContain('if (!desktopSmoke) app.on("second-instance", focusPrimaryWindow)');
    expect(main).toContain('if (window.isMinimized()) window.restore()');
    expect(main).toContain('if (!window.isVisible()) window.show()');
    expect(main).toContain('window.focus()');
  });

  it("keeps every management workspace on one stable scrollbar-aware axis", () => {
    expect(styles).toContain("--management-content-width: 900px");
    expect(styles).toContain("scrollbar-gutter: stable both-edges");
    expect(styles).toContain("width: min(var(--management-content-width), calc(100% - 48px))");
    expect(styles).toContain("--scrollbar-size: 10px");
    expect(styles).toContain("width: var(--scrollbar-size)");
    expect(styles).toContain("height: var(--scrollbar-size)");
    expect(styles).toContain("background-clip: content-box");
    expect(styles).toContain(".management-page-content > p { margin: 5px 0 24px; overflow: hidden; color: var(--muted); font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }");
    expect(styles).not.toContain(".management-page-content { width: min(820px");
  });

  it("matches the branded JEON lab sidebar and new-chat project rail", () => {
    expect(html).not.toContain('class="runtime-mode-toggle"');
    expect(html).toContain('class="sidebar-brand-logo"');
    expect(html).toContain('id="jeon-ripple-clip"');
    expect(html).toContain('<span>JEON lab</span>');
    expect(renderer).toContain("new ProjectSidebarController");
    expect(projectSidebar).toContain('this.#treeItem(session.title, "task-row", undefined');
    expect(renderer).not.toContain("function chatIcon()");
    expect(styles).toContain("height: 42px; display: flex; align-items: center");
    expect(html).toContain('class="sidebar-section projects-section"');
    expect(html).toContain('class="section-heading projects-heading"');
    expect(styles).toContain(".projects-heading #new-project, .chats-heading #new-standalone-chat { opacity: 0; pointer-events: none;");
    expect(html).toContain('id="pinned-section" class="sidebar-section pinned-section" hidden');
    expect(html).toContain('id="pinned" class="project-tree"');
    expect(styles).toContain(".sidebar-content-divider { margin: 12px 7px 4px; border-top: 1px solid var(--border-soft); }");
    expect(styles).toContain(".pinned-heading > span, .projects-heading > span, .chats-heading > span { color: var(--sidebar-subtle); font-weight: 650; }");
    expect(styles).toContain(".project-row, .task-row, .chat-row { width: 100%; display: flex; align-items: center; gap: 8px; min-width: 0; background: transparent; color: var(--sidebar-text);");
    expect(html).not.toContain("<kbd>Ctrl N</kbd>");
    expect(styles).toContain(".project-tree { display: grid; gap: 1px; }");
    expect(styles).toContain(".section-heading, .project-row, .task-row, .chat-row { font-size: 13.5px; }");
    expect(styles).toContain(".task-row { padding: 4px 9px 4px 30px; }");
    expect(styles).toContain("mask-image: linear-gradient(to right, var(--grey-0) 0, var(--grey-0) calc(100% - 6px), transparent 100%)");
    expect(styles).not.toContain(".project-row span, .task-row span, .chat-row span { overflow: hidden; text-overflow: ellipsis;");
    expect(styles).toContain(".tree-item:hover .tree-menu-toggle, .tree-item:hover .tree-quick-action, .tree-item:hover .tree-pin-action");
    expect(styles).toContain(".tree-pin-action.pinned svg { fill: currentColor; }");
    expect(tokensCss).toContain("--sidebar-item-radius: 7px");
    expect(styles).toContain("border-radius: var(--sidebar-item-radius)");
    expect(tokensCss).toContain("--grey-300: #303030");
    expect(tokensCss).toContain("--grey-250: #303030");
    expect(composerCss).toContain("background: var(--grey-250)");
    expect(styles).toContain(".markdown-code");
    expect(styles).toContain("background: var(--grey-300)");
    expect(renderer).not.toContain('identity.data?.user?.role === "administrator"');
    expect(html).toContain('d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"');
  });

  it("shows local and cloud inference in one securely stored workspace", () => {
    expect(html).not.toContain('data-runtime-mode="host"');
    expect(html).not.toContain('data-runtime-mode="consume"');
    expect(html).toContain('id="manage-playbooks"');
    expect(html).toContain('id="manage-connections"');
    expect(html).not.toContain('id="connections-page"');
    expect(connectionWorkspace).toContain('CONNECTION_EDITOR_TEMPLATE');
    expect(connectionWorkspace).toContain("new ManagementPageLayout(this.root");
    expect(connectionWorkspace).toContain('id="consumer-connection-url"');
    expect(connectionWorkspace).toContain('id: "connection-search"');
    expect(connectionWorkspace).toContain('id="connection-editor"');
    expect(renderer).toContain("new ConnectionWorkspaceController");
    expect(renderer).toContain("mount: workspace,");
    expect(renderer).toContain("connections: connectionWorkspace.root,");
    expect(renderer).not.toContain("const connectionsPage");
    expect(connectionWorkspace).toContain('this.options.bridge.saveConsumerConnection');
    expect(renderer).not.toContain('/api/v1/runtime-mode');
    expect(connectionWorkspace).toContain('const LOCAL_CONNECTION_ID = "hosted--local"');
    expect(renderer).not.toContain('connectionWorkspace.selectedConnectionId');
    expect(conversationSession).toContain('const payload = { title, ...(routeId ? { routeId } : {}) }');
    expect(renderer).not.toContain('candidate.routeId === card.id');
    expect(connectionWorkspace).not.toContain('recipe-test-button');
    expect(connectionWorkspace).toContain("private views(): ConnectionView[]");
    expect(connectionWorkspace).toContain('id: `${LOCAL_CONNECTION_ID}--${engineId}`');
    expect(connectionWorkspace).toContain('folder?.engine?.displayName ?? engineDisplayName(engineId)');
    expect(renderer).not.toContain('configuredConnectionId');
    expect(renderer).not.toContain('edit.textContent = configuredConnectionId');
    expect(connectionWorkspace).toContain('for (const model of connection.availableModels)');
    expect(connectionWorkspace).toContain('const routeId = definition.id');
    expect(connectionWorkspace).toContain('this.assignDefaultRoute(definition, model)');
    expect(connectionWorkspace).toContain('this.assignCloudRoute(definition, model)');
    expect(connectionWorkspace).toContain('if (!connection.hosted)');
    expect(connectionWorkspace).not.toContain('url.className = "connection-url"');
    expect(connectionWorkspace).toContain('{ id: "inference-cloud-tab", label: "Cloud", active: true }');
    expect(connectionWorkspace).toContain('{ id: "inference-local-tab", label: "Local" }');
    expect(connectionWorkspace).toContain('title: "Cloud"');
    expect(connectionWorkspace).toContain("openRecipeEditor(model");
    expect(connectionWorkspace).toContain("http://127.0.0.1:8000/v1");
    expect(styles).toContain('max-height: min(440px, calc(100vh - 32px)); overflow-y: auto;');
    expect(main).toContain('safeStorage.encryptString(JSON.stringify(connections))');
    expect(main).not.toContain('apiKey: connection.apiKey, models');
  });

  it("provides an inline Pi package and skills workspace", () => {
    expect(html).toContain('id="manage-plugins"');
    expect(html).toContain('id="plugins-page"');
    expect(renderer).toContain('{ id: "extension-tab", label: "Extensions", dataset: { type: "extension" }, active: true }');
    expect(renderer).toContain('{ id: "skill-tab", label: "Skills", dataset: { type: "skill" } }');
    expect(renderer).toContain('{ id: "prompt-tab", label: "Prompts", dataset: { type: "prompt" } }');
    expect(renderer).not.toContain('theme-tab');
    // Only chat-capable model types are browsable; embedders/rerankers are out.
    expect(renderer).not.toContain('id: "embedder-tab"');
    expect(renderer).not.toContain('id: "reranker-tab"');
    expect(renderer).toContain('{ id: "llm-tab", label: "LLMs", dataset: { category: "llm" }, active: true }');
    expect(renderer).toContain('{ id: "vision-tab", label: "Vision", dataset: { category: "vision" } }');
    expect(renderer).not.toContain('id: "audio-tab"');
    expect(html).toContain('id="plugin-catalog"');
    expect(html).toContain('id="installed-plugins-toggle"');
    expect(html).toContain('id="plugin-catalog-toggle"');
    expect(html).toContain('id="installed-skills-toggle"');
    expect(html).toContain('data-collapsible-key="installed"');
    expect(html).toContain('data-collapsible-key="discover"');
    expect(html).toContain('data-collapsible-key="skills"');
    expect(renderer).toContain('title: "Extensions"');
    expect(renderer).toContain('titleId: "plugins-title"');
    expect(renderer).toContain('title: "LLMs"');
    expect(renderer).toContain('titleId: "models-title"');
    expect(renderer).toContain('element("plugins-installed-section"), element("plugins-skills-section"), element("plugins-discover-section")');
    expect(pluginCatalog).toContain('this.elements.title.textContent = tab.textContent?.trim() || this.elements.title.textContent');
    expect(pluginCatalog).toContain('CollapsibleSection.adoptAll(this.elements.pluginsView, { storageKey: "fitz-collapsed-plugin-sections" })');
    expect(pluginCatalog).toContain('fitz-collapsed-plugin-sections');
    expect(pluginCatalog).toContain('/api/v1/management/pi/catalog');
    expect(pluginCatalog).toContain('/api/v1/management/pi/packages/install');
    expect(pluginCatalog).toContain('entry.links.homepage ?? entry.links.repository ?? entry.links.npm');
    expect(pluginCatalog).toContain('this.options.openExternal(website)');
    expect(pluginCatalog).toContain('Pi packages can run code with the same access as Fitz');
    expect(main).toContain('new HostSupervisor({');
    expect(main).toContain('origin: hostUrl');
    expect(main).toContain('resourcesPath: process.resourcesPath');
    expect(main).toContain('"host-startup.log"');
  });

  it("opens immediately and keeps host startup failures inside the app", () => {
    expect(main).not.toContain('dialog.showMessageBox({ type: "error"');
    expect(main).toContain("createWindow();");
    expect(main).toContain("void ensureLocalHost().then");
    expect(main.indexOf("let localHostStartup:")).toBeLessThan(main.indexOf("void ensureLocalHost().then"));
    expect(main.indexOf("createWindow();")).toBeLessThan(main.indexOf("void ensureLocalHost().then"));
    expect(main).toContain('console.warn("The local Fitz host is unavailable; the desktop will remain open"');
    expect(preload).toContain("retryLocalHost(): Promise<boolean>");
    expect(preload).toContain("onHostReady(listener: () => void)");
    expect(renderer).toContain("window.fitz.onHostReady(() => void initialize())");
    expect(renderer).toContain("window.fitz.retryLocalHost().catch(() => false)");
    expect(renderer).toContain("appNavigation.showConversation();\nvoid initialize();");
    expect(renderer).toContain('setStatus("Starting local services", "loading")');
    expect(renderer).not.toContain("showPairing");
    expect(renderer).not.toContain('setStatus("Offline"');
  });

  it("retires the Playbooks navigation surface in favor of Inference", () => {
    expect(html).toContain('id="playbook-page"');
    expect(html).not.toContain('data-management-view=');
    expect(renderer).toContain('search: { id: "playbook-search"');
    expect(renderer).toContain('id: "management-browser"');
    expect(renderer).toContain('appNavigation.openManagement("connections")');
    expect(connectionWorkspace).toContain('description: "Provider APIs and remote model servers."');
    expect(managementPage).toContain("#syncTitleToActiveTab");
    expect(renderer).toContain('{ id: "hosting-overview-tab", label: "Overview", active: true }');
    expect(playbookWorkspace).toContain("render(): void");
    expect(connectionWorkspace).toContain("TEXT_ROUTE_DEFINITIONS.map(withRouteIcon)");
    expect(renderer).toContain("textRouteOptions(managementConfiguration)");
    expect(renderer).not.toContain("assignFixedRoute(");
    expect(playbookWorkspace).toContain('Configure recipes from your engine folders.');
    expect(renderer).not.toContain("now uses ${recipe.displayName}");
    expect(playbookWorkspace).toContain("openEngineEditor(");
    expect(playbookWorkspace).toContain('/api/v1/management/engines/${encodeURIComponent(folderName)}');
    expect(renderer).not.toContain("ENGINE_CATALOG");
    expect(html).not.toContain("Add engine");
    expect(html).not.toContain("engine-root-path");
    expect(renderer).not.toContain('status.textContent = engine ? "Registered"');
    expect(renderer).not.toContain("${folder.rootPath}");
    expect(styles).toContain(".recipe-card-actions { align-self: center; display: flex; align-items: center;");
    expect(styles).toContain(".recipe-route-toggle { display: flex; align-items: center; gap: 1px; padding: 2px; border: 0;");
    expect(connectionWorkspace).toContain('class="route-icon-cut"');
    expect(connectionWorkspace).toContain('class="route-icon-filled" fill-rule="evenodd"');
    expect(html).not.toContain("NiNfer");
    expect(html).not.toContain("llama.cpp");
    expect(html).not.toContain("vLLM");
    expect(renderer).toContain("appNavigation.showConversation()");
  });

  it("shows recipe metadata without test actions", () => {
    expect(playbookWorkspace).not.toContain('recipe-test-button');
    expect(connectionWorkspace).not.toContain('recipe-test-button');
    expect(playbookWorkspace).toContain("labels.append(...recipeMetadata({");
    expect(connectionWorkspace).toContain("labels.append(...recipeMetadata({");
    expect(playbookWorkspace).not.toContain('detail.textContent = `${recipe.adapter} · ${recipe.modelId}`');
    expect(styles).not.toContain(".recipe-test-button");
    expect(styles).toContain(".recipe-card-label {");
  });

  it("exposes working keyboard, retry, attachment, and cancellation paths", () => {
    expect(composer).toContain('event.key === "Enter"');
    expect(renderer).toContain("window.fitz.retryLocalHost()");
    expect(artifactController).toContain("this.#options.fileInput.click()");
    expect(renderer).not.toContain('api(`/api/v1/artifacts/${artifact.id}`, "DELETE")');
    expect(composer).toContain("chip.remove()");
    expect(projectSidebar).toContain("this.#options.chooseFolder()");
    expect(projects).toContain("this.options.bridge.openPath(path)");
    expect(renderer).toContain("window.fitz.copyText(value)");
    expect(renderer).toContain("new ResizablePane({");
    expect(resizablePane).toContain('options.divider.addEventListener("pointerdown"');
    expect(resizablePane).toContain('event.key !== "ArrowLeft" && event.key !== "ArrowRight"');
    expect(projectSidebar).toContain('this.#openMenu("project"');
    expect(projectSidebar).toContain('this.#openMenu("task"');
    expect(composerControls).toContain('this.openSettingsSubmenu(row.dataset.setting as ComposerSetting, row)');
    expect(renderer).toContain('api("/api/v1/management/status")');
    expect(playbookWorkspace).toContain('/api/v1/management/recipes/${encodeURIComponent(id)}');
    expect(renderer).toContain("conversationContext.add(text)");
    expect(projects).toContain('this.options.api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" })');
    expect(promptSubmission).toContain("max_tokens: settings.maxTokens");
    expect(renderer).toContain("if (submission.content.trim().length > 0) void steerPrompt(submission.content)");
    // Media commands bypass the agent entirely, so they submit while a task is running.
    expect(renderer).toContain('if (agentRuns.active && !submission.mediaCommand) {');
    expect(renderer).toContain('mediaJobFeed.render({ id: jobId, modality, status: "queued" })');
    expect(renderer).toContain("else void agentRuns.cancel()");
    expect(renderer).toContain("appendSteer: (content) => activityTimeline.appendSteer(content)");
    expect(agentRunController).toContain('this.#options.api(`/api/v1/agent/runs/${this.#runId}`, "DELETE")');
    expect(agentRunController).toContain('this.#options.api(`/api/v1/agent/runs/${this.#runId}/steer`, "POST", { text })');
  });

  it("makes the new-chat project, environment, and branch controls functional", () => {
    for (const id of [
      "new-chat-project-control",
      "new-chat-environment-control",
      "new-chat-environment-menu",
      "new-chat-branch-control",
      "new-chat-branch-menu",
      "branch-search",
      "create-branch-form",
      "create-worktree-form",
    ]) expect(composer).toContain(`id="${id}"`);

    expect(renderer).toContain("onDismissProject: showNewChatLanding");
    expect(composer).toContain("this.options.bridge.gitBranches(rootPath)");
    expect(composer).toContain("this.options.bridge.checkoutBranch(rootPath, branch)");
    expect(composer).toContain("this.options.bridge.createBranch(rootPath, branch)");
    expect(composer).toContain("this.options.bridge.createWorktree(rootPath, branch)");
    expect(main).toContain('ipcMain.handle("fitz:git-branches"');
    expect(main).toContain('ipcMain.handle("fitz:git-checkout-branch"');
    expect(main).toContain('ipcMain.handle("fitz:git-create-branch"');
    expect(main).toContain('ipcMain.handle("fitz:git-create-worktree"');
    expect(composerCss).toContain("bottom: calc(100% + 6px)");
    expect(composerCss).not.toContain("bottom: calc(100% - 12px)");
  });

  it("renders durable Codex-style agent activity with tool-specific symbols", () => {
    expect(agentRunController).toContain("this.#options.activity.appendTool(toolName, input, toolCallId");
    expect(agentRunController).toContain("this.#options.activity.completeTool");
    expect(activityTimeline).toContain('summary.type = "button"');
    expect(activityTimeline).toContain('this.#detail("Input", input');
    expect(activityTimeline).toContain('this.#detail("Result"');
    expect(activityTimeline).toContain('summary.setAttribute("aria-expanded", String(open))');
    expect(conversationTranscript).toContain("entry.content?.result");
    expect(agentRunController).toContain("event.data?.result");
    expect(activityTimeline).toContain("#formatPayload");
    expect(agentRunController).toContain("this.#options.activity.markAssistantAsCommentary");
    expect(activityTimeline).toContain("Context automatically compacted");
    expect(toolActivity).toContain("BUILT_IN_TOOLS");
    expect(toolActivity).toContain('kind: "edit"');
    expect(toolActivity).toContain("iconPathFor");
    expect(styles).toContain(".agent-activity-icon");
    expect(styles).toContain(".agent-activity-details");
    expect(styles).toContain(".agent-activity.open .agent-activity-chevron");
    expect(styles).toContain(".message.commentary");
  });

  it("keeps the durable task plan as one live composer artifact", () => {
    expect(renderer).toContain("new AgentPlanPanel(composer.root)");
    expect(agentPlanPanel).toContain('title.textContent = "Tasks"');
    expect(agentPlanPanel).toContain("this.#list.replaceChildren");
    expect(agentPlanPanel).toContain('className = "agent-plan-panel-toggle"');
    expect(agentPlanPanel).toContain("this.#setCollapsed");
    expect(agentRunController).toContain('toolName === "agent_plan"');
    expect(agentRunController).toContain("this.#options.updatePlan(event.data?.result)");
    expect(agentRunController).toContain("this.#options.clearPlan()");
    expect(conversationTranscript).toContain('if (toolName === "agent_plan")');
    expect(styles).toContain(".agent-plan-panel-list");
    expect(styles).toContain(".agent-plan-panel.collapsed");
    expect(activityTimeline).not.toContain("plan-activity");
  });

  it("replaces regenerated context instead of accumulating the discarded turn", () => {
    expect(renderer).toContain("typedApi<ApiData<RegeneratedAssistantTurn>>");
    expect(renderer).toContain("const retainedContextTokens = Number(response.data.estimatedContextTokens)");
    expect(renderer).toContain("conversationContext.recalibrate(retainedContextTokens)");
  });

  it("matches Codex assistant, command disclosure, and shell presentation", () => {
    expect(renderer).not.toContain('className = "assistant-mark"');
    expect(styles).not.toContain(".assistant-mark");
    expect(activityTimeline).toContain('toolName === "bash"');
    expect(activityTimeline).toContain('details.classList.add("shell-details")');
    expect(activityTimeline).toContain('title.textContent = "Shell"');
    expect(activityTimeline).toContain('status.textContent = running ? "Running…" : "✓ Success"');
    expect(styles).toContain(".agent-activity-summary:hover .agent-activity-chevron");
    expect(styles).toContain("opacity: 0; transition: opacity 120ms ease");
    expect(styles).toContain(".agent-activity.open .agent-activity-chevron { transform: rotate(90deg); }");
    expect(styles).toContain(".agent-activity-details.shell-details");
    expect(styles).toContain('.shell-command::before { content: "$ ";');
    expect(activityTimeline).toContain('label.classList.add("file-target")');
    expect(styles).toContain(".agent-activity-label.file-target");
    expect(styles).toContain(".activity-burst-details { min-width: 0; max-height: 380px; margin: 0 0 3px; padding: 0;");
    expect(styles).toContain(".activity-burst-details > .message.agent-activity { margin: 0; }");
    expect(styles).toContain(".agent-activity-summary { width: 100%; min-width: 0; min-height: 26px;");
    expect(styles).toContain(".work-summary-details { padding: 6px 0 0; }");
    expect(styles).toContain(".work-summary-details > .message.commentary { margin: 0 0 8px; }");
  });

  it("treats the reasoning chain as its own component, separate from chat", () => {
    expect(agentRunController).toContain('event.type === "reasoning.delta"');
    expect(agentRunController).toContain("this.#options.activity.appendReasoning(true)");
    expect(agentRunController).toContain("this.#options.activity.appendReasoningDelta(reasoning, delta)");
    expect(agentRunController).toContain("this.#options.activity.completeReasoning(reasoning)");
    expect(activityTimeline).toContain("appendReasoning(running: boolean, createdAt?: string): HTMLElement");
    expect(activityTimeline).toContain("new ReasoningView(running)");
    expect(activityTimeline).toContain("?.appendDelta(text)");
    expect(activityTimeline).toContain("?.complete()");
    expect(reasoningView).toContain("export class ReasoningView");
    expect(reasoningView).toContain('className = "reasoning-content"');
    expect(reasoningView).not.toContain("Thought through the approach");
    expect(reasoningView).not.toContain("agent-activity-summary");
    expect(conversationTranscript).toContain('entry.kind === "reasoning"');
    expect(conversationTranscript).toContain("this.#options.activity.appendReasoning(false, entry.createdAt)");
    expect(styles).toContain(".reasoning-content");
    expect(styles).toContain(".message.reasoning-activity { margin: 0 0 12px; color: var(--text); }");
    expect(styles).not.toContain("reasoning-cursor");
    expect(renderer).toContain("window.fitz.subscribeAgentEvents(input, listener)");
    expect(preload).toContain('ipcRenderer.send("fitz:agent-events-subscribe"');
    expect(main).toContain('ipcMain.on("fitz:agent-events-subscribe"');
    expect(main).toContain("parseAgentEventStream(response.body, signal)");
  });

  it("collapses completed Pi activity behind a durable work summary", () => {
    expect(conversationMessageFeed).toContain('role === "user" ? "next-message" : "completed"');
    expect(activityTimeline).toContain("this.#ensureWork(createdAt)");
    expect(activityTimeline).toContain('label.textContent = `Worked for ${this.#formatElapsed(endedAt - work.startedAt)}`');
    expect(activityTimeline).toContain('work.root.classList.toggle("completed", boundary === "completed")');
    expect(activityTimeline).toContain('row.className = "message context-activity"');
    expect(styles).toContain(".work-summary-toggle");
    expect(styles).toContain(".work-summary.completed.open .work-summary-details");
    expect(styles).toContain(".context-activity");
  });

  it("renders streamed assistant Markdown safely while keeping prompts plain", () => {
    expect(renderer).toContain('import { appendMarkdown } from "./markdown.js"');
    expect(conversationMessageFeed).toContain('import { setMarkdown } from "../../markdown.js"');
    expect(renderer).toContain("appendAssistantDelta: (target, delta) => appendMarkdown(target, delta)");
    expect(conversationMessageFeed).toContain('if (role === "assistant" || role === "commentary") setMarkdown(content, text);');
    expect(conversationMessageFeed).toContain("else content.textContent = text");
    expect(markdown).toContain("target.replaceChildren()");
    expect(markdown).not.toContain("target.innerHTML");
    expect(markdown).toContain("code.innerHTML = highlighted.html");
    expect(markdown).toContain('window.dispatchEvent(new CustomEvent("fitz:open-resource"');
    expect(markdown).toContain('link.className = "resource-link"');
    expect(markdown).toContain('container.className = "markdown-code"');
    expect(markdown).toContain("createCopyButton({");
    expect(markdown).toContain('document.createElement("table")');
    expect(styles).toContain(".message-body.markdown h1");
    expect(styles).toContain(".markdown-code pre");
    expect(styles).toContain(".markdown-table table");
  });

  it("runs a post-generation rule layer between raw output and display", () => {
    expect(markdown).toContain('import { applyPostGeneration } from "./post-generation.js"');
    expect(markdown).toContain("const display = applyPostGeneration(");
    expect(markdown).toContain("renderBlocks(target, display.split(");
    expect(conversationMessageFeed).toContain('if (role === "assistant" || role === "commentary") setMarkdown(content, text);');
  });

  it("reveals compact Copy and user Edit actions on message hover", () => {
    expect(conversationMessageFeed).toContain("this.#options.actions.attach(article, content");
    expect(renderer).toContain("copyText: (text) => window.fitz.copyText(text)");
    expect(messageActions).toContain("this.#copyButton(content)");
    expect(messageActions).toContain("createCopyButton({");
    expect(messageActions).toContain('this.#actionButton("Edit message"');
    expect(messageActions).toContain('time.className = "message-time"');
    expect(messageActions).toContain("this.#formatTimestamp(createdAt)");
    expect(styles).toContain(".message:hover .message-actions");
    expect(styles).toContain(".message.assistant .message-actions");
    expect(styles).not.toContain(".message.commentary .message-actions");
    expect(conversationMessageFeed).toContain('if (role === "user" || role === "assistant")');
    expect(activityTimeline).toContain('article.querySelector(":scope > .message-actions")?.remove()');
    expect(styles).toContain(".message-action svg");
  });

  it("edits user prompts inline with Cancel and Send controls", () => {
    expect(renderer).toContain('resend: (text, article) => sendPrompt(text, article)');
    expect(messageActions).toContain('editor.className = "message-inline-editor"');
    expect(messageActions).toContain('this.#textButton("Cancel"');
    expect(messageActions).toContain('this.#textButton("Send"');
    expect(messageActions).toContain("void this.#options.resend(revised, article)");
    expect(messageActions).toContain('event.key === "Enter" && (event.ctrlKey || event.metaKey)');
    expect(messageActions).toContain('bubble.className = "message-edit-bubble"');
    expect(styles).toContain(".message-inline-editor");
    expect(styles).toContain(".message-edit-bubble");
    expect(styles).toContain(".message-edit-controls");
    expect(styles).toContain("margin-top: 9px");
  });

  it("uses the responsive composer measure as the single conversation axis", () => {
    expect(styles).toContain("--conversation-inset: clamp(48px, 8vw, 96px)");
    expect(styles).toContain("--conversation-width: min(768px, calc(var(--conversation-space) - var(--conversation-inset)))");
    expect(styles).toContain("--conversation-gutter: max(24px, calc((var(--conversation-space) - var(--conversation-width)) / 2))");
    expect(styles).not.toContain("--conversation-content-inset");
    expect(styles).toContain("grid-template-columns: var(--conversation-gutter) minmax(0, var(--conversation-width)) minmax(0, 1fr)");
    expect(styles).toContain("width: var(--conversation-width)");
    expect(styles).toContain("--composer-height: 112px");
    expect(styles).toContain("padding: 32px 0 calc(var(--composer-height) + 108px)");
    expect(styles).toContain("top: var(--workspace-header-height); bottom: 0; left: 0; width: var(--conversation-viewport)");
    expect(styles).toContain(".messages > * { grid-column: 2; }");
    expect(styles).toContain("left: var(--conversation-gutter)");
    expect(styles).toContain("bottom: 20px");
    expect(styles).toContain("clip-path: inset(0 0 calc(var(--composer-height) + 20px) 0)");
    expect(styles).toContain("--conversation-space: var(--conversation-viewport)");
    expect(styles).not.toContain("--conversation-scrollbar");
    expect(styles).toContain(".workspace.inspector-open { --conversation-viewport: calc(100% - var(--inspector-width))");
    expect(renderer).toContain("new ConversationLayout({");
    expect(conversationLayout).toContain("new ResizeObserver(this.sync)");
    expect(conversationLayout).toContain("this.#resizeObserver.observe(target)");
    expect(conversationLayout).toContain('workspace.style.setProperty("--conversation-viewport", `${viewportWidth}px`)');
    expect(conversationLayout).toContain('workspace.style.setProperty("--conversation-width", `${conversationWidth}px`)');
    expect(conversationLayout).toContain('workspace.style.setProperty("--conversation-gutter", `${gutter}px`)');
    expect(conversationLayout).not.toContain("scrollbarWidth");
    expect(conversationLayout).not.toContain("messages.offsetWidth - messages.clientWidth");
    expect(conversationLayout).toContain("composer.offsetHeight");
    expect(composer).toContain('id="scroll-to-bottom"');
    expect(conversationLayout).toContain('options.messages.addEventListener("scroll", this.updateScrollButton');
    expect(conversationLayout).toContain('messages.scrollTo({ top: this.#options.messages.scrollHeight, behavior: "smooth" })');
    expect(styles).not.toContain("scroll-behavior: smooth");
    expect(conversationSession).toContain("if (!messages.childElementCount) this.#options.showLanding(true)");
    expect(conversationSession).toContain("messages.scrollTop = messages.scrollHeight");
    expect(conversationLayout).toContain("distanceFromBottom < 48");
    expect(composerCss).toContain(".scroll-to-bottom");
    expect(composerCss).toContain("bottom: calc(100% + 12px)");
  });

  it("expands Advanced model settings and sends the chosen temperature and output limit", () => {
    for (const id of ["advanced-settings-panel", "temperature", "temperature-value"]) expect(composer).toContain(`id="${id}"`);
    expect(composerControls).toContain("this.toggleAdvancedSettings()");
    expect(composerControls).toContain('this.storage.setItem("fitz-temperature", this.elements.temperature.value)');
    expect(renderer).toContain("temperature: composer.controls.temperature");
    expect(promptSubmission).toContain("max_tokens: settings.maxTokens");
    expect(styles).toContain('.advanced-row[aria-expanded="true"] svg');
    expect(styles).toContain(".advanced-settings-panel");
    expect(styles).toContain(".popover.model-menu { width: 286px;");
    expect(composerControls).toContain('placement: "auto-end"');
    expect(composer).toContain("options.overlayHost.register");
    expect(overlayHost).toContain("this.root.append(element)");
    expect(composer).toContain('id="model-menu-root"');
    expect(composerControls).toContain("this.elements.modelMenuRoot.hidden = true");
    expect(composerControls).toContain("this.showSettingsRoot()");
    expect(composerControls).not.toContain("positionNestedPopover");
    expect(composerControls).not.toContain("settings-page-back");
    expect(composer).toContain('<option value="light" data-max-tokens="4096">Light</option><option value="normal" data-max-tokens="10240" selected>Medium</option><option value="high" data-max-tokens="24576">High</option>');
    expect(promptSubmission).toContain("effort: settings.effort");
    expect(composer).not.toContain('data-setting="speed"');
    expect(composer).not.toContain("Extra High");
    expect(composer).not.toContain("Ultra");
  });

  it("warms Default on desktop open and retains first-character warm as a safety net", () => {
    expect(main).toContain("void warmLocalDefault()");
    expect(main).toContain('hostClient.fetch("/api/v1/inference/warm"');
    expect(renderer).toContain("agentRuns.scheduleWarmup(text, composer.controls.routeId)");
    expect(renderer).not.toContain("agentRuns.scheduleWarmup(composer.value, composer.controls.routeId)");
    expect(agentRunController).toContain('this.#options.api("/api/v1/inference/warm", "POST", { model })');
    expect(agentRunController).toContain("if (this.#composerHadText || this.active || !model) return");
    expect(agentRunController).toContain("}, 120)");
    expect(playbookWorkspace).toContain("idleTtlSeconds: 600");
    expect(renderer).not.toContain('contextMeter.classList.toggle("model-loading", loading)');
    expect(styles).toContain("@keyframes run-activity-spinner");
    expect(styles).toContain(".run-activity::before");
    expect(styles).toContain("animation: run-activity-spinner 680ms linear infinite");
    expect(styles).not.toContain(".context-meter.model-loading");
  });

  it("recalls the session's own user prompts with the up and down arrow keys", () => {
    expect(composer).toContain("promptHistory: string[] = []");
    expect(composer).toContain("promptHistoryIndex = -1");
    expect(composer).toContain("promptDraft = \"\"");
    expect(composer).toContain('event.key === "ArrowUp" || event.key === "ArrowDown"');
    expect(composer).toContain('navigatePromptHistory(event.key === "ArrowUp" ? -1 : 1)');
    expect(composer).toContain("this.promptDraft = this.mediaCommand ? `/${this.mediaCommand} ${this.prompt.value}` : this.prompt.value");
    expect(composer).toContain("this.applyDraft(this.promptDraft)");
    expect(composer).toContain("this.applyDraft(this.promptHistory[this.promptHistoryIndex] ?? \"\")");
    expect(composer).toContain("rebuildHistory(texts: string[])");
    expect(conversationTranscript).toContain('entry.kind === "message" && entry.role === "user"');
    expect(composer).toContain("this.promptHistory.push(text)");
    expect(conversationSession).toContain("this.#options.transcript.restore(transcript.data ?? [], transcript.page ?? {})");
  });

  it("keeps every dropdown and overflow surface at the compact Codex menu density", () => {
    expect(styles).toContain(".popover { position: absolute; padding: 4px;");
    expect(styles).toContain(".menu-surface button { width: 100%; min-height: 32px;");
    expect(styles).not.toContain(".app-menu-popover");
    expect(styles).toContain(".sidebar-context-menu { width: 242px;");
    expect(styles).toContain(".access-mode-menu { left: 0; bottom: 34px; width: 250px;");
    expect(styles).toContain(".settings-submenu { width: 100%;");
    expect(styles).toContain(".composer-add-menu { left: 0; bottom: 36px; width: 250px;");
  });

  it("uses a larger new-chat composer and quickly settles it into the canonical dock", () => {
    expect(composerCss).toContain("calc(var(--conversation-width) * 1.2)");
    expect(composerCss).toContain("bottom: calc(100% + 64px)");
    expect(composerCss).toContain(".workspace.new-chat-open #prompt { min-height: 65px;");
    expect(composerCss).toContain(".composer-toolbar { position: relative; z-index: 1; min-height: 44px;");
    expect(composerCss).toContain("padding: 6px 10px");
    expect(composerCss).toContain(".workspace.new-chat-open .composer-toolbar { min-height: 53px; padding: 10px 10px 4px; }");
    expect(composerCss).toContain("bottom 220ms cubic-bezier(.23,1,.32,1)");
    expect(composerCss).toContain(".composer-dock.new-chat-launching");
    expect(composerCss).toContain("@keyframes new-chat-halo-implode");
    expect(composerCss).not.toContain("bottom: auto");
    expect(conversationSession).toContain('workspace.classList.remove("new-chat-open")');
  });

  it("manually compacts context from the inline usage popover", () => {
    expect(composer).toContain('id="context-compact"');
    expect(renderer).toContain('api(`/api/v1/sessions/${sessionId}/compact`, "POST"');
    expect(conversationTranscript).toContain("estimateTranscriptContext(entries)");
    expect(conversationContext).toContain('this.#options.appendContext("Context compacted")');
    expect(styles).toContain(".context-usage-popover button");
  });

  it("uses the measured desktop design tokens", () => {
    expect(styles).toContain("--bg: var(--grey-100)");
    expect(styles).toContain("--text: var(--grey-950)");
    expect(styles).toContain("--floating-surface: rgba(33,33,33,.96)");
    expect(styles).toContain("--sidebar: #121316");
    expect(styles).toContain("--sidebar-text: rgba(242,243,239,.82)");
    expect(styles).toContain("--radius-3xl: 25px");
    expect(styles).toContain("--control-size: 28px");
    expect(styles).toContain("--sidebar-width: 275px");
    expect(styles).toContain("--conversation-width: min(768px, calc(var(--conversation-space) - var(--conversation-inset)))");
    expect(styles).toContain("max-width: 100%");
    expect(styles).toContain("backdrop-filter: blur(16px)");
    expect(styles).toContain("--elevation-prominent:");
    expect(styles).toContain("--shadow-new-chat:");
    expect(styles).toContain("--new-chat-base: var(--grey-100)");
    expect(styles).toContain("--new-chat-outline: rgba(255,255,255,.68)");
    expect(styles).not.toContain("--chat-window-gradient:");
    expect(styles).toContain("--shadow-chat-rest:");
    expect(styles).toContain("--brand-electric-blue: #458ce6");
    expect(styles).toContain("position: relative; isolation: isolate;");
    expect(styles).toContain(".messages { position: absolute; z-index: 2;");
    expect(composerCss).toContain(".composer-halo { position: absolute; z-index: 1; inset: 0;");
    expect(composer).toContain('<div class="composer-halo" aria-hidden="true"></div>\n  <form id="composer"');
    expect(composerCss).not.toContain("clip-path: inset(0 -120px -120px -120px)");
    expect(styles).toContain(".agent-plan-panel { position: relative; z-index: 31;");
    expect(composerCss).not.toContain(":has(.popover");
    expect(overlayHostCss).toContain("z-index: var(--layer-overlay)");
    expect(overlayHostCss).toContain("position: fixed !important");
    expect(tokensCss).toContain("--layer-overlay: 1000");
    expect(composerCss).toContain(".composer-card { position: relative; z-index: 30; isolation: isolate; overflow: visible; border: 1px solid var(--new-chat-outline)");
    expect(composerCss).toContain("container-type: inline-size; container-name: composer;");
    expect(composerCss).not.toContain(".composer-card::before");
    expect(composerCss).not.toContain(".composer-dock::after");
    expect(renderer).toContain("composer.root.hidden = inert");
    expect(renderer).toContain("if (inert) {");
    expect(renderer).toContain("composer.closePopovers()");
    expect(renderer).toContain("agentPlanPanel.reset()");
    expect(composerCss).toContain(".composer-card:focus-within { background: var(--new-chat-base); }");
    expect(composerCss).toContain("@keyframes chat-halo-breathe");
    expect(composerCss).toContain("animation: chat-halo-breathe 7.2s ease-in-out infinite");
    expect(projectSidebar).toContain('class="project-folder-open"');
    expect(styles).toContain(".project-group.expanded > .tree-item > .project-row .project-folder-open { display: initial; }");
    expect(styles).toContain(".tree-item:has(.project-row) .tree-quick-action { right: 58px; }");
    expect(styles).not.toContain(".tree-item:has(.project-row) .tree-pin-action { right: 58px; }");
    expect(renderer).toContain('storageKey: "fitz-sidebar-width"');
    expect(renderer).toContain("minimum: 240, maximum: 520");
    expect(html).toContain('d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"');
  });

  it("centralizes every color in the token file and uses tokens everywhere", () => {
    // Brand inputs, the neutral ramp, and overlay tints live in tokens.css.
    expect(styles).toContain("--brand-black: #0d0d0d");
    expect(styles).toContain("--brand-white: #ffffff");
    expect(styles).toContain("--brand-blue: #6bb2ff");
    expect(styles).toContain("--brand-neutral: #70747a");
    expect(styles).toContain("--selection: var(--brand-neutral-tint)");
    expect(styles).toContain("--grey-950: #f2f3ef");
    expect(styles).toContain("--grey-800: #c8cbc5");
    expect(styles).toContain("--grey-100: #17181c");
    expect(styles).toContain("--tint-3: rgba(255,255,255,.06)");
    expect(styles).toContain("--tint-5: rgba(255,255,255,.10)");
    expect(styles).toContain("--tint-7: rgba(255,255,255,.14)");
    expect(styles).toContain(".recipe-card:hover, .recipe-card:focus-within { border-color: var(--row-outline-hover); background: var(--new-chat-base); }");
    expect(styles).not.toContain("--row-hover-glow");
    expect(styles).toContain(".recipe-card { width: 100%; min-height: 66px;");
    expect(styles).toContain("border: 1px solid var(--row-outline); border-radius: 10px; background: var(--new-chat-base)");
    expect(styles).toContain(".collapsible-toggle:hover, .collapsible-toggle:focus-visible { background: var(--tint-5); }");
    expect(composerControlsCss).toContain("#model-route { color: var(--text); }");
    expect(composerControlsCss).toContain("#model-effort { color: var(--text); opacity: .58; }");
    expect(composerControlsCss).toContain(".model-toggle { min-width: 0; width: max-content;");
    expect(composerCss).toContain(".send-button .send-icon { width: 19px; height: 19px; stroke-width: 1.85; }");
    // The artifact bubble sits on the raised-surface ramp step; its hover
    // stays the shared strong-hover tint.
    expect(styles).toContain(".workspace-header .inspector-tab { position: relative; height: 26px; max-width: 180px; padding: 0 8px 0 12px; border-radius: 8px; border: 0; background: var(--grey-200); color: var(--subtle); font-size: 12px; }");
    expect(styles).toContain(".workspace-header .inspector-tab:hover { background: var(--tint-7);");
    expect(styles).toContain(".workspace-header .inspector-tab.active { background: var(--selection); color: var(--grey-950); }");
    expect(styles).toContain(".workspace.new-chat-open:not(.inspector-open) .workspace-header { visibility: hidden;");
    expect(styles).toContain(".workspace.new-chat-open.inspector-open .workspace-title { visibility: hidden; }");
    // The legacy codex-* namespace and its duplicate surface/red tokens are
    // gone: the ramp and the semantic roles above are the only source of truth.
    expect(styles).not.toContain("--codex-");
    expect(styles).not.toContain("--surface-hover");
    expect(styles).not.toContain("--surface-raised");
    expect(styles).not.toContain("--red:");
    // No component CSS may hardcode a color anymore; the token file is the
    // single source of truth.
    const componentStyles = styles.replace(tokensCss, "");
    expect(componentStyles.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)).toBeNull();
    expect(main).toContain('readThemeColor(join(directory, "ui", "theme", "tokens.css"), "--window-background")');
    expect(main.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)).toBeNull();
    expect(resourceInspector).toContain('getPropertyValue("--scrollbar-thumb")');
    expect(resourceInspector.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)).toBeNull();
  });

  it("drops the hover cards in favor of the centered create-project dialog", () => {
    expect(html).not.toContain('id="project-hover-card"');
    expect(html).not.toContain('id="chat-hover-card"');
    expect(html).not.toContain('id="hover-project-pin"');
    expect(html).not.toContain('id="hover-chat-title"');
    expect(projectSidebar).not.toContain("#showProjectHover");
    expect(projectSidebar).not.toContain("#showChatHover");
    expect(projectSidebar).not.toContain("hideOverlays");
    expect(projectSidebar).toContain("create-project-backdrop");
    expect(projectSidebar).toContain('beginCreateProject(): void');
  });

  it("lands every empty project on the same new-chat page the sidebar quick action opens", () => {
    expect(renderer).not.toContain("createProjectThenNewChat");
    expect(renderer).toContain("if (created && projects.currentProjectId) openNewChatForProject(projects.currentProjectId)");
    expect(conversationSession).toContain("if (this.#options.projects.currentProjectId) this.openNewChatForProject(this.#options.projects.currentProjectId)");
    expect(conversationLanding).toContain('action.textContent = "Create project"');
    expect(renderer).not.toContain('textContent = projects.currentProjectId ? "New task"');
    expect(projects).toContain('rememberLocation({ view: "conversation", path: ["new"], context: { projectId: id } })');
  });

  it("keeps the project quick action and context menu actions", () => {
    expect(projectSidebar).toContain('className = "tree-quick-action"');
    expect(projectSidebar).toContain("New chat in ${label}");
    expect(styles).not.toContain(".project-group:hover > .tree-item .tree-quick-action");
    for (const label of ["Pin project", "Open in Explorer", "Create permanent worktree", "Edit project", "Archive chats", "Remove"]) {
      expect(projectSidebar).toContain(`"${label}"`);
    }
    expect(projects).toContain('this.options.api(`/api/v1/projects/${id}`, "DELETE")');
  });

  it("keeps standalone chats in their own sidebar section, sibling to projects", () => {
    // The sidebar carries a concise Chats section below Projects.
    expect(html).toContain('id="chats" class="project-tree" aria-label="Chats"');
    expect(html).toContain("<span>Chats</span>");
    expect(html).toContain('class="section-heading chats-heading"');
    expect(html).toContain('id="new-standalone-chat" class="icon-button" type="button" title="New chat" aria-label="New chat"');
    expect(renderer).toContain('element("new-standalone-chat").addEventListener("click", openNewChat)');
    expect(styles).toContain(".chats-heading:hover #new-standalone-chat, .chats-heading:focus-within #new-standalone-chat, #new-standalone-chat:focus-visible { opacity: 1; pointer-events: auto; }");
    expect(renderer).toContain("chatsMount: element(\"chats\")");
    expect(projectSidebar).toContain("chatsMount: HTMLElement");
    expect(projectSidebar).toContain("chats: readonly ProjectSidebarSession[]");
    expect(projectSidebar).toContain("const unpinnedChats = state.chats.filter((chat) => !this.#pinnedSessions.has(chat.id))");
    expect(projectSidebar).toContain('state.chats.length ? "All chats pinned" : "No chats yet"');
    expect(projectSidebar).toContain('#chatItem(chat: ProjectSidebarSession): HTMLElement');
    expect(projectSidebar).toContain('"chat-row"');
    expect(renderer).toContain("chats: projects.chats");
    expect(projects).toContain('api("/api/v1/chats")');
    expect(projects).toContain("startChat(session: SessionRecord): void");
    expect(projects).toContain('else if (this.chatRecords.some((chat) => chat.id === id)) this.currentProjectIdValue = undefined');
    expect(styles).toContain(".chat-row { padding: 4px 9px; }");
    expect(styles).toContain(".pinned-heading > span, .projects-heading > span, .chats-heading > span { color: var(--sidebar-subtle); font-weight: 650; }");
  });

  it("clears the starter screen and reports unobtrusive work progress before output arrives", () => {
    expect(conversationMessageFeed).toContain('this.#options.messages.querySelector(".landing, .new-chat-landing")');
    expect(agentRunController).toContain('this.#options.activity.appendRun("Working")');
    expect(agentRunController).toContain('this.#options.activity.setRun(activity, "Working", startedAt)');
    expect(agentRunController).not.toContain('this.#options.activity.setRun(activity, "Loading model"');
    expect(activityTimeline).toContain("this.#formatElapsed(Date.now() - startedAt)");
    expect(agentRunController).toContain('this.#options.api("/api/v1/management/status")');
    expect(conversationMessageFeed).toContain('if (closesWork && role !== "commentary" && !this.#options.runActive())');
    expect(conversationMessageFeed).toContain('this.#options.activity.finishWork(createdAt, role === "user" ? "next-message" : "completed")');
    expect(agentRunController).toContain("this.#options.activity.finishWork()");
  });

  it("shows and controls the serialized native-agent request queue", () => {
    expect(html).toContain('id="request-queue"');
    expect(html).toContain('id="queue-count"');
    expect(agentQueue).toContain('this.options.api("/api/v1/work/queue")');
    expect(agentRunController).toContain('event.type === "run.queue.updated"');
    expect(agentQueue).toContain('this.#cancel(String(item.id), cancel)');
    expect(renderer).toContain('setTimeout(scheduleQueueRefresh, 1_000)');
    expect(styles).toContain(".queue-item");
    expect(styles).toContain(".queue-cancel");
  });

  it("replaces the deferred Environment surface with a resource Inspector", () => {
    // The header carries only working Inspector actions.
    expect(html).toContain('id="inspector-render-toggle" class="icon-button" type="button" title="View source" aria-label="View source" aria-pressed="false" hidden');
    expect(html).not.toContain('id="inspector-new-tab"');
    expect(html).not.toContain('id="inspector-fullscreen"');
    expect(html).toContain('id="inspector-artifacts" class="icon-button" type="button" title="Toggle inspector" aria-label="Toggle inspector"');
    expect(html).not.toContain('id="context-toggle"');
    expect(html).not.toContain('id="context-panel"');
    expect(html).not.toContain('id="inspector-resizer"');
    // The Inspector heading is gone; the panel is content only, and its tab
    // bar mounts into the workspace header above it.
    expect(inspectorPanel).not.toContain('id = "inspector-title"');
    expect(inspectorPanel).not.toContain('id = "inspector-location"');
    expect(inspectorPanel).not.toContain('id = "inspector-close"');
    expect(inspectorPanel).toContain("tabMount: HTMLElement");
    expect(renderer).toContain("tabMount: workspaceHeader");
    expect(inspectorPanel).toContain('className = "inspector-panel"');
    expect(inspectorPanel).toContain('className = "inspector-resizer"');
    expect(inspectorPanel).toContain('setAttribute("aria-label", "Inspector")');
    expect(renderer).not.toContain('item("Toggle environment"');
    expect(renderer).toContain('window.addEventListener("fitz:open-resource"');
    expect(renderer).toContain("inspectorPanel.inspect(reference)");
    expect(renderer).toContain("new InAppBrowser({ mount: inspectorPanel.element");
    expect(renderer).toContain("inspectorPanel.open(); void inAppBrowser.open(reference)");
    expect(inAppBrowser).toContain('className = "in-app-browser-viewport"');
    expect(styles).toContain(".in-app-browser { position: absolute; z-index: 4; inset: 0;");
    expect(renderer).toContain("inspectorPanel.toggle()");
    expect(renderer).not.toContain("inspectorPanel.toggleRepository()");
    // The header's raw↔rendered toggle is handed to the panel, which wires it
    // to whichever tab is active.
    expect(renderer).toContain('element("inspector-render-toggle")');
    expect(renderer).toContain("renderToggle: inspectorRenderToggle");
    expect(inspectorPanel).toContain("renderToggle: this.#options.renderToggle");
    expect(inspectorPanel).toContain("new ResourceInspector({");
    expect(resourceInspector).toContain("window.fitz.previewResource({ projectRoot, reference, searchRoots: this.#options.getSearchRoots() })");
    expect(resourceInspector).toContain("this.#resourceError(error, reference)");
    expect(resourceInspector).toContain("this.#render(this.#preview)");
    expect(resourceInspector).toContain('frame.setAttribute("sandbox", "allow-same-origin")');
    expect(styles).toContain(".inspector-panel");
    expect(styles).not.toContain(".workspace.inspector-open .messages { margin-right: var(--inspector-width); }");
    expect(styles).toContain(".inspector-resizer");
    expect(inspectorPanel).toContain('storageKey: "fitz-inspector-width"');
    expect(inspectorPanel).toContain("defaultValue: 400,");
    expect(inspectorPanel).toContain("minimum: 200,");
    expect(inspectorPanel).toContain("Math.max(200, options.mount.getBoundingClientRect().width - 280)");
    // The panel re-clamps on workspace resize so a shrunken window never
    // leaves it overspilling the conversation.
    expect(inspectorPanel).toContain("new ResizeObserver(() => this.clampWidth())");
    expect(inspectorPanel).toContain("this.#resizeObserver.observe(options.mount)");
    expect(inspectorPanel).toContain("clampWidth(): void");
    expect(renderer).not.toContain("Math.min(760");
    expect(resizablePane).toContain("restore(): void");
    expect(renderer).toContain('import { InspectorPanel } from "./ui/inspector/inspector-panel.js"');
    expect(inspectorPanel).toContain('import { ResourceInspector } from "./resource-inspector.js"');
    expect(resourceInspector).toContain('import { highlightSource } from "../../syntax-highlighting.js"');
    expect(markdown).toContain('import { highlightSource } from "./syntax-highlighting.js"');
    expect(markdown).toContain("code.innerHTML = highlighted.html");
    expect(syntaxHighlighting).toContain("hljs.highlight(source, { language, ignoreIllegals: true })");
    expect(resourceInspector).toContain("this.#withScrollbar(source)");
    expect(resourceInspector).toContain("html::-webkit-scrollbar-thumb");
    expect(resourceInspector).toContain('frame.addEventListener("load", () => this.#applyScrollbar(frame))');
    expect(resourceInspector).toContain('frame.setAttribute("sandbox", "allow-same-origin")');
    expect(styles).toContain("background: var(--grey-100); color-scheme: dark");
    expect(styles).toContain(":is(.inspector-source, .markdown-code) .hljs-keyword");
    expect(preload).toContain('ipcRenderer.invoke("fitz:preview-resource", input)');
    expect(main).toContain('ipcMain.handle("fitz:preview-resource"');
  });

  it("previews pasted images and PDFs from their composer chips in the Inspector", () => {
    expect(composer).toContain('item.type.startsWith("image/") ? "image" : item.type === "application/pdf" ? "pdf" : undefined');
    expect(composer).toContain("readPastedFile(file, kind)");
    expect(composer).toContain('chip.className = `attachment-chip ${kind === "image" ? "image-chip" : kind === "pdf" ? "pdf-chip" : "file-chip"}`;');
    expect(composer).toContain('preview.className = `attachment-preview ${kind === "pdf" ? "pdf-preview" : "image-preview"}`;');
    expect(composer).toContain('preview.title = kind === "pdf" ? "Preview PDF" : "Preview image";');
    expect(renderer).toContain("inspectorPanel.previewImage(dataUrl, mimeType, name)");
    expect(renderer).toContain("inspectorPanel.previewPdf(dataUrl, mimeType, name)");
    expect(renderer).toContain('name: attachment.kind === "image" ? `screenshot-${Date.now()}.png` : attachment.name');
    expect(composer).toContain('this.pastedFiles.push({ dataUrl, mimeType: file.type || (kind === "pdf" ? "application/pdf" : "application/octet-stream"), name, kind, chip })');
    expect(inspectorPanel).toContain("previewImage(dataUrl: string, mimeType: string, name: string): void");
    expect(inspectorPanel).toContain("previewPdf(dataUrl: string, mimeType: string, name: string): void");
    expect(resourceInspector).toContain("previewImage(dataUrl: string, mimeType: string, name: string): void");
    expect(resourceInspector).toContain("previewPdf(dataUrl: string, mimeType: string, name: string): void");
    expect(resourceInspector).toContain('img.className = "inspector-media"');
    expect(resourceInspector).toContain("frame.src = this.#objectUrl(response.body, artifact.mimeType)");
    expect(resourceInspector).toContain('frame.src = this.#objectUrl(this.#base64FromDataUrl(dataUrl), mimeType)');
    // Pasted and attached PDFs are framed as blob URLs; the CSP must allow them.
    expect(html).toContain('frame-src data: blob: https: http:');
    expect(main).toContain("plugins: true");
    expect(composerCss).toContain(".image-chip .attachment-preview { display: block; padding: 0; border-radius: 10px; cursor: zoom-in; }");
    expect(composerCss).toContain(".image-chip .attachment-preview:hover img, .image-chip .attachment-preview:focus-visible img");
    expect(composerCss).toContain(".pdf-chip .attachment-preview { display: grid; grid-template-rows: 1fr auto; place-items: center; gap: 3px; padding: 8px; text-align: center; cursor: zoom-in; }");
    expect(composerCss).toContain(".pdf-chip .attachment-preview svg");
    expect(composerCss).toContain(".pdf-chip .pdf-name");
  });

  it("previews binary project files (images, PDFs, audio, and video) in the Inspector", () => {
    // The main-process preview resolves binary files to base64 with a MIME-aware size bound from the shared helper.
    expect(resourcePreview).toContain('maxPreviewBytes');
    expect(resourcePreview).toContain('"image" | "pdf" | "audio" | "video"');
    expect(resourcePreview).toContain('IMAGE_EXTENSIONS');
    expect(resourcePreview).toContain('mimeTypeFor(filePath)');
    expect(resourcePreview).toContain('base64: bytes.toString("base64")');
    // The Inspector renders images inline, frames PDFs as blob URLs, and plays audio/video with controls.
    expect(resourceInspector).toContain('preview.kind === "image"');
    expect(resourceInspector).toContain('img.src = `data:${preview.mimeType ?? "image/png"};base64,${preview.base64 ?? ""}`');
    expect(resourceInspector).toContain('preview.kind === "pdf"');
    expect(resourceInspector).toContain('frame.src = this.#objectUrl(preview.base64 ?? "", preview.mimeType ?? "application/pdf")');
    expect(resourceInspector).toContain('preview.kind === "audio" || preview.kind === "video"');
    expect(resourceInspector).toContain('node.controls = true');
    expect(styles).toContain("img.inspector-media { padding: 16px 20px 24px; }");
    expect(preload).toContain('"image" | "pdf" | "audio" | "video"');
  });

  it("keeps the artifact repository as the panel's home view behind the header sidebar button", () => {
    // The repository is a dedicated view, not a tab: it renders once into the
    // panel and is the home view when nothing is open. The header's sidebar
    // button toggles the panel open and closed, keeping the open doc.
    expect(inspectorPanel).toContain('className = "inspector-tabs"');
    expect(inspectorPanel).toContain('setAttribute("role", "tablist")');
    expect(inspectorPanel).toContain('closable: true');
    expect(inspectorPanel).toContain('className = "inspector-tab-close"');
    expect(inspectorPanel).toContain("toggle(): void");
    expect(inspectorPanel).not.toContain("toggleRepository(): void");
    expect(inspectorPanel).not.toContain("newTab(): void");
    expect(inspectorPanel).toContain("this.#repository.render(repositoryView)");
    expect(inspectorPanel).toContain("setSessionArtifacts(artifacts: Json[]): void");
    expect(inspectorPanel).toContain("reset(): void");
    expect(inspectorPanel).toContain("setChat(sessionId: string | undefined): void");
    expect(inspectorPanel).toContain("registerReference(reference: string): void");
    // Files open from chat links and tool rows grow the persisted repository.
    expect(artifactRepository).toContain('fitz-inspector-repository');
    expect(artifactRepository).toContain("useStorage(storageKey: string): void");
    expect(artifactRepository).toContain("registerFile(path: string, name: string, reference?: string): void");
    expect(artifactRepository).toContain("registerReference(reference: string): void");
    expect(artifactRepository).toContain("setSessionArtifacts(artifacts: Json[]): void");
    expect(artifactRepository).toContain("onOpenFile");
    expect(artifactRepository).toContain("onOpenArtifact");
    expect(artifactRepository).toContain("getProjectRoot");
    expect(artifactRepository).toContain("projectRelativePath");
    // The renderer feeds current-session uploads into the repository.
    expect(artifactController).toContain("this.#options.setSessionArtifacts(artifacts)");
    // The Inspector is contained to the chat it was opened in: switching
    // chats or projects closes it and drops its tabs, and the artifact
    // repository re-scopes to the new session (per-chat storage key) without
    // forcing the panel open.
    expect(conversationSession).toContain("#inspectorChatId: string | undefined;");
    expect(conversationSession).toContain("if (sessionId !== this.#inspectorChatId) this.#scopeInspector(sessionId, true)");
    expect(inspectorPanel).toContain("fitz-inspector-repository:${sessionId}");
    // A brand-new chat's first message points the repository at its session
    // before any files stream in, so the first files land in the right chat.
    expect(conversationSession).toContain("this.#scopeInspector(response.data.id, false)");
    expect(renderer).not.toContain("inspectorPanel.resetPreview()");
    // Every opened artifact gets its own closable tab.
    expect(inspectorPanel).toContain("onFileInspected: (path, name, reference) => this.#onFileInspected(tab.id, path, name, reference)");
    expect(inspectorPanel).toContain("this.#repository.registerFile(path, name, reference)");
    expect(inspectorPanel).toContain('`upload:${String(artifact.id)}`');
    // The tab tooltip shows the project-relative path instead of the absolute one.
    expect(inspectorPanel).toContain("projectRelativePath(path, this.#options.getProjectRoot())");
    // Files register as soon as they render in chat, without a click.
    expect(markdown).toContain('"fitz:resource-appeared"');
    expect(renderer).toContain('window.addEventListener("fitz:resource-appeared"');
    expect(renderer).toContain("inspectorPanel.registerReference(reference)");
    // Middle-click (the mouse wheel button) closes artifact tabs.
    expect(inspectorPanel).toContain("auxclick");
    expect(inspectorPanel).toContain("event.button === 1");
    expect(inspectorPanel).toContain("mousedown");
    // Chat references are cleaned of stray delimiters before joining the repo.
    expect(markdown).toContain("export function normalizeResourceReference");
    expect(artifactRepository).toContain("normalizeResourceReference(reference)");
    expect(styles).toContain(".inspector-tabs");
    expect(styles).toContain(".inspector-tab.active");
    expect(styles).toContain(".inspector-tab-close");
    expect(styles).toContain(".inspector-tabpanel");
    expect(styles).toContain(".inspector-repository");
    expect(styles).toContain(".inspector-repository-item");
  });

  it("keeps the Inspector/Composer project-root callbacks null-safe during module load", () => {
    // The artifact repository renders synchronously inside InspectorPanel's
    // constructor, which fires `getProjectRoot` before `projects` is declared
    // below (esbuild hoists `const` to `var`, so a missing `?.` becomes a
    // TypeError at startup that freezes the whole window). Both callbacks must
    // stay null-safe so construction cannot dereference the not-yet-assigned
    // controller.
    expect(renderer).toContain('getProjectRoot: () => String(projects?.activeProject()?.rootPath ?? ""),');
    expect(renderer).toContain('getProjectRoot: () => String(projects?.activeProject()?.rootPath ?? "") || undefined,');
  });

  it("stages picker files as chips in a new chat and uploads them with the first message", () => {
    // The attach button unlocks in new chat mode so "+" works before a session exists.
    expect(renderer).toContain('hasSession: Boolean(projects.currentSessionId || conversationSessions.newChat)');
    expect(artifactController).toContain('this.#options.showStatus("Create or select a task before attaching a file", "error")');
    expect(artifactController).toContain("this.#options.stageFile(file)");
    expect(composer).toContain("attachFile(file: File): void");
    expect(composer).toContain('const kind = file.type.startsWith("image/") ? "image" : file.type === "application/pdf" ? "pdf" : "file";');
    expect(composer).toContain('this.options.onError("Attached file is too large (max 5 MB)");');
    expect(composerCss).toContain(".file-chip .file-chip-body");
  });

  it("keeps generated media out of composer attachments and animates media progress", () => {
    expect(artifactController).toContain("this.#options.stageFile(file)");
    expect(artifactController).not.toContain("this.#options.addChip(artifact.name");
    expect(mediaJobFeed).toContain("if (wasTracked && this.#terminal(job.status)) this.#options.finishWork");
    expect(mediaJobFeed).toContain("this.#options.appendWork(row, job.startedAt ?? job.enqueuedAt)");
    expect(mediaJobFeed).toContain("this.#options.appendAssistant(this.#terminalMessage(job)");
    expect(mediaJobFeed).toContain('answer.classList.add("media-result-message")');
    expect(styles).toContain("animation: run-activity-spinner 900ms linear infinite");
    expect(styles).toContain(".media-result-message > .media-job-notice { margin: 0; }");
    expect(styles).not.toContain("animation: spin 900ms linear infinite");
  });

  it("embeds the pre-submission media creation card in the chat for media commands", () => {
    expect(renderer).toContain('const mediaCreationForm = new MediaCreationForm({ messages })');
    expect(renderer).toContain("mediaCreationForm.show({ modality, prompt, refs, onCreate: submit })");
    expect(renderer).toContain('api("/api/v1/media/jobs", "POST"');
    // Every form-collected parameter must reach the job: duration/fps/size/seed/
    // negative prompt are otherwise silently dropped and the engine falls back to
    // its recipe defaults (e.g. a 2 s / 24 fps video for a requested 10 s @ 30 fps).
    expect(renderer).toContain("...(size !== undefined ? { size } : {})");
    expect(renderer).toContain("...(seed !== undefined ? { seed } : {})");
    expect(renderer).toContain("...(negativePrompt !== undefined ? { negativePrompt } : {})");
    expect(renderer).toContain("...(durationSeconds !== undefined ? { durationSeconds } : {})");
    expect(renderer).toContain("...(fps !== undefined ? { fps } : {})");
    expect(renderer).toContain("mediaJobFeed.render({ id: jobId, modality, status: \"queued\" })");
    expect(renderer).toContain("mediaJobs.watch(jobId)");
  });

  it("always opens the local workspace and treats remote Fitz hosts as inference connections", () => {
    for (const id of ["pairing-page", "host-connection-form", "host-connection-url", "host-connection-api-key", "setup-local-host", "pairing-error", "connection-status"]) expect(html).not.toContain(`id="${id}"`);
    for (const channel of ["fitz:connect-remote", "fitz:configure-host", "fitz:connection-info", "fitz:local-request", "fitz:bootstrap-local-device"]) {
      expect(main).not.toContain(channel);
      expect(preload).not.toContain(channel);
    }
    expect(main).toContain('const hostUrl = validateHostUrl(localHostPort ? `http://127.0.0.1:${localHostPort}` : "http://127.0.0.1:8787")');
    expect(main).not.toContain("FITZ_HOST_URL");
    expect(main).not.toContain('commandLineValue("host-url")');
    expect(renderer).toContain("appNavigation.showConversation();\nvoid initialize();");
    expect(renderer).toContain('setStatus("Starting local services", "loading")');
    expect(renderer).not.toContain('setStatus("Offline"');
    expect(renderer).not.toContain("showPairing");
    expect(main).toContain("migrateLegacyRemoteHostConnection()");
    expect(main).toContain('template: "openai-compatible"');
    expect(main).toContain('executionClass: "self_hosted"');
    expect(preload).toContain('ipcRenderer.invoke("fitz:consumer-connection-save"');
    expect(main).toContain("safeStorage.encryptString(token)");
    expect(main).toContain("safeStorage.decryptString");
    expect(main).toContain("legacyConsumerConnectionsPath");
    expect(main).toContain('renameSync(legacyPath, `${legacyPath}.migrated`)');
    expect(styles).not.toContain(".pairing-page");
  });

  it("surfaces actionable cloud-connection errors without Electron IPC boilerplate", () => {
    expect(main).toContain('typeof parsed.error === "string"');
    expect(renderer).toContain("Error invoking remote method");
    expect(renderer).toContain(".replace(");
  });

  it("provides inline Hosting controls for users, API keys, usage, quotas, and tools", () => {
    for (const id of ["administration-page", "hosting-enabled", "create-user-form", "hosted-user-result", "admin-users", "usage-dashboard", "tool-policy-form", "tool-policies", "admin-audit-events", "admin-trash", "admin-snapshots", "admin-tool-actions", "empty-trash-button", "gc-retention-button"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(administrationPage).toContain('api("/api/v1/management/hosting/users", "POST"');
    expect(administrationPage).toContain('api("/api/v1/management/users")');
    expect(administrationPage).toContain('api("/api/v1/management/user-usage")');
    expect(administrationPage).toContain('api("/api/v1/management/tool-policies")');
    expect(administrationPage).toContain('api("/api/v1/management/audit-events?limit=50")');
    expect(administrationPage).toContain('api("/api/v1/management/trash")');
    expect(administrationPage).toContain('api("/api/v1/management/snapshots")');
    expect(administrationPage).toContain('api("/api/v1/management/tool-actions?limit=100")');
    expect(administrationPage).toContain("this.safetyRecovery.renderTrash");
    expect(administrationPage).toContain("this.safetyRecovery.renderSnapshots");
    expect(administrationPage).toContain("this.safetyRecovery.renderToolActions");
    expect(safetyRecoveryController).toContain('api("/api/v1/management/trash", "DELETE")');
    expect(safetyRecoveryController).toContain('api("/api/v1/management/trash/gc", "POST", { maxAgeDays: 30 })');
    expect(administrationPage).toContain("Local Default is available to every user");
    expect(administrationPage).toContain('/routes`, "PUT", { routeIds }');
    expect(administrationPage).toContain('input.dataset.mediaRoute = route.id');
    expect(administrationPage).toContain('/quota`, "PUT", quota');
    expect(administrationPage).toContain('revokeAdminDevice(device.id)');
    expect(html).toContain('id="administration-sections"');
    expect(styles).toContain(".tool-policy");
    expect(html).toContain('id="select-popover"');
    expect(renderer).toContain("new CustomSelectController(overlayHost, selectPopover, closePopovers)");
    expect(customSelect).toContain('document.querySelectorAll<HTMLSelectElement>("select").forEach(this.enhance)');
    expect(customSelect).toContain("open(select: HTMLSelectElement");
    expect(styles).toContain(".select-popover .select-option.selected::after");
    expect(styles).toContain("background-position: right 9px center");
  });

  it("keeps advanced Hosting sections collapsible", () => {
    expect(html).toContain('class="collapsible-toggle"');
    expect(html).toContain('data-collapsible-key="hosting-advanced"');
    expect(html).toContain('data-collapsible-key="policies"');
    expect(html).toContain('data-collapsible-key="safety"');
    expect(html).toContain('data-collapsible-key="storage"');
    expect(html).toContain('data-collapsible-key="diagnostics"');
    expect(html).toContain('data-collapsible-key="updates"');
    expect(html).toContain('data-collapsible-key="activity"');
    expect(html).toContain('id="hosting-advanced-body"');
    expect(administrationPage).toContain('fitz-collapsed-admin-sections');
    expect(administrationPage).toContain('CollapsibleSection.adoptAll(this.elements.sections, { storageKey: "fitz-collapsed-admin-sections" })');
    expect(administrationPage).toContain('import { CollapsibleSection } from "../layout/collapsible-section.js"');
    expect(renderer).toContain("sections: administrationPage");
    expect(collapsibleSection).toContain("static adopt(");
    expect(collapsibleSection).toContain("static adoptAll(");
    expect(styles).toContain(".collapsible-toggle");
    expect(styles).toContain(".collapsible-section.collapsed .collapsible-chevron { transform: rotate(-90deg); }");
    expect(styles).toContain(".collapsible-section.collapsed .collapsible-body { display: none; }");
  });

  it("keeps shared shell behavior behind reusable component boundaries", () => {
    expect(renderer).toContain('import { ResizablePane } from "./ui/primitives/resizable-pane.js"');
    expect(renderer).toContain('import { ConversationLayout } from "./ui/layout/conversation-layout.js"');
    expect(renderer).toContain('import { WorkspacePageController } from "./ui/layout/workspace-pages.js"');
    expect(renderer).toContain('import { AppNavigationController } from "./ui/navigation/app-navigation.js"');
    expect(renderer).toContain('import { CustomSelectController } from "./ui/primitives/custom-select.js"');
    expect(projectSidebar).toContain('import { ContextMenu } from "../primitives/context-menu.js"');
    expect(renderer).toContain('import { AdministrationPageController } from "./ui/administration/administration-page.js"');
    expect(renderer).toContain('import { ProjectsController } from "./ui/projects/projects.js"');
    expect(renderer).toContain('import { PlaybookWorkspaceController } from "./ui/playbooks/playbook-workspace.js"');
    expect(workspacePages).toContain('element.hidden = name !== page');
    expect(workspacePages).toContain('classList.toggle("active", name === page)');
    expect(workspacePages).toContain('setConversationInert(page !== "conversation")');
    expect(resizablePane).toContain('localStorage.setItem(this.#options.storageKey');
    expect(resizablePane).toContain('setAttribute("aria-valuenow"');
    expect(contextMenu).toContain("openBeside(anchor: HTMLElement");
    expect(contextMenu).toContain('button.classList.toggle("danger"');
  });

  it("composes every management tab from the shared layout component", () => {
    expect(renderer).toContain('import { ManagementPageLayout, managementRefreshIcon } from "./ui/layout/management-page.js"');
    expect(renderer).toContain("new ManagementPageLayout(playbookPage");
    expect(renderer).toContain("new ManagementPageLayout(pluginsPage");
    expect(renderer).toContain("new ManagementPageLayout(administrationPage");
    expect(connectionWorkspace).toContain("new ManagementPageLayout(this.root");
    expect(html).not.toContain('class="management-page-header"');
    expect(html).not.toContain('class="management-page-tabs"');
    expect(html).not.toContain('class="management-actions"');
    expect(html).not.toContain('class="management-page-content"');
    expect(html).not.toContain('class="management-search"');
    expect(styles).toContain(".management-search { height: 40px;");
    expect(styles).toContain("border-radius: 20px; background: var(--new-chat-base)");
    expect(styles).not.toContain(".plugin-page-tabs");
    expect(styles).not.toContain(".plugin-content");
    expect(styles).not.toContain(".administration-content");
    expect(managementPage).toContain('className = "management-page-header"');
    expect(managementPage).toContain('className = "management-page-tabs"');
    expect(managementPage).toContain('className = "management-actions"');
    expect(managementPage).toContain('className = "management-page-content"');
    expect(managementPage).toContain("addContent(options: ManagementPageContentOptions)");
    expect(managementPage).toContain("setActiveTab(id: string): void");
  });

  it("renders and exports host-redacted diagnostics from the administration workspace", () => {
    for (const id of ["diagnostic-summary", "diagnostic-metrics", "diagnostic-failures", "export-diagnostics"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(administrationPage).toContain('api("/api/v1/management/diagnostics")');
    expect(administrationPage).toContain("this.diagnostics.render(diagnostics)");
    expect(diagnosticsController).toContain("saveDiagnostics(JSON.stringify(this.#bundle, null, 2))");
    expect(preload).toContain('ipcRenderer.invoke("fitz:save-diagnostics", content)');
    expect(main).toContain('ipcMain.handle("fitz:save-diagnostics"');
    expect(main).toContain("content.length > 10_000_000");
    expect(styles).toContain(".diagnostic-summary");
    expect(styles).toContain(".diagnostic-row");
  });

  it("owns Tailscale Funnel behind one Hosting switch", () => {
    for (const id of ["hosting-enabled", "hosting-state-label", "hosting-public-url", "repair-hosting", "hosting-advanced-status"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(hostingPageController).toContain('api("/api/v1/management/hosting", "PUT", { enabled })');
    expect(hostingPageController).toContain('api("/api/v1/management/hosting/repair", "POST", {})');
    expect(hostingPageController).not.toContain("tailscale-serve");
    expect(styles).toContain(".hosting-switch");
  });

  it("shows desktop update state, progress, checks, and restart installation inline", () => {
    for (const id of ["check-desktop-update", "install-desktop-update", "desktop-update-label", "desktop-update-progress"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(desktopUpdateController).toContain("updateStatus(): Promise<DesktopUpdateStatus>");
    expect(desktopUpdateController).toContain(".then((update) => this.render(update))");
    expect(desktopUpdateController).toContain("Downloading update · ${Math.round(percent)}%");
    expect(preload).toContain('ipcRenderer.invoke("fitz:update-status")');
    expect(main).toContain('autoUpdater.on("download-progress"');
    expect(main).toContain('publishUpdateStatus({ state: "development" })');
    expect(styles).toContain(".desktop-update-track");
  });

  it("keeps startup and canonical JSON in Hosting advanced settings", () => {
    for (const id of ["hosting-start-at-login", "hosting-config-path", "hosting-config-json", "validate-hosting-config", "save-hosting-config"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(hostingPageController).toContain('api("/api/v1/management/config", "PATCH", { hosting: { startAtLogin } })');
    expect(hostingPageController).toContain('api("/api/v1/management/config/validate", "POST", parsed)');
    expect(styles).toContain(".hosting-config-editor");
  });
});
