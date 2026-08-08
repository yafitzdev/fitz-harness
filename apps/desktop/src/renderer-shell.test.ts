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
const messageActions = readFileSync(new URL("./ui/chat/message-actions.ts", import.meta.url), "utf8");
const activityTimeline = readFileSync(new URL("./ui/chat/activity-timeline.ts", import.meta.url), "utf8");
const toolActivity = readFileSync(new URL("./ui/chat/tool-activity.ts", import.meta.url), "utf8");
const reasoningView = readFileSync(new URL("./ui/chat/reasoning-view.ts", import.meta.url), "utf8");
const agentRunController = readFileSync(new URL("./ui/chat/agent-run-controller.ts", import.meta.url), "utf8");
const composerControls = readFileSync(new URL("./ui/chat/composer-controls.ts", import.meta.url), "utf8");
const composer = readFileSync(new URL("./ui/chat/composer.ts", import.meta.url), "utf8");
const connectionWorkspace = readFileSync(new URL("./ui/connections/connection-workspace.ts", import.meta.url), "utf8");
const pluginCatalog = readFileSync(new URL("./ui/plugins/plugin-catalog.ts", import.meta.url), "utf8");
const administrationPage = readFileSync(new URL("./ui/administration/administration-page.ts", import.meta.url), "utf8");
const playbookWorkspace = readFileSync(new URL("./ui/playbooks/playbook-workspace.ts", import.meta.url), "utf8");
const resourceInspector = readFileSync(new URL("./ui/inspector/resource-inspector.ts", import.meta.url), "utf8");
const inspectorPanel = readFileSync(new URL("./ui/inspector/inspector-panel.ts", import.meta.url), "utf8");
const artifactRepository = readFileSync(new URL("./ui/inspector/artifact-repository.ts", import.meta.url), "utf8");
const resourcePreview = readFileSync(new URL("./resource-preview.ts", import.meta.url), "utf8");
const projectSidebar = readFileSync(new URL("./ui/sidebar/project-sidebar.ts", import.meta.url), "utf8");
const projects = readFileSync(new URL("./ui/projects/projects.ts", import.meta.url), "utf8");
const composerCss = readFileSync(new URL("./ui/chat/composer.css", import.meta.url), "utf8");
const styles = [
  readFileSync(new URL("./renderer/styles.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/theme/tokens.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/primitives/scroll-surface.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/message-actions.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/activity-timeline.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/reasoning-view.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/chat/composer-controls.css", import.meta.url), "utf8"),
  composerCss,
  readFileSync(new URL("./ui/connections/connection-workspace.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/plugins/plugin-catalog.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/administration/administration-page.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/playbooks/playbook-workspace.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/sidebar/project-sidebar.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/inspector/inspector-panel.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/layout/management-page.css", import.meta.url), "utf8"),
  readFileSync(new URL("./ui/layout/collapsible-section.css", import.meta.url), "utf8"),
].join("\n");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

describe("desktop renderer shell", () => {
  it("wires every visible shell action to a renderer interaction", () => {
    const rendererActions = [
      "sidebar-menu",
      "sidebar-resizer",
      "new-session",
      "manage-playbooks",
      "new-project",
      "connection-status",
      "context-toggle",
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

  it("uses one integrated title bar with functional window and application menus", () => {
    expect(html).toContain('class="app-titlebar drag-region"');
    expect(html).toContain('class="titlebar-navigation"');
    expect(html).not.toContain('class="titlebar-navigation no-drag"');
    expect(styles).toContain(".no-drag, button, select, textarea, input { -webkit-app-region: no-drag; }");
    expect(html).toContain('class="workspace-header"');
    expect(html).not.toContain('class="workspace-header drag-region"');
    expect(html).toContain('data-app-menu="File"');
    expect(html).toContain('data-window-action="minimize"');
    expect(main).toContain("frame: false");
    expect(html).toContain('id="app-menu-popover"');
    expect(renderer).toContain("function openAppMenu(");
    expect(main).toContain('ipcMain.handle("fitz:edit-command"');
    expect(main).not.toContain('ipcMain.handle("fitz:show-menu"');
    expect(main).toContain('ipcMain.handle("fitz:window-action"');
    expect(main).not.toContain("window.getBounds()");
    expect(styles).toContain("grid-template-rows: 32px minmax(0, 1fr)");
    expect(html).not.toContain('id="sidebar-restore"');
  });

  it("maps mouse back and forward buttons to Fitz navigation history", () => {
    expect(main).toContain('window.on("app-command"');
    expect(main).toContain('command === "browser-backward"');
    expect(main).toContain('command === "browser-forward"');
    expect(main).toContain('window.webContents.send("fitz:navigation-command", "back")');
    expect(preload).toContain('onNavigationCommand(listener: (command: "back" | "forward")');
    expect(preload).toContain('ipcRenderer.on("fitz:navigation-command", handler)');
    expect(renderer).toContain('window.fitz.onNavigationCommand((command) => void navigateHistory');
    expect(renderer).toContain('type AppLocation = { view: "conversation"');
    expect(renderer).toContain('navigationHistory.splice(navigationIndex + 1)');
    expect(renderer).toContain('async function navigateHistory(offset: -1 | 1)');
  });

  it("keeps every management workspace on one stable scrollbar-aware axis", () => {
    expect(styles).toContain("--management-content-width: 900px");
    expect(styles).toContain("scrollbar-gutter: stable both-edges");
    expect(styles).toContain("width: min(var(--management-content-width), calc(100% - 48px))");
    expect(styles).toContain("--codex-scrollbar-size: 10px");
    expect(styles).toContain("width: var(--codex-scrollbar-size)");
    expect(styles).toContain("height: var(--codex-scrollbar-size)");
    expect(styles).toContain("background-clip: content-box");
    expect(styles).toContain(".management-page-content > p { margin: 5px 0 24px; overflow: hidden; color: var(--muted); font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }");
    expect(styles).not.toContain(".management-page-content { width: min(820px");
  });

  it("matches the compact Codex sidebar and new-chat project rail", () => {
    expect(html).not.toContain('class="runtime-mode-toggle"');
    expect(html).toContain('<span>Codex</span>');
    expect(renderer).toContain("new ProjectSidebarController");
    expect(projectSidebar).toContain('this.#treeItem(session.title, "task-row", undefined');
    expect(renderer).not.toContain("function chatIcon()");
    expect(styles).toContain("height: 42px; display: flex; align-items: center");
    expect(html).toContain('class="section-heading projects-heading"');
    expect(styles).toContain(".projects-heading #new-project { opacity: 0; pointer-events: none;");
    expect(styles).toContain(".projects-heading > span { color: #c8cbc5; font-weight: 650; }");
    expect(styles).toContain(".task-row { padding: 6px 34px 6px 30px;");
    expect(renderer).toContain('identity.data?.authMode === "disabled" || identity.data?.user?.role === "administrator"');
    expect(html).toContain('d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"');
  });

  it("shows playbooks and securely stored OpenAI-compatible connections together", () => {
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
    expect(connectionWorkspace).toContain('consumerFixedRouteId');
    expect(connectionWorkspace).toContain('const LOCAL_CONNECTION_ID = "hosted--local"');
    expect(renderer).not.toContain('connectionWorkspace.selectedConnectionId');
    expect(renderer).toContain('routeId: composer.controls.routeId as FixedRouteId');
    expect(renderer).not.toContain('candidate.routeId === card.id');
    expect(connectionWorkspace).toContain('testRecipe({ id: model.recipeId');
    expect(connectionWorkspace).toContain("private views(): ConnectionView[]");
    expect(connectionWorkspace).toContain('id: LOCAL_CONNECTION_ID');
    expect(connectionWorkspace).toContain('this.configuration?.hostName ?? "This PC"');
    expect(renderer).not.toContain('configuredConnectionId');
    expect(renderer).not.toContain('edit.textContent = configuredConnectionId');
    expect(connectionWorkspace).toContain('for (const model of connection.availableModels)');
    expect(connectionWorkspace).toContain('const routeId = definition.id');
    expect(connectionWorkspace).toContain('this.assignRoute(definition, model, button)');
    expect(connectionWorkspace).toContain('if (!connection.hosted)');
    expect(connectionWorkspace).not.toContain('url.className = "connection-url"');
    expect(connectionWorkspace).toContain("Provider and self-hosted OpenAI-compatible APIs.");
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
    expect(renderer).toContain('{ id: "llm-tab", label: "LLMs", dataset: { pipeline: "text-generation" }, active: true }');
    expect(renderer).toContain('{ id: "vision-tab", label: "Vision", dataset: { pipeline: "image-text-to-text" } }');
    expect(renderer).toContain('{ id: "audio-tab", label: "Audio", dataset: { pipeline: "automatic-speech-recognition" } }');
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
    expect(main).toContain('ensureBundledLocalHost');
    expect(main).toContain('join(process.resourcesPath, "host")');
  });

  it("opens Playbooks as a first-class searchable workspace page", () => {
    expect(html).toContain('id="playbook-page"');
    expect(html).not.toContain('data-management-view=');
    expect(renderer).toContain('search: { id: "playbook-search"');
    expect(renderer).toContain('id: "management-browser"');
    expect(renderer).toContain("openPlaybookPage()");
    expect(playbookWorkspace).toContain("render(): void");
    expect(renderer).toContain("FIXED_ROUTES");
    expect(renderer).not.toContain("assignFixedRoute(");
    expect(playbookWorkspace).toContain('Configure and test recipes from your engine folders.');
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
    expect(renderer).toContain("showConversationWorkspace()");
  });

  it("tests each Playbooks recipe directly and reports the result on its row", () => {
    expect(playbookWorkspace).toContain('testButton.className = "recipe-test-button"');
    expect(playbookWorkspace).toContain('api(`/api/v1/management/recipes/${encodeURIComponent(recipe.id)}/test`, "POST")');
    expect(playbookWorkspace).toContain('state === "passed" ? "✓ Working"');
    expect(playbookWorkspace).toContain('state === "failed" ? "Retry"');
    expect(playbookWorkspace).toContain('detail: "Sending “Say hi.” to this recipe"');
    expect(playbookWorkspace).toContain('modelLabel.className = "recipe-card-label"');
    expect(playbookWorkspace).toContain('contextLabel.className = "recipe-card-label recipe-context-label"');
    expect(playbookWorkspace).not.toContain('detail.textContent = `${recipe.adapter} · ${recipe.modelId}`');
    expect(styles).toContain(".recipe-test-button");
    expect(styles).toContain(".recipe-test-button.passed");
    expect(styles).toContain(".recipe-card-label {");
  });

  it("exposes working keyboard, retry, attachment, and cancellation paths", () => {
    expect(composer).toContain('event.key === "Enter"');
    expect(renderer).toContain('connectionStatus.addEventListener("click"');
    expect(renderer).toContain("artifactFile.click()");
    expect(renderer).toContain('api(`/api/v1/artifacts/${artifact.id}`, "DELETE")');
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
    expect(renderer).toContain("sessionTokenEstimate += estimateTokens");
    expect(projects).toContain('this.options.api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" })');
    expect(renderer).toContain("max_tokens: composer.controls.maxTokens");
    expect(renderer).toContain("if (content.trim().length > 0) void steerPrompt(content)");
    expect(renderer).toContain("else void agentRuns.cancel()");
    expect(renderer).toContain("activityTimeline.appendSteer(content)");
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

    expect(renderer).toContain('newChatProjectDetached = true');
    expect(composer).toContain("this.options.bridge.gitBranches(rootPath)");
    expect(composer).toContain("this.options.bridge.checkoutBranch(rootPath, branch)");
    expect(composer).toContain("this.options.bridge.createBranch(rootPath, branch)");
    expect(composer).toContain("this.options.bridge.createWorktree(rootPath, branch)");
    expect(main).toContain('ipcMain.handle("fitz:git-branches"');
    expect(main).toContain('ipcMain.handle("fitz:git-checkout-branch"');
    expect(main).toContain('ipcMain.handle("fitz:git-create-branch"');
    expect(main).toContain('ipcMain.handle("fitz:git-create-worktree"');
    expect(composerCss).toContain("bottom: 100%");
    expect(composerCss).not.toContain("bottom: calc(100% - 12px)");
  });

  it("renders durable Codex-style agent activity with tool-specific symbols", () => {
    expect(agentRunController).toContain("this.#options.activity.appendTool(toolName, input, toolCallId");
    expect(agentRunController).toContain("this.#options.activity.completeTool");
    expect(activityTimeline).toContain('summary.type = "button"');
    expect(activityTimeline).toContain('this.#detail("Input", input');
    expect(activityTimeline).toContain('this.#detail("Result"');
    expect(activityTimeline).toContain('summary.setAttribute("aria-expanded", String(open))');
    expect(renderer).toContain("entry.content?.result");
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
    expect(activityTimeline).toContain("appendReasoning(running: boolean): HTMLElement");
    expect(activityTimeline).toContain("new ReasoningView(running)");
    expect(activityTimeline).toContain("?.appendDelta(text)");
    expect(activityTimeline).toContain("?.complete()");
    expect(reasoningView).toContain("export class ReasoningView");
    expect(reasoningView).toContain('className = "reasoning-content"');
    expect(reasoningView).toContain('label.textContent = running ? "Thinking…" : "Thought through the approach"');
    expect(renderer).toContain('entry.kind === "reasoning"');
    expect(renderer).toContain("activityTimeline.appendReasoning(false)");
    expect(styles).toContain(".reasoning-content");
    expect(styles).toContain(".reasoning-activity .agent-activity-label { font-style: italic; }");
  });

  it("collapses completed Pi activity behind a durable work summary", () => {
    expect(renderer).toContain("activityTimeline.finishWork(createdAt)");
    expect(activityTimeline).toContain("this.#ensureWork(createdAt)");
    expect(activityTimeline).toContain('label.textContent = `Worked for ${this.#formatElapsed(endedAt - work.startedAt)}`');
    expect(activityTimeline).toContain('row.className = "message context-activity"');
    expect(styles).toContain(".work-summary-toggle");
    expect(styles).toContain(".context-activity");
  });

  it("renders streamed assistant Markdown safely while keeping prompts plain", () => {
    expect(renderer).toContain('import { appendMarkdown, setMarkdown } from "./markdown.js"');
    expect(renderer).toContain("appendAssistantDelta: (target, delta) => appendMarkdown(target, delta)");
    expect(renderer).toContain('if (role === "assistant" || role === "commentary") setMarkdown(content, text); else content.textContent = text');
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
    expect(renderer).toContain('if (role === "assistant" || role === "commentary") setMarkdown(content, text); else content.textContent = text');
  });

  it("reveals compact Copy and user Edit actions on message hover", () => {
    expect(renderer).toContain("messageActions.attach(article, content");
    expect(renderer).toContain("copyText: (text) => window.fitz.copyText(text)");
    expect(messageActions).toContain("this.#copyButton(content)");
    expect(messageActions).toContain("createCopyButton({");
    expect(messageActions).toContain('this.#actionButton("Edit message"');
    expect(messageActions).toContain('time.className = "message-time"');
    expect(messageActions).toContain("this.#formatTimestamp(createdAt)");
    expect(styles).toContain(".message:hover .message-actions");
    expect(styles).toContain(".message.assistant .message-actions");
    expect(styles).not.toContain(".message.commentary .message-actions");
    expect(renderer).toContain('if (["user", "assistant"].includes(role))');
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
    expect(styles).toContain("padding: 32px 0 calc(var(--composer-height) + 44px)");
    expect(styles).toContain("top: 50px; bottom: 0; left: 0; width: var(--conversation-viewport)");
    expect(styles).toContain(".messages > * { grid-column: 2; }");
    expect(styles).toContain("left: var(--conversation-gutter)");
    expect(styles).toContain("bottom: 12px");
    expect(composerCss).toContain(".composer-dock::before");
    expect(composerCss).toContain("inset: var(--codex-radius-3xl) 0 -12px");
    expect(styles).toContain("--conversation-scrollbar: 0px");
    expect(styles).toContain(".workspace.inspector-open { --conversation-viewport: calc(100% - var(--inspector-width))");
    expect(renderer).toContain("new ConversationLayout({");
    expect(conversationLayout).toContain("new ResizeObserver(this.sync)");
    expect(conversationLayout).toContain("this.#resizeObserver.observe(target)");
    expect(conversationLayout).toContain("messages.offsetWidth - messages.clientWidth");
    expect(conversationLayout).toContain('workspace.style.setProperty("--conversation-viewport", `${viewportWidth}px`)');
    expect(conversationLayout).toContain('workspace.style.setProperty("--conversation-width", `${conversationWidth}px`)');
    expect(conversationLayout).toContain('workspace.style.setProperty("--conversation-gutter", `${gutter}px`)');
    expect(conversationLayout).toContain("composer.offsetHeight");
    expect(composer).toContain('id="scroll-to-bottom"');
    expect(conversationLayout).toContain('options.messages.addEventListener("scroll", this.updateScrollButton');
    expect(conversationLayout).toContain('messages.scrollTo({ top: this.#options.messages.scrollHeight, behavior: "smooth" })');
    expect(styles).not.toContain("scroll-behavior: smooth");
    expect(renderer).toContain("if (!messages.childElementCount) showLanding(true)");
    expect(renderer).toContain("messages.scrollTop = messages.scrollHeight");
    expect(conversationLayout).toContain("distanceFromBottom < 48");
    expect(composerCss).toContain(".scroll-to-bottom");
    expect(composerCss).toContain("bottom: calc(100% + 12px)");
  });

  it("expands Advanced model settings and sends the chosen temperature and output limit", () => {
    for (const id of ["advanced-settings-panel", "temperature", "temperature-value"]) expect(composer).toContain(`id="${id}"`);
    expect(composerControls).toContain("this.toggleAdvancedSettings()");
    expect(composerControls).toContain('this.storage.setItem("fitz-temperature", this.elements.temperature.value)');
    expect(renderer).toContain("temperature: composer.controls.temperature");
    expect(renderer).toContain("max_tokens: composer.controls.maxTokens");
    expect(styles).toContain('.advanced-row[aria-expanded="true"] svg');
    expect(styles).toContain(".advanced-settings-panel");
    expect(styles).toContain(".model-menu { right: 0; bottom: 34px; width: 286px;");
    expect(styles).toContain(".settings-submenu.open-left");
    expect(composer).toContain('<option value="2048">Light</option><option value="8192" selected>Medium</option><option value="16384">High</option>');
    expect(composer).not.toContain('data-setting="speed"');
    expect(composer).not.toContain("Extra High");
    expect(composer).not.toContain("Ultra");
  });

  it("silently warms the selected route after the first composer character", () => {
    expect(renderer).toContain("agentRuns.scheduleWarmup(composer.value, composer.controls.routeId)");
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
    expect(composer).toContain("this.promptDraft = this.prompt.value");
    expect(composer).toContain("this.prompt.value = this.promptDraft");
    expect(composer).toContain("this.prompt.value = this.promptHistory[this.promptHistoryIndex] ?? \"\"");
    expect(composer).toContain("rebuildHistory(texts: string[])");
    expect(renderer).toContain("entry.kind === \"message\" && entry.role === \"user\"");
    expect(composer).toContain("this.promptHistory.push(text)");
    expect(renderer).toContain("composer.rebuildHistory((transcript.data ?? [])");
  });

  it("keeps every dropdown and overflow surface at the compact Codex menu density", () => {
    expect(styles).toContain(".popover { position: absolute; z-index: 18; padding: 4px;");
    expect(styles).toContain(".menu-surface button { width: 100%; min-height: 32px;");
    expect(styles).toContain(".app-menu-popover { position: fixed; z-index: 60; width: 204px;");
    expect(styles).toContain(".sidebar-context-menu { position: fixed; z-index: 40; width: 242px;");
    expect(styles).toContain(".access-mode-menu { left: 0; bottom: 34px; width: 250px;");
    expect(styles).toContain(".settings-submenu { left: calc(100% + 6px); top: 0; width: 244px;");
  });

  it("manually compacts context from the inline usage popover", () => {
    expect(composer).toContain('id="context-compact"');
    expect(renderer).toContain('api(`/api/v1/sessions/${projects.currentSessionId}/compact`, "POST"');
    expect(renderer).toContain("estimateTranscriptContext");
    expect(renderer).toContain('activityTimeline.appendContext("Context compacted")');
    expect(styles).toContain(".context-usage-popover button");
  });

  it("uses the measured Codex desktop design tokens", () => {
    expect(styles).toContain("--codex-gray-900: #181818");
    expect(styles).toContain("--codex-gray-800: #212121");
    expect(styles).toContain("--codex-gray-700: #303030");
    expect(styles).toContain("--codex-control: rgba(51,51,51,.96)");
    expect(styles).toContain("--sidebar: #1a2225");
    expect(styles).toContain("--codex-radius-3xl: 25px");
    expect(styles).toContain("--codex-control-size: 28px");
    expect(styles).toContain("--sidebar-width: 275px");
    expect(styles).toContain("--conversation-width: min(768px, calc(var(--conversation-space) - var(--conversation-inset)))");
    expect(styles).toContain("max-width: 100%");
    expect(styles).toContain("backdrop-filter: blur(16px)");
    expect(styles).toContain("--codex-elevation-prominent:");
    expect(renderer).toContain('storageKey: "fitz-sidebar-width"');
    expect(renderer).toContain("minimum: 240, maximum: 520");
    expect(html).toContain('d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"');
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
    expect(renderer).toContain("if (created) openNewChat()");
    expect(renderer).toContain("if (projects.currentProjectId) openNewChat()");
    expect(renderer).toContain('action.textContent = "Create project"');
    expect(renderer).not.toContain('textContent = projects.currentProjectId ? "New task"');
    expect(projects).toContain('rememberLocation({ view: "conversation", projectId: id, newChat: true })');
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

  it("clears the starter screen and reports unobtrusive work progress before output arrives", () => {
    expect(renderer).toContain('messages.querySelector(".landing, .new-chat-landing")');
    expect(agentRunController).toContain('this.#options.activity.appendRun("Working")');
    expect(agentRunController).toContain('this.#options.activity.setRun(activity, "Working", startedAt)');
    expect(agentRunController).not.toContain('this.#options.activity.setRun(activity, "Loading model"');
    expect(activityTimeline).toContain("this.#formatElapsed(Date.now() - startedAt)");
    expect(agentRunController).toContain('this.#options.api("/api/v1/management/status")');
    expect(renderer).toContain('if (role !== "commentary" && !agentRuns.active) activityTimeline.finishWork(createdAt)');
    expect(agentRunController).toContain("this.#options.activity.finishWork()");
  });

  it("shows and controls the serialized native-agent request queue", () => {
    expect(html).toContain('id="request-queue"');
    expect(html).toContain('id="queue-count"');
    expect(renderer).toContain('api("/api/v1/agent/queue")');
    expect(agentRunController).toContain('event.type === "run.queue.updated"');
    expect(renderer).toContain('cancelQueuedRun(String(item.runId), cancel)');
    expect(renderer).toContain('setTimeout(scheduleQueueRefresh, 1_000)');
    expect(styles).toContain(".queue-item");
    expect(styles).toContain(".queue-cancel");
  });

  it("replaces the deferred Environment surface with a resource Inspector", () => {
    expect(html).toContain('id="context-toggle" class="icon-button" type="button" title="Toggle environment panel" aria-label="Toggle environment panel" aria-expanded="false" hidden');
    expect(html).not.toContain('id="context-panel"');
    expect(html).not.toContain('id="inspector-resizer"');
    for (const id of ["inspector-title", "inspector-location", "inspector-render-toggle", "inspector-open", "inspector-close"]) expect(inspectorPanel).toContain(`id = "${id}"`);
    expect(inspectorPanel).toContain('className = "inspector-panel"');
    expect(inspectorPanel).toContain('className = "inspector-resizer"');
    expect(inspectorPanel).toContain('setAttribute("aria-label", "Inspector")');
    expect(renderer).not.toContain('item("Toggle environment"');
    expect(renderer).toContain('window.addEventListener("fitz:open-resource"');
    expect(renderer).toContain("inspectorPanel.inspect(reference)");
    expect(renderer).toContain("inspectorPanel.toggle()");
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
    expect(styles).toContain("background: var(--codex-gray-900); color-scheme: dark");
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
    expect(renderer).toContain('name: pasted.kind === "image" ? `screenshot-${Date.now()}.png` : pasted.name');
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
    // The main-process preview resolves binary files to base64 with a MIME type instead of rejecting NUL bytes.
    expect(resourcePreview).toContain('MAX_BINARY_PREVIEW_BYTES');
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

  it("turns the Inspector into a tabbed artifact repository with a fixed base tab", () => {
    // The repository is the defacto base: a permanent, non-closable tab.
    expect(inspectorPanel).toContain('className = "inspector-tabs"');
    expect(inspectorPanel).toContain('setAttribute("role", "tablist")');
    expect(inspectorPanel).toContain('closable: false');
    expect(inspectorPanel).toContain('"Artifacts"');
    expect(inspectorPanel).toContain('className = "inspector-tab-close"');
    expect(inspectorPanel).toContain("setSessionArtifacts(artifacts: Json[]): void");
    expect(inspectorPanel).toContain("resetPreview(): void");
    expect(inspectorPanel).toContain("registerReference(reference: string): void");
    // Files open from chat links and tool rows grow the persisted repository.
    expect(artifactRepository).toContain('fitz-inspector-repository');
    expect(artifactRepository).toContain("registerFile(path: string, name: string, reference?: string): void");
    expect(artifactRepository).toContain("registerReference(reference: string): void");
    expect(artifactRepository).toContain("setSessionArtifacts(artifacts: Json[]): void");
    expect(artifactRepository).toContain("onOpenFile");
    expect(artifactRepository).toContain("onOpenArtifact");
    expect(artifactRepository).toContain("getProjectRoot");
    expect(artifactRepository).toContain("projectRelativePath");
    // The renderer feeds current-session uploads into the repository.
    expect(renderer).toContain("inspectorPanel.setSessionArtifacts(");
    // Every opened artifact gets its own closable tab, and the repo is the base.
    expect(inspectorPanel).toContain("onFileInspected: (path, name, reference) => this.#onFileInspected(tab.id, path, name, reference)");
    expect(inspectorPanel).toContain("this.#repository.registerFile(path, name, reference)");
    expect(inspectorPanel).toContain('`upload:${String(artifact.id)}`');
    // The inspector shows project-relative paths instead of absolute ones.
    expect(resourceInspector).toContain("projectRelativePath(preview.path");
    // Files register as soon as they render in chat, without a click.
    expect(markdown).toContain('"fitz:resource-appeared"');
    expect(renderer).toContain('window.addEventListener("fitz:resource-appeared"');
    expect(renderer).toContain("inspectorPanel.registerReference(reference)");
    // Middle-click (the mouse wheel button) closes artifact tabs.
    expect(inspectorPanel).toContain("auxclick");
    expect(inspectorPanel).toContain("event.button === 1");
    expect(inspectorPanel).toContain("mousedown");
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
    expect(renderer).toContain('hasSession: Boolean(projects.currentSessionId || (newChatMode && projects.currentProjectId))');
    expect(renderer).toContain('if (!projects.currentSessionId && !(newChatMode && projects.currentProjectId)) { showToast("Create or select a task before attaching a file"); return; }');
    expect(renderer).toContain('if (newChatMode && projects.currentProjectId) { composer.attachFile(file); return; }');
    expect(composer).toContain("attachFile(file: File): void");
    expect(composer).toContain('const kind = file.type.startsWith("image/") ? "image" : file.type === "application/pdf" ? "pdf" : "file";');
    expect(composer).toContain('this.options.onError("Attached file is too large (max 5 MB)");');
    expect(composerCss).toContain(".file-chip .file-chip-body");
  });

  it("pairs a desktop without exposing its durable bearer credential to the renderer", () => {
    for (const id of ["pairing-page", "pairing-form", "pairing-code", "pairing-display-name", "pairing-device-name", "pairing-error"]) expect(html).toContain(`id="${id}"`);
    expect(renderer).toContain("showPairingPage(`Enter a one-time code to connect to ${configuredHostOrigin}.`)");
    expect(renderer).toContain("window.fitz.pairDevice");
    expect(renderer).toContain("window.fitz.bootstrapLocalDevice()");
    expect(preload).toContain('ipcRenderer.invoke("fitz:bootstrap-local-device"');
    expect(preload).toContain('ipcRenderer.invoke("fitz:pair-device"');
    expect(preload).toContain('ipcRenderer.invoke("fitz:connection-info"');
    expect(main).toContain('ipcMain.handle("fitz:pair-device"');
    expect(main).toContain('ipcMain.handle("fitz:bootstrap-local-device"');
    expect(main).toContain("!isLoopbackHost(hostUrl)");
    expect(main).toContain('ipcMain.handle("fitz:connection-info"');
    expect(main).toContain("safeStorage.encryptString(token)");
    expect(main).toContain("safeStorage.decryptString");
    expect(main).toContain('createHash("sha256").update(new URL(hostUrl).origin)');
    expect(main).toContain("const { token: _token, ...safeData } = data");
    expect(styles).toContain(".pairing-page");
    expect(renderer).toContain('setConnection(configuredHostOrigin.replace');
  });

  it("provides inline administrator controls for pairing, users, devices, routes, quotas, and tools", () => {
    for (const id of ["administration-page", "pairing-code-form", "create-user-form", "admin-users", "tool-policy-form", "tool-policies", "admin-audit-events", "admin-trash", "admin-snapshots", "admin-tool-actions", "empty-trash-button", "gc-retention-button"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(administrationPage).toContain('api("/api/v1/management/pairing-codes", "POST"');
    expect(administrationPage).toContain('api("/api/v1/management/users")');
    expect(administrationPage).toContain('api("/api/v1/management/tool-policies")');
    expect(administrationPage).toContain('api("/api/v1/management/audit-events?limit=50")');
    expect(administrationPage).toContain('api("/api/v1/management/trash")');
    expect(administrationPage).toContain('api("/api/v1/management/snapshots")');
    expect(administrationPage).toContain('api("/api/v1/management/tool-actions?limit=100")');
    expect(administrationPage).toContain('/routes`, "PUT", { routeIds }');
    expect(administrationPage).toContain('/quota`, "PUT", quota');
    expect(administrationPage).toContain('revokeAdminDevice(device.id)');
    expect(html).toContain('id="administration-sections"');
    expect(styles).toContain(".tool-policy");
    expect(html).toContain('id="select-popover"');
    expect(renderer).toContain("new CustomSelectController(selectPopover, closePopovers)");
    expect(customSelect).toContain('document.querySelectorAll<HTMLSelectElement>("select").forEach(this.enhance)');
    expect(customSelect).toContain("open(select: HTMLSelectElement");
    expect(styles).toContain(".select-popover .select-option.selected::after");
    expect(styles).toContain("background-position: right 9px center");
  });

  it("lets the administration sections collapse to their headers", () => {
    expect(html).toContain('class="collapsible-toggle"');
    expect(html).toContain('data-collapsible-key="pairing"');
    expect(html).toContain('data-collapsible-key="remote"');
    expect(html).toContain('data-collapsible-key="startup"');
    expect(html).toContain('data-collapsible-key="users"');
    expect(html).toContain('data-collapsible-key="policies"');
    expect(html).toContain('data-collapsible-key="diagnostics"');
    expect(html).toContain('data-collapsible-key="updates"');
    expect(html).toContain('data-collapsible-key="activity"');
    expect(html).toContain('id="admin-remote-body"');
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
    expect(administrationPage).toContain("this.renderDiagnostics(diagnostics)");
    expect(administrationPage).toContain("saveDiagnostics(JSON.stringify(this.diagnosticBundle, null, 2))");
    expect(preload).toContain('ipcRenderer.invoke("fitz:save-diagnostics", content)');
    expect(main).toContain('ipcMain.handle("fitz:save-diagnostics"');
    expect(main).toContain("content.length > 10_000_000");
    expect(styles).toContain(".diagnostic-summary");
    expect(styles).toContain(".diagnostic-row");
  });

  it("onboards private Tailscale HTTPS inline without configuration dialogs", () => {
    for (const id of ["remote-access-status", "enable-remote-access", "disable-remote-access", "remote-access-confirmation", "confirm-remote-access"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(administrationPage).toContain('api("/api/v1/management/connectivity/status")');
    expect(administrationPage).toContain('showRemoteConfirmation("enable")');
    expect(administrationPage).toContain('api("/api/v1/management/connectivity/tailscale-serve", "POST", {})');
    expect(administrationPage).toContain('api("/api/v1/management/connectivity/tailscale-serve", "DELETE")');
    expect(styles).toContain(".remote-access-confirmation[hidden]");
  });

  it("shows desktop update state, progress, checks, and restart installation inline", () => {
    for (const id of ["check-desktop-update", "install-desktop-update", "desktop-update-label", "desktop-update-progress"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(administrationPage).toContain("updateStatus(): Promise<DesktopUpdateStatus>");
    expect(administrationPage).toContain(".then((update) => this.renderDesktopUpdate(update))");
    expect(administrationPage).toContain("Downloading update · ${Math.round(percent)}%");
    expect(preload).toContain('ipcRenderer.invoke("fitz:update-status")');
    expect(main).toContain('autoUpdater.on("download-progress"');
    expect(main).toContain('publishUpdateStatus({ state: "development" })');
    expect(styles).toContain(".desktop-update-track");
  });

  it("manages packaged host startup inline with staged confirmation", () => {
    for (const id of ["host-startup-status", "install-host-startup", "remove-host-startup", "host-startup-confirmation", "confirm-host-startup"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(administrationPage).toContain('api("/api/v1/management/startup")');
    expect(administrationPage).toContain('showStartupConfirmation("install")');
    expect(administrationPage).toContain('action === "install" ? "POST" : "DELETE"');
    expect(styles).toContain(".host-startup-status");
  });
});
