import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./renderer/index.html", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const markdown = readFileSync(new URL("./markdown.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./renderer/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

describe("desktop renderer shell", () => {
  it("wires every visible shell action to a renderer interaction", () => {
    const actions = [
      "sidebar-menu",
      "sidebar-resizer",
      "new-session",
      "manage-playbooks",
      "new-project",
      "connection-status",
      "context-toggle",
      "context-add",
      "attach",
      "send",
      "add-artifact",
      "choose-project-folder",
      "model-toggle",
      "context-meter",
      "context-compact",
      "advanced-settings",
      "task-menu-toggle",
      "rename-task",
      "archive-task",
      "update",
    ];
    for (const id of actions) {
      expect(html, `missing control #${id}`).toContain(`id="${id}"`);
      expect(renderer, `missing renderer binding for #${id}`).toContain(`element("${id}")`);
    }
  });

  it("uses accessible dialogs and avoids blocking browser prompts", () => {
    expect(html).toContain('<dialog id="project-dialog"');
    expect(html).toContain('<dialog id="task-dialog"');
    expect(html).toContain('<dialog id="rename-dialog"');
    expect(html).toContain('<dialog id="remove-project-dialog"');
    expect(html).toContain('id="management-editor"');
    expect(html).toContain('id="engine-form" class="management-editor-form"');
    expect(html).toContain('id="recipe-form" class="management-editor-form"');
    expect(html).not.toContain('id="route-form"');
    expect(html).not.toContain('<dialog id="recipe-dialog"');
    expect(html).not.toContain('<dialog id="route-dialog"');
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
    expect(styles).toContain("*::-webkit-scrollbar { width: 10px; height: 10px; }");
    expect(styles).toContain("background-clip: content-box");
    expect(styles).not.toContain(".management-page-content { width: min(820px");
  });

  it("matches the compact Codex sidebar and new-chat project rail", () => {
    expect(html).not.toContain('class="runtime-mode-toggle"');
    expect(html).toContain('<span>Codex</span>');
    expect(renderer).toContain('treeItem(session.title, "task-row", undefined');
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
    expect(html).toContain('id="connections-page"');
    expect(html).toContain('id="consumer-connection-url"');
    expect(html).toContain('id="connection-search"');
    expect(html).toContain('id="connection-editor"');
    expect(renderer).toContain('window.fitz.saveConsumerConnection');
    expect(renderer).not.toContain('/api/v1/runtime-mode');
    expect(renderer).toContain('consumerFixedRouteId');
    expect(renderer).toContain('const LOCAL_CONNECTION_ID = "hosted--local"');
    expect(renderer).toContain('connectionId: selectedConnectionId');
    expect(renderer).toContain('routeId: model.value as FixedRouteId');
    expect(renderer).not.toContain('candidate.routeId === card.id');
    expect(renderer).toContain('testRecipe({ id: consumerModel.recipeId');
    expect(renderer).toContain("function connectionViews(): ConnectionView[]");
    expect(renderer).toContain('id: LOCAL_CONNECTION_ID');
    expect(renderer).toContain('managementConfiguration?.hostName ?? "This PC"');
    expect(renderer).not.toContain('configuredConnectionId');
    expect(renderer).not.toContain('edit.textContent = configuredConnectionId');
    expect(renderer).toContain('for (const consumerModel of connection.availableModels)');
    expect(renderer).toContain('connection.hosted ? definition.id : consumerFixedRouteId');
    expect(renderer).toContain('assignConnectionRoute(connection, definition, consumerModel, button)');
    expect(renderer).toContain('if (!connection.hosted)');
    expect(renderer).not.toContain('url.className = "connection-url"');
    expect(html).toContain("Provider and self-hosted OpenAI-compatible APIs.");
    expect(html).toContain("http://127.0.0.1:8000/v1");
    expect(styles).toContain('max-height: min(440px, calc(100vh - 32px)); overflow-y: auto;');
    expect(main).toContain('safeStorage.encryptString(JSON.stringify(connections))');
    expect(main).not.toContain('apiKey: connection.apiKey, models');
  });

  it("provides an inline Pi package and skills workspace", () => {
    expect(html).toContain('id="manage-plugins"');
    expect(html).toContain('id="plugins-page"');
    expect(html).toContain('id="plugins-tab"');
    expect(html).toContain('id="skills-tab"');
    expect(html).toContain('id="plugin-catalog"');
    expect(renderer).toContain('/api/v1/management/pi/catalog');
    expect(renderer).toContain('/api/v1/management/pi/packages/install');
    expect(renderer).toContain('entry.links.homepage ?? entry.links.repository ?? entry.links.npm');
    expect(renderer).toContain('window.fitz.openExternal(website)');
    expect(renderer).toContain('Pi packages can run code with the same access as Fitz');
    expect(main).toContain('ensureBundledLocalHost');
    expect(main).toContain('join(process.resourcesPath, "host")');
  });

  it("opens Playbooks as a first-class searchable workspace page", () => {
    expect(html).toContain('id="playbook-page"');
    expect(html).not.toContain('data-management-view=');
    expect(html).toContain('id="playbook-search"');
    expect(renderer).toContain("openPlaybookPage()");
    expect(renderer).toContain("renderManagementPage()");
    expect(renderer).toContain("FIXED_ROUTES");
    expect(renderer).not.toContain("assignFixedRoute(");
    expect(renderer).toContain('Configure and test their recipes here.');
    expect(renderer).not.toContain("now uses ${recipe.displayName}");
    expect(renderer).toContain("openEngineEditor");
    expect(renderer).toContain('/api/v1/management/engines/${encodeURIComponent(folderName)}');
    expect(renderer).not.toContain("ENGINE_CATALOG");
    expect(html).not.toContain("Add engine");
    expect(html).not.toContain("engine-root-path");
    expect(renderer).not.toContain('status.textContent = engine ? "Registered"');
    expect(renderer).not.toContain("${folder.rootPath}");
    expect(styles).toContain(".recipe-card-actions { align-self: center; display: flex; align-items: center;");
    expect(styles).toContain(".recipe-route-toggle { display: flex; align-items: center; gap: 1px; padding: 2px; border: 0;");
    expect(renderer).toContain('class="route-icon-cut"');
    expect(renderer).toContain('class="route-icon-filled" fill-rule="evenodd"');
    expect(html).not.toContain("NiNfer");
    expect(html).not.toContain("llama.cpp");
    expect(html).not.toContain("vLLM");
    expect(renderer).toContain("showConversationWorkspace()");
  });

  it("tests each Playbooks recipe directly and reports the result on its row", () => {
    expect(renderer).toContain('testButton.className = "recipe-test-button"');
    expect(renderer).toContain('api(`/api/v1/management/recipes/${encodeURIComponent(recipe.id)}/test`, "POST")');
    expect(renderer).toContain('state === "passed" ? "✓ Working"');
    expect(renderer).toContain('state === "failed" ? "Retry"');
    expect(renderer).toContain('detail: "Sending “Say hi.” to this recipe"');
    expect(renderer).toContain('modelLabel.className = "recipe-card-label"');
    expect(renderer).toContain('contextLabel.className = "recipe-card-label recipe-context-label"');
    expect(renderer).not.toContain('detail.textContent = `${recipe.adapter} · ${recipe.modelId}`');
    expect(styles).toContain(".recipe-test-button");
    expect(styles).toContain(".recipe-test-button.passed");
    expect(styles).toContain(".recipe-card-label {");
  });

  it("exposes working keyboard, retry, attachment, and cancellation paths", () => {
    expect(renderer).toContain('event.key === "Enter"');
    expect(renderer).toContain('connectionStatus.addEventListener("click"');
    expect(renderer).toContain("artifactFile.click()");
    expect(renderer).toContain('api(`/api/v1/artifacts/${artifact.id}`, "DELETE")');
    expect(renderer).toContain("window.fitz.chooseFolder()");
    expect(renderer).toContain("window.fitz.openPath(path)");
    expect(renderer).toContain("window.fitz.copyText(value)");
    expect(renderer).toContain("beginSidebarResize");
    expect(renderer).toContain('openSidebarMenu("project"');
    expect(renderer).toContain('openSidebarMenu("task"');
    expect(renderer).toContain('openSettingsSubmenu(row.dataset.setting');
    expect(renderer).toContain('api("/api/v1/management/status")');
    expect(renderer).toContain('/api/v1/management/recipes/${encodeURIComponent(id)}');
    expect(renderer).toContain("sessionTokenEstimate += estimateTokens");
    expect(renderer).toContain('api(`/api/v1/sessions/${session.id}`, "PATCH", { status: "archived" })');
    expect(renderer).toContain("max_tokens: Number(effort.value)");
    expect(renderer).toContain('api(`/api/v1/agent/runs/${currentRun}`, "DELETE")');
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
    ]) expect(html).toContain(`id="${id}"`);

    expect(renderer).toContain('newChatProjectDetached = true');
    expect(renderer).toContain("window.fitz.gitBranches(rootPath)");
    expect(renderer).toContain("window.fitz.checkoutBranch(rootPath, branch)");
    expect(renderer).toContain("window.fitz.createBranch(rootPath, branch)");
    expect(renderer).toContain("window.fitz.createWorktree(project.rootPath, branch)");
    expect(main).toContain('ipcMain.handle("fitz:git-branches"');
    expect(main).toContain('ipcMain.handle("fitz:git-checkout-branch"');
    expect(main).toContain('ipcMain.handle("fitz:git-create-branch"');
    expect(main).toContain('ipcMain.handle("fitz:git-create-worktree"');
    expect(styles).toContain("bottom: 100%");
    expect(styles).not.toContain("bottom: calc(100% - 12px)");
  });

  it("renders durable Codex-style agent activity with tool-specific symbols", () => {
    expect(renderer).toContain("appendToolActivity(toolName, input, toolCallId");
    expect(renderer).toContain('summary.type = "button"');
    expect(renderer).toContain('toolActivityDetail("Input", input');
    expect(renderer).toContain('toolActivityDetail("Result"');
    expect(renderer).toContain('summary.setAttribute("aria-expanded", String(open))');
    expect(renderer).toContain("entry.content?.result");
    expect(renderer).toContain("event.data?.result");
    expect(renderer).toContain("formatToolPayload");
    expect(renderer).toContain("markAssistantAsCommentary");
    expect(renderer).toContain("Context automatically compacted");
    expect(renderer).toContain('toolName === "edit" || toolName === "write"');
    expect(styles).toContain(".agent-activity-icon");
    expect(styles).toContain(".agent-activity-details");
    expect(styles).toContain(".agent-activity.open .agent-activity-chevron");
    expect(styles).toContain(".message.commentary");
  });

  it("matches Codex assistant, command disclosure, and shell presentation", () => {
    expect(renderer).not.toContain('className = "assistant-mark"');
    expect(styles).not.toContain(".assistant-mark");
    expect(renderer).toContain('toolName === "bash"');
    expect(renderer).toContain('details.classList.add("shell-details")');
    expect(renderer).toContain('title.textContent = "Shell"');
    expect(renderer).toContain('status.textContent = running ? "Running…" : "✓ Success"');
    expect(styles).toContain(".agent-activity-summary:hover .agent-activity-chevron");
    expect(styles).toContain("opacity: 0; transition: opacity 120ms ease");
    expect(styles).toContain(".agent-activity.open .agent-activity-chevron { transform: rotate(90deg); }");
    expect(styles).toContain(".agent-activity-details.shell-details");
    expect(styles).toContain('.shell-command::before { content: "$ ";');
    expect(renderer).toContain('label.classList.add("file-target")');
    expect(styles).toContain(".agent-activity-label.file-target");
  });

  it("collapses completed Pi activity behind a durable work summary", () => {
    expect(renderer).toContain("ensureWorkSummary(createdAt)");
    expect(renderer).toContain("finishWorkSummary(createdAt)");
    expect(renderer).toContain('label.textContent = `Worked for ${formatElapsed(endedAt - work.startedAt)}`');
    expect(renderer).toContain('row.className = "message context-activity"');
    expect(styles).toContain(".work-summary-toggle");
    expect(styles).toContain(".context-activity");
  });

  it("renders streamed assistant Markdown safely while keeping prompts plain", () => {
    expect(renderer).toContain('import { appendMarkdown, setMarkdown } from "./markdown.js"');
    expect(renderer).toContain("appendMarkdown(assistant, delta)");
    expect(renderer).toContain('if (role === "assistant" || role === "commentary") setMarkdown(content, text); else content.textContent = text');
    expect(markdown).toContain("target.replaceChildren()");
    expect(markdown).not.toContain("innerHTML");
    expect(markdown).toContain('window.dispatchEvent(new CustomEvent("fitz:open-resource"');
    expect(markdown).toContain('link.className = "resource-link"');
    expect(markdown).toContain('container.className = "markdown-code"');
    expect(markdown).toContain('copy.textContent = "Copy"');
    expect(markdown).toContain('document.createElement("table")');
    expect(styles).toContain(".message-body.markdown h1");
    expect(styles).toContain(".markdown-code pre");
    expect(styles).toContain(".markdown-table table");
  });

  it("reveals compact Copy and user Edit actions on message hover", () => {
    expect(renderer).toContain("appendMessageActions(article, content, role, text, createdAt)");
    expect(renderer).toContain('copy.title = "Copy message"');
    expect(renderer).toContain('edit.title = "Edit message"');
    expect(renderer).toContain("startInlineMessageEdit(article, content, actions, originalText)");
    expect(renderer).toContain('copyValue(content.innerText, "Copied message")');
    expect(renderer).toContain('time.className = "message-time"');
    expect(renderer).toContain("formatMessageTimestamp(createdAt)");
    expect(styles).toContain(".message:hover .message-actions");
    expect(styles).toContain(".message.assistant .message-actions, .message.commentary .message-actions");
    expect(styles).toContain(".message-action svg");
  });

  it("edits user prompts inline with Cancel and Send controls", () => {
    expect(renderer).toContain('editor.className = "message-inline-editor"');
    expect(renderer).toContain('cancel.textContent = "Cancel"');
    expect(renderer).toContain('send.textContent = "Send"');
    expect(renderer).toContain("void sendPrompt(revised, article)");
    expect(renderer).toContain('event.key === "Enter" && (event.ctrlKey || event.metaKey)');
    expect(renderer).toContain('bubble.className = "message-edit-bubble"');
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
    expect(styles).toContain(".composer-dock::before");
    expect(styles).toContain("inset: var(--codex-radius-3xl) 0 -12px");
    expect(styles).toContain("--conversation-scrollbar: 0px");
    expect(styles).toContain(".workspace.inspector-open { --conversation-viewport: calc(100% - var(--inspector-width))");
    expect(renderer).toContain("new ResizeObserver(syncConversationLayout)");
    expect(renderer).toContain("conversationLayoutObserver.observe(composerDock)");
    expect(renderer).toContain("messages.offsetWidth - messages.clientWidth");
    expect(renderer).toContain("composerDock.offsetHeight");
    expect(html).toContain('id="scroll-to-bottom"');
    expect(renderer).toContain('messages.addEventListener("scroll", updateScrollToBottom');
    expect(renderer).toContain('messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" })');
    expect(styles).not.toContain("scroll-behavior: smooth");
    expect(renderer).toContain("if (!messages.childElementCount) showLanding(true)");
    expect(renderer).toContain("messages.scrollTop = messages.scrollHeight");
    expect(renderer).toContain("distanceFromBottom < 48");
    expect(styles).toContain(".scroll-to-bottom");
    expect(styles).toContain("bottom: calc(100% + 12px)");
  });

  it("expands Advanced model settings and sends the chosen temperature and output limit", () => {
    for (const id of ["advanced-settings-panel", "temperature", "temperature-value"]) expect(html).toContain(`id="${id}"`);
    expect(renderer).toContain("toggleAdvancedSettings()");
    expect(renderer).toContain('localStorage.setItem("fitz-temperature", temperature.value)');
    expect(renderer).toContain("temperature: Number(temperature.value)");
    expect(renderer).toContain("max_tokens: Number(effort.value)");
    expect(styles).toContain('.advanced-row[aria-expanded="true"] svg');
    expect(styles).toContain(".advanced-settings-panel");
    expect(styles).toContain(".model-menu { right: 0; bottom: 34px; width: 286px;");
    expect(styles).toContain(".settings-submenu.open-left");
    expect(html).toContain('<option value="2048">Light</option><option value="8192" selected>Medium</option><option value="16384">High</option>');
    expect(html).not.toContain('data-setting="speed"');
    expect(html).not.toContain("Extra High");
    expect(html).not.toContain("Ultra");
  });

  it("silently warms the selected route after the first composer character", () => {
    expect(renderer).toContain("scheduleModelWarmup()");
    expect(renderer).toContain('api("/api/v1/inference/warm", "POST", { model: model.value, connectionId: selectedConnectionId })');
    expect(renderer).toContain("if (composerHadText || currentRun || !model.value) return");
    expect(renderer).toContain("}, 120)");
    expect(renderer).toContain("idleTtlSeconds: 600");
    expect(renderer).not.toContain('contextMeter.classList.toggle("model-loading", loading)');
    expect(styles).toContain("@keyframes run-activity-spinner");
    expect(styles).toContain(".run-activity::before");
    expect(styles).toContain("animation: run-activity-spinner 680ms linear infinite");
    expect(styles).not.toContain(".context-meter.model-loading");
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
    expect(html).toContain('id="context-compact"');
    expect(renderer).toContain('api(`/api/v1/sessions/${currentSession}/compact`, "POST"');
    expect(renderer).toContain("estimateTranscriptContext");
    expect(renderer).toContain('appendContextActivity("Context compacted")');
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
    expect(renderer).toContain("Math.max(240, Math.min(520, value))");
    expect(html).toContain('d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"');
  });

  it("shows an interactive project metadata card on hover", () => {
    expect(html).toContain('id="project-hover-card"');
    expect(html).toContain('id="hover-project-pin"');
    expect(html).toContain('id="hover-project-path"');
    expect(html).toContain('id="hover-project-edit"');
    expect(renderer).toContain("showProjectHover(project, projectItem)");
    expect(renderer).toContain("sessionsByProject.get(project.id)");
    expect(renderer).toContain("openProjectRenameDialog(hoveredProjectId)");
  });

  it("matches the project hover controls and menu actions", () => {
    expect(renderer).toContain('className = "tree-quick-action"');
    expect(renderer).toContain("New chat in ${label}");
    expect(styles).not.toContain(".project-group:hover > .tree-item .tree-quick-action");
    for (const label of ["Pin project", "Open in Explorer", "Create permanent worktree", "Edit project", "Archive chats", "Remove"]) {
      expect(renderer).toContain(`"${label}"`);
    }
    expect(renderer).toContain('api(`/api/v1/projects/${id}`, "DELETE")');
  });

  it("clears the starter screen and reports unobtrusive work progress before output arrives", () => {
    expect(renderer).toContain('messages.querySelector(".landing, .new-chat-landing")');
    expect(renderer).toContain('appendRunActivity("Working")');
    expect(renderer).toContain('setRunActivity(activity, "Working", runStartedAt)');
    expect(renderer).not.toContain('setRunActivity(activity, "Loading model"');
    expect(renderer).toContain("formatElapsed(Date.now() - startedAt)");
    expect(renderer).toContain('api("/api/v1/management/status")');
  });

  it("shows and controls the serialized native-agent request queue", () => {
    expect(html).toContain('id="request-queue"');
    expect(html).toContain('id="queue-count"');
    expect(renderer).toContain('api("/api/v1/agent/queue")');
    expect(renderer).toContain('event.type === "run.queue.updated"');
    expect(renderer).toContain('cancelQueuedRun(String(item.runId), cancel)');
    expect(renderer).toContain('setTimeout(scheduleQueueRefresh, 1_000)');
    expect(styles).toContain(".queue-item");
    expect(styles).toContain(".queue-cancel");
  });

  it("replaces the deferred Environment surface with a resource Inspector", () => {
    expect(html).toContain('id="context-toggle" class="icon-button" type="button" title="Toggle environment panel" aria-label="Toggle environment panel" aria-expanded="false" hidden');
    expect(html).toContain('id="context-panel" class="inspector-panel" aria-label="Inspector" hidden');
    expect(html).toContain('id="inspector-resizer" class="inspector-resizer"');
    for (const id of ["inspector-title", "inspector-location", "inspector-render-toggle", "inspector-open", "inspector-close"]) expect(html).toContain(`id="${id}"`);
    expect(renderer).not.toContain('item("Toggle environment"');
    expect(renderer).toContain('window.addEventListener("fitz:open-resource"');
    expect(renderer).toContain("window.fitz.previewResource({ projectRoot, reference, searchRoots: [...resourceSearchRoots] })");
    expect(renderer).toContain("resourcePreviewError(error, reference)");
    expect(renderer).toContain("renderResourcePreview(inspectedPreview)");
    expect(renderer).toContain('frame.setAttribute("sandbox", "")');
    expect(styles).toContain(".inspector-panel");
    expect(styles).not.toContain(".workspace.inspector-open .messages { margin-right: var(--inspector-width); }");
    expect(styles).toContain(".inspector-resizer");
    expect(renderer).toContain("beginInspectorResize");
    expect(renderer).toContain("restoreInspectorWidth()");
    expect(renderer).toContain('from "highlight.js/lib/core"');
    expect(renderer).toContain("hljs.highlight(content, { language, ignoreIllegals: true })");
    expect(renderer).toContain("withPreviewScrollbar(source)");
    expect(styles).toContain(".inspector-source .hljs-keyword");
    expect(preload).toContain('ipcRenderer.invoke("fitz:preview-resource", input)');
    expect(main).toContain('ipcMain.handle("fitz:preview-resource"');
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
    for (const id of ["administration-page", "pairing-code-form", "create-user-form", "admin-users", "tool-policy-form", "tool-policies", "admin-audit-events"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(renderer).toContain('api("/api/v1/management/pairing-codes", "POST"');
    expect(renderer).toContain('api("/api/v1/management/users")');
    expect(renderer).toContain('api("/api/v1/management/tool-policies")');
    expect(renderer).toContain('api("/api/v1/management/audit-events?limit=50")');
    expect(renderer).toContain('/routes`, "PUT", { routeIds }');
    expect(renderer).toContain('/quota`, "PUT", quota');
    expect(renderer).toContain('revokeAdminDevice(device.id)');
    expect(styles).toContain(".administration-content");
    expect(styles).toContain(".tool-policy");
    expect(html).toContain('id="select-popover"');
    expect(renderer).toContain("function initializeCustomSelects()");
    expect(renderer).toContain("function openCustomSelect(");
    expect(styles).toContain(".select-popover .select-option.selected::after");
    expect(styles).toContain("background-position: right 9px center");
  });

  it("renders and exports host-redacted diagnostics from the administration workspace", () => {
    for (const id of ["diagnostic-summary", "diagnostic-metrics", "diagnostic-failures", "export-diagnostics"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(renderer).toContain('api("/api/v1/management/diagnostics")');
    expect(renderer).toContain("renderDiagnostics(diagnostics)");
    expect(renderer).toContain("window.fitz.saveDiagnostics(JSON.stringify(diagnosticBundle, null, 2))");
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
    expect(renderer).toContain('api("/api/v1/management/connectivity/status")');
    expect(renderer).toContain('showRemoteConfirmation("enable")');
    expect(renderer).toContain('api("/api/v1/management/connectivity/tailscale-serve", "POST", {})');
    expect(renderer).toContain('api("/api/v1/management/connectivity/tailscale-serve", "DELETE")');
    expect(styles).toContain(".remote-access-confirmation[hidden]");
  });

  it("shows desktop update state, progress, checks, and restart installation inline", () => {
    for (const id of ["check-desktop-update", "install-desktop-update", "desktop-update-label", "desktop-update-progress"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(renderer).toContain("window.fitz.updateStatus().then(renderDesktopUpdate)");
    expect(renderer).toContain("Downloading update · ${Math.round(percent)}%");
    expect(preload).toContain('ipcRenderer.invoke("fitz:update-status")');
    expect(main).toContain('autoUpdater.on("download-progress"');
    expect(main).toContain('publishUpdateStatus({ state: "development" })');
    expect(styles).toContain(".desktop-update-track");
  });

  it("manages packaged host startup inline with staged confirmation", () => {
    for (const id of ["host-startup-status", "install-host-startup", "remove-host-startup", "host-startup-confirmation", "confirm-host-startup"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(renderer).toContain('api("/api/v1/management/startup")');
    expect(renderer).toContain('showStartupConfirmation("install")');
    expect(renderer).toContain('action === "install" ? "POST" : "DELETE"');
    expect(styles).toContain(".host-startup-status");
  });
});
