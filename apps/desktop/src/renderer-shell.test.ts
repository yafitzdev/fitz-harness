import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./renderer/index.html", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./renderer/styles.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

describe("desktop renderer shell", () => {
  it("wires every visible shell action to a renderer interaction", () => {
    const actions = [
      "sidebar-menu",
      "sidebar-restore",
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
    expect(html).toContain('data-app-menu="File"');
    expect(html).toContain('data-window-action="minimize"');
    expect(main).toContain("frame: false");
    expect(main).toContain('ipcMain.handle("fitz:show-menu"');
    expect(main).toContain('ipcMain.handle("fitz:window-action"');
    expect(main).not.toContain("window.getBounds()");
  });

  it("opens Playbooks as a first-class searchable workspace page", () => {
    expect(html).toContain('id="playbook-page"');
    expect(html).not.toContain('data-management-view=');
    expect(html).toContain('id="playbook-search"');
    expect(renderer).toContain("openPlaybookPage()");
    expect(renderer).toContain("renderManagementPage()");
    expect(renderer).toContain("FIXED_ROUTES");
    expect(renderer).toContain("assignFixedRoute(");
    expect(renderer).not.toContain("now uses ${recipe.displayName}");
    expect(renderer).toContain("openEngineEditor");
    expect(renderer).toContain('/api/v1/management/engines/${encodeURIComponent(folderName)}');
    expect(renderer).not.toContain("ENGINE_CATALOG");
    expect(html).not.toContain("Add engine");
    expect(html).not.toContain("engine-root-path");
    expect(renderer).not.toContain('status.textContent = engine ? "Registered"');
    expect(renderer).not.toContain("${folder.rootPath}");
    expect(styles).toContain(".recipe-route-toggle { align-self: center; display: flex; align-items: center; gap: 1px; margin-right: 12px; padding: 2px; border: 0;");
    expect(renderer).toContain('class="route-icon-cut"');
    expect(renderer).toContain('class="route-icon-filled" fill-rule="evenodd"');
    expect(html).not.toContain("NiNfer");
    expect(html).not.toContain("llama.cpp");
    expect(html).not.toContain("vLLM");
    expect(renderer).toContain("showConversationWorkspace()");
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
    expect(renderer).toContain("maxTokens: Number(effort.value)");
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
    expect(styles).toContain("width: min(768px, calc(100% - 36px))");
    expect(styles).toContain("max-width: min(77%, 620px)");
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
    expect(styles).toContain(".project-group:hover > .tree-item .tree-quick-action");
    for (const label of ["Pin project", "Open in Explorer", "Create permanent worktree", "Edit project", "Archive chats", "Remove"]) {
      expect(renderer).toContain(`"${label}"`);
    }
    expect(renderer).toContain('api(`/api/v1/projects/${id}`, "DELETE")');
  });

  it("clears the starter screen and reports model loading before output arrives", () => {
    expect(renderer).toContain('messages.querySelector(".landing, .new-chat-landing")');
    expect(renderer).toContain('appendRunActivity("Starting model…")');
    expect(renderer).toContain('setRunActivity(activity, "Loading model", runStartedAt)');
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

  it("pairs a desktop without exposing its durable bearer credential to the renderer", () => {
    for (const id of ["pairing-page", "pairing-form", "pairing-code", "pairing-display-name", "pairing-device-name", "pairing-error"]) expect(html).toContain(`id="${id}"`);
    expect(renderer).toContain("showPairingPage(`Enter a one-time code to connect to ${configuredHostOrigin}.`)");
    expect(renderer).toContain("window.fitz.pairDevice");
    expect(preload).toContain('ipcRenderer.invoke("fitz:pair-device"');
    expect(preload).toContain('ipcRenderer.invoke("fitz:connection-info"');
    expect(main).toContain('ipcMain.handle("fitz:pair-device"');
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
});
