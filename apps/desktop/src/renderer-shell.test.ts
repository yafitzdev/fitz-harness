import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./renderer/index.html", import.meta.url), "utf8");
const renderer = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("desktop renderer shell", () => {
  it("wires every visible shell action to a renderer interaction", () => {
    const actions = [
      "sidebar-menu",
      "sidebar-restore",
      "sidebar-resizer",
      "new-session",
      "manage-playbooks",
      "create-management",
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
    expect(html).toContain('id="management-editor"');
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
});
