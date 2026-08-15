import { ComposerControls, type ComposerControlsElements } from "./composer-controls.js";
import { svgIcon as svg, textBlock } from "../primitives/dom.js";
import { togglePopover } from "../primitives/popover.js";
import type { DesktopBridge } from "../../preload.js";
import type { MediaModality } from "@fitz/protocol";

export type PastedAttachment = { dataUrl: string; mimeType: string; name: string; kind: "image" | "pdf" | "file" };
export interface ComposerSubmission { content: string; mediaCommand?: MediaModality }

export interface ComposerOptions {
  mount: HTMLElement;
  getProjectRoot: () => string | undefined;
  bridge: Pick<DesktopBridge, "gitBranches" | "checkoutBranch" | "createBranch" | "createWorktree">;
  closeAllPopovers: () => void;
  onRouteChange: () => void;
  onEffortChange?: () => void;
  onCompact: () => void | Promise<void>;
  onSubmit: (submission: ComposerSubmission) => void | Promise<void>;
  onInput: (text: string) => void;
  onValueChange: (text: string) => void;
  onAttach: () => void;
  onDismissProject: () => void;
  onPreviewPasted: (kind: "image" | "pdf", dataUrl: string, mimeType: string, name: string) => void;
  onWorktreeCreated: (path: string, branch: string) => void | Promise<void>;
  onError: (message: string) => void;
  isRunning: () => boolean;
}

type PastedFile = PastedAttachment & { chip: HTMLElement };

const COMPOSER_TEMPLATE = `
  <h1 class="new-chat-heading">What should we build?</h1>
  <button id="scroll-to-bottom" class="scroll-to-bottom" type="button" aria-label="Go to latest message" title="Go to latest message" hidden>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15M5.5 12.5 12 19l6.5-6.5"></path></svg>
  </button>
  <form id="composer" class="composer-card">
    <div id="composer-attachments" class="composer-attachments" hidden></div>
    <div id="new-chat-context" class="new-chat-context" hidden>
      <button id="new-chat-project-control" class="new-chat-context-item project-context-control" type="button" title="Don't work in a project" aria-label="Don't work in a project">
        <svg class="context-project-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>
        <svg class="context-remove-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2"></circle><path d="m7.7 7.7 4.6 4.6M12.3 7.7l-4.6 4.6"></path></svg>
        <span id="new-chat-project"></span>
      </button>
      <div class="context-control-wrap">
        <button id="new-chat-environment-control" class="new-chat-context-item" type="button" aria-label="Choose execution environment" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.2" width="14" height="9.4" rx="1.4"></rect><path d="M1.8 16h16.4"></path></svg><span id="new-chat-environment-label">Local</span></button>
        <div id="new-chat-environment-menu" class="popover context-choice-menu environment-choice-menu" hidden>
          <small>Workspace</small>
          <button type="button" data-environment-choice="local"><svg viewBox="0 0 20 20"><rect x="3" y="4.2" width="14" height="9.4" rx="1.4"></rect><path d="M1.8 16h16.4"></path></svg><span>Work locally</span><b>✓</b></button>
          <button type="button" data-environment-choice="worktree"><svg viewBox="0 0 20 20"><path d="M4 6h8M12 3l3 3-3 3M16 14H8M8 11l-3 3 3 3"></path></svg><span>New worktree</span></button>
          <button type="button" data-environment-choice="cloud" disabled><svg viewBox="0 0 20 20"><path d="M5.5 15.5h9a3 3 0 0 0 .5-6 5 5 0 0 0-9.4-1.4A3.8 3.8 0 0 0 5.5 15.5z"></path></svg><span>Cloud</span></button>
          <div id="create-worktree-form" class="create-branch-form" hidden><input id="new-worktree-branch" placeholder="Worktree branch" autocomplete="off"><button id="create-worktree-submit" type="button">Create</button></div>
          <hr>
          <button type="button" data-environment-choice="usage"><svg viewBox="0 0 20 20"><path d="M4 14.5a7 7 0 1 1 12 0"></path><path d="m10 11 3-3"></path></svg><span>Context usage</span><svg class="choice-chevron" viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"></path></svg></button>
        </div>
      </div>
      <div class="context-control-wrap">
        <button id="new-chat-branch-control" class="new-chat-context-item" type="button" aria-label="Choose branch" aria-expanded="false"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="6" cy="4.5" r="1.5"></circle><circle cx="6" cy="15.5" r="1.5"></circle><circle cx="14" cy="7" r="1.5"></circle><path d="M6 6v8M7.5 12.5c4 0 6.5-1.5 6.5-4"></path></svg><span id="new-chat-branch-label">main</span></button>
        <div id="new-chat-branch-menu" class="popover context-choice-menu branch-choice-menu" hidden>
          <label class="branch-search"><svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5"></circle><path d="m12.2 12.2 4 4"></path></svg><input id="branch-search" type="search" placeholder="Search branches" autocomplete="off"></label>
          <small>Branches</small>
          <div id="branch-list" class="branch-list"></div>
          <div id="create-branch-form" class="create-branch-form" hidden><input id="new-branch-name" placeholder="New branch name" autocomplete="off"><button id="create-branch-submit" type="button">Create</button></div>
          <button id="show-create-branch" class="create-branch-toggle" type="button"><svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"></path></svg><span>Create and checkout new branch…</span></button>
        </div>
      </div>
    </div>
    <div class="prompt-row">
      <button id="media-command-tag" class="media-command-tag" type="button" hidden></button>
      <textarea id="prompt" rows="1" placeholder="Do anything" aria-label="Message" disabled></textarea>
    </div>
    <div class="composer-toolbar">
      <div class="composer-tools">
        <div class="composer-add-wrap">
          <button id="attach" class="icon-button" type="button" title="Add to message" aria-label="Add to message" aria-expanded="false" disabled>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"></path></svg>
          </button>
          <div id="composer-add-menu" class="popover composer-add-menu" hidden>
            <button type="button" data-composer-command="image"><svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"></rect><circle cx="7" cy="8" r="1.2"></circle><path d="m4.5 14 3.8-3.7 2.6 2.4 1.8-1.7 2.8 3"></path></svg><span><strong>/image</strong><small>Create an image</small></span></button>
            <button type="button" data-composer-command="video"><svg viewBox="0 0 20 20"><rect x="3" y="5" width="10" height="10" rx="2"></rect><path d="m13 8 4-2v8l-4-2"></path></svg><span><strong>/video</strong><small>Create a video</small></span></button>
            <button type="button" data-composer-command="audio"><svg viewBox="0 0 20 20"><path d="M5 13V7l9-2v6"></path><circle cx="4" cy="14" r="2"></circle><circle cx="13" cy="12" r="2"></circle></svg><span><strong>/audio</strong><small>Create music or audio</small></span></button>
            <hr>
            <button id="upload-file" type="button"><svg viewBox="0 0 20 20"><path d="M10 13V3M6 7l4-4 4 4"></path><path d="M4 11v5h12v-5"></path></svg><span><strong>Upload file</strong><small>Add a file to this message</small></span></button>
          </div>
        </div>
        <div class="access-mode-wrap">
          <button id="access-mode-toggle" class="access-label" type="button" aria-label="Tool access mode" aria-expanded="false">
            <svg id="access-mode-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M10 7v3.2M10 13h.01"></path></svg><span id="access-mode-label">Full access</span>
          </button>
          <div id="access-mode-menu" class="popover access-mode-menu" hidden>
            <button type="button" data-access-mode="full"><svg viewBox="0 0 20 20"><path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M10 7v3.2M10 13h.01"></path></svg><span><strong>Full access</strong><small>Run all tools automatically</small></span></button>
            <button type="button" data-access-mode="ask"><svg viewBox="0 0 20 20"><path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M8.4 8.1a1.8 1.8 0 1 1 2.5 1.7c-.8.4-.9.8-.9 1.3M10 13.7h.01"></path></svg><span><strong>Ask first</strong><small>Approve commands and edits inline</small></span></button>
            <button type="button" data-access-mode="read-only"><svg viewBox="0 0 20 20"><rect x="4.2" y="8.5" width="11.6" height="8" rx="2"></rect><path d="M6.8 8.5V6.3a3.2 3.2 0 0 1 6.4 0v2.2"></path></svg><span><strong>Read only</strong><small>Allow inspection, block changes</small></span></button>
          </div>
        </div>
      </div>
      <div class="composer-controls">
        <div class="context-usage-wrap">
          <button id="context-meter" class="context-meter" type="button" title="Context window usage" aria-label="Context window usage"></button>
          <div id="context-usage-popover" class="popover context-usage-popover" hidden>
            <span>Context window:</span><strong id="context-percent">0% full</strong><b id="context-tokens">0 / 128k tokens used</b>
            <small id="agent-topology-summary" class="context-topology-summary" hidden></small>
            <button id="context-compact" type="button">Compact now</button><small id="context-compact-status" hidden></small>
          </div>
        </div>
        <div class="model-picker">
          <button id="model-toggle" class="model-toggle" type="button" aria-label="Model settings" aria-expanded="false" disabled><span id="model-summary"><span id="model-route">Model</span><span id="model-effort"> · Medium</span></span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"></path></svg></button>
          <div id="model-menu" class="popover model-menu" hidden>
            <div id="model-menu-root">
              <button class="setting-row" type="button" data-setting="model"><span>Model</span><span><span id="model-value">Model</span><svg viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"></path></svg></span></button>
              <button class="setting-row" type="button" data-setting="effort"><span>Effort</span><span><span id="effort-value">Medium</span><svg viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"></path></svg></span></button>
              <div class="settings-divider"></div>
              <button id="advanced-settings" class="advanced-row" type="button" aria-expanded="false"><span>Advanced</span><svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"></path></svg></button>
              <div id="advanced-settings-panel" class="advanced-settings-panel" hidden>
                <label for="temperature"><span>Temperature</span><output id="temperature-value" for="temperature">0.4</output></label>
                <input id="temperature" type="range" min="0" max="2" step="0.1" value="0.4">
                <small>Lower is focused; higher is more varied.</small>
              </div>
            </div>
            <div id="settings-submenu" class="settings-submenu" hidden></div>
            <select id="model" aria-label="Model route" hidden disabled></select>
            <select id="effort" aria-label="Effort" hidden><option value="light" data-max-tokens="4096">Light</option><option value="normal" data-max-tokens="10240" selected>Medium</option><option value="high" data-max-tokens="24576">High</option></select>
          </div>
        </div>
        <span id="status" class="run-status visually-hidden" data-state="loading">Connecting</span>
        <button id="send" class="send-button" type="submit" title="Send message" aria-label="Send message" disabled>
          <svg class="send-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5M6 9l4-4 4 4"></path></svg>
          <svg class="stop-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1"></rect></svg>
        </button>
      </div>
    </div>
  </form>
`;

export class Composer {
  readonly root: HTMLElement;
  readonly scrollButton: HTMLButtonElement;
  readonly controls: ComposerControls;
  private readonly options: ComposerOptions;
  private readonly prompt: HTMLTextAreaElement;
  private readonly mediaCommandTag: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly composerAttachments: HTMLElement;
  private readonly newChatContext: HTMLElement;
  private readonly newChatProject: HTMLElement;
  private readonly newChatProjectControl: HTMLButtonElement;
  private readonly newChatEnvironmentControl: HTMLButtonElement;
  private readonly newChatEnvironmentMenu: HTMLElement;
  private readonly createWorktreeForm: HTMLElement;
  private readonly newWorktreeBranch: HTMLInputElement;
  private readonly newChatBranchControl: HTMLButtonElement;
  private readonly newChatBranchLabel: HTMLElement;
  private readonly newChatBranchMenu: HTMLElement;
  private readonly branchSearch: HTMLInputElement;
  private readonly branchList: HTMLElement;
  private readonly createBranchForm: HTMLElement;
  private readonly newBranchName: HTMLInputElement;
  private readonly showCreateBranch: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly attachButton: HTMLButtonElement;
  private readonly addMenu: HTMLElement;
  private readonly pastedFiles: PastedFile[] = [];
  private promptHistory: string[] = [];
  private promptHistoryIndex = -1;
  private promptDraft = "";
  private currentBranch = "main";
  private availableBranches: string[] = [];
  private mediaCommand: MediaModality | undefined;

  constructor(options: ComposerOptions) {
    this.options = options;
    this.root = document.createElement("div");
    this.root.className = "composer-dock";
    this.root.innerHTML = COMPOSER_TEMPLATE;
    options.mount.append(this.root);
    this.scrollButton = this.el<HTMLButtonElement>("#scroll-to-bottom");
    this.form = this.el<HTMLFormElement>("#composer");
    this.composerAttachments = this.el<HTMLElement>("#composer-attachments");
    this.newChatContext = this.el<HTMLElement>("#new-chat-context");
    this.newChatProject = this.el<HTMLElement>("#new-chat-project");
    this.newChatProjectControl = this.el<HTMLButtonElement>("#new-chat-project-control");
    this.newChatEnvironmentControl = this.el<HTMLButtonElement>("#new-chat-environment-control");
    this.newChatEnvironmentMenu = this.el<HTMLElement>("#new-chat-environment-menu");
    this.createWorktreeForm = this.el<HTMLElement>("#create-worktree-form");
    this.newWorktreeBranch = this.el<HTMLInputElement>("#new-worktree-branch");
    this.newChatBranchControl = this.el<HTMLButtonElement>("#new-chat-branch-control");
    this.newChatBranchLabel = this.el<HTMLElement>("#new-chat-branch-label");
    this.newChatBranchMenu = this.el<HTMLElement>("#new-chat-branch-menu");
    this.branchSearch = this.el<HTMLInputElement>("#branch-search");
    this.branchList = this.el<HTMLElement>("#branch-list");
    this.createBranchForm = this.el<HTMLElement>("#create-branch-form");
    this.newBranchName = this.el<HTMLInputElement>("#new-branch-name");
    this.showCreateBranch = this.el<HTMLButtonElement>("#show-create-branch");
    this.status = this.el<HTMLElement>("#status");
    this.sendButton = this.el<HTMLButtonElement>("#send");
    this.attachButton = this.el<HTMLButtonElement>("#attach");
    this.addMenu = this.el<HTMLElement>("#composer-add-menu");
    this.prompt = this.el<HTMLTextAreaElement>("#prompt");
    this.mediaCommandTag = this.el<HTMLButtonElement>("#media-command-tag");
    const controlsElements = this.controlsElements();
    document.body.append(controlsElements.modelMenu);
    this.controls = new ComposerControls(controlsElements, {
      closeAllPopovers: options.closeAllPopovers,
      onRouteChange: options.onRouteChange,
      onEffortChange: () => options.onEffortChange?.(),
      onCompact: options.onCompact,
    });
    this.bind();
  }

  get value(): string { return this.prompt.value; }
  get submission(): ComposerSubmission {
    const value = this.prompt.value;
    if (this.mediaCommand) return { content: value, mediaCommand: this.mediaCommand };
    // A bare slash command with no trailing space never shows the tag bubble, but
    // submitting it still routes to the media flow (e.g. `/video` + Enter).
    const bare = /^\/(video|audio|image)$/i.exec(value);
    if (bare) return { content: "", mediaCommand: bare[1]!.toLowerCase() as MediaModality };
    return { content: value };
  }

  focus(): void { this.prompt.focus(); }

  setDraft(text: string): void {
    this.applyDraft(text);
    this.resize();
    this.options.onInput(this.value);
  }

  clearDraft(): void {
    this.prompt.value = "";
    this.setMediaCommand(undefined);
    this.resize();
  }

  setStatus(text: string, state: string): void {
    this.status.textContent = text;
    this.status.dataset.state = state;
  }

  setState(state: { ready: boolean; running: boolean; generating?: boolean; hasSession: boolean }): void {
    const { ready, running, generating = false, hasSession } = state;
    const hasText = this.value.trim().length > 0;
    const busy = running || generating;
    // The composer stays unlocked while the agent is reasoning so the user can write
    // a steering message; sending routes it into the running conversation instead of
    // canceling. With an empty draft the send button becomes the stop control. A
    // media job in flight behaves the same way: empty draft stops the job, typed
    // text sends a regular message (steering only applies to agent runs).
    this.prompt.disabled = !ready;
    this.controls.updateState({ running, hasSession });
    this.attachButton.disabled = !hasSession || running;
    const stopVisible = busy && !hasText;
    this.sendButton.classList.toggle("running", stopVisible);
    this.sendButton.title = running
      ? (hasText ? "Send to the running agent" : "Stop task")
      : generating && !hasText ? "Stop task"
      : "Send message";
    this.sendButton.setAttribute("aria-label", this.sendButton.title);
    this.sendButton.disabled = busy ? false : !ready || !hasText;
  }

  rebuildHistory(texts: string[]): void {
    this.promptHistory = texts;
    this.promptHistoryIndex = -1;
    this.promptDraft = "";
  }

  pushHistory(text: string): void {
    this.promptHistory.push(text);
    this.promptHistoryIndex = -1;
    this.promptDraft = "";
  }

  resetHistory(): void {
    this.promptHistory = [];
    this.promptHistoryIndex = -1;
    this.promptDraft = "";
  }

  enterNewChat(projectName: string | undefined): void {
    this.prompt.blur();
    this.newChatContext.hidden = projectName === undefined;
    this.newChatProject.textContent = projectName ?? "";
    this.newChatProjectControl.hidden = projectName === undefined;
    this.prompt.value = "";
    this.setMediaCommand(undefined);
    this.resize();
    this.resetHistory();
    this.composerAttachments.replaceChildren();
    this.pastedFiles.splice(0);
    this.refreshAttachments();
  }

  exitNewChat(): void {
    if (this.root.classList.contains("new-chat-launching")) {
      window.setTimeout(() => this.root.classList.remove("new-chat-launching"), 220);
    } else this.root.classList.remove("new-chat-launching");
    this.newChatContext.hidden = true;
  }

  openWorktreeSetup(): void {
    this.newChatEnvironmentMenu.hidden = false;
    this.newChatEnvironmentControl.setAttribute("aria-expanded", "true");
    this.createWorktreeForm.hidden = false;
    this.newWorktreeBranch.focus();
  }

  async refreshBranches(): Promise<void> {
    const rootPath = this.options.getProjectRoot();
    if (!rootPath) { this.applyBranchState("main", ["main"]); return; }
    try {
      const state = await this.options.bridge.gitBranches(rootPath);
      this.applyBranchState(state.current || "main", state.branches.length ? state.branches : [state.current || "main"]);
    } catch {
      this.applyBranchState("main", ["main"]);
    }
  }

  addArtifactChip(name: string, sizeLabel: string, onPreview: () => void, onRemove: () => void): HTMLElement {
    const chip = document.createElement("div"); chip.className = "attachment-chip";
    const chipPreview = document.createElement("button"); chipPreview.type = "button"; chipPreview.className = "attachment-preview"; chipPreview.setAttribute("aria-label", `Preview ${name}`);
    const chipName = document.createElement("span"); chipName.textContent = name;
    const chipSize = document.createElement("small"); chipSize.textContent = sizeLabel;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "attachment-remove"; remove.title = `Remove ${name}`; remove.setAttribute("aria-label", `Remove ${name}`); remove.textContent = "×";
    chipPreview.append(chipName, chipSize); chipPreview.addEventListener("click", () => onPreview());
    remove.addEventListener("click", () => {
      // The chip is an attachment to the composer, not the durable artifact
      // itself. Closing it must never delete generated media from the task.
      chip.remove();
      this.refreshAttachments();
      onRemove();
    });
    chip.append(chipPreview, remove);
    this.composerAttachments.append(chip);
    this.refreshAttachments();
    return chip;
  }

  clearArtifactChips(): void {
    // Preserve pasted file chips; only remove artifact chips
    const pastedChips = this.pastedFiles.map((pasted) => pasted.chip);
    this.composerAttachments.replaceChildren();
    pastedChips.forEach((chip) => this.composerAttachments.append(chip));
    this.refreshAttachments();
  }

  consumePastedAttachments(): PastedAttachment[] {
    const captured = this.pastedFiles.splice(0);
    captured.forEach((pasted) => pasted.chip.remove());
    this.refreshAttachments();
    return captured.map((pasted) => ({ dataUrl: pasted.dataUrl, mimeType: pasted.mimeType, name: pasted.name, kind: pasted.kind }));
  }

  /**
   * Stages a file picked from the file chooser as a pasted attachment chip.
   * Used by the "+" button before a session exists (new chat), so the file
   * rides along with the first message instead of being uploaded immediately.
   */
  attachFile(file: File): void {
    if (this.options.isRunning()) return;
    const kind = file.type.startsWith("image/") ? "image" : file.type === "application/pdf" ? "pdf" : "file";
    if (file.size > 5_000_000) { this.options.onError("Attached file is too large (max 5 MB)"); return; }
    this.readPastedFile(file, kind);
  }

  closePopovers(): void {
    this.controls.closePopovers();
    this.addMenu.hidden = true;
    this.attachButton.setAttribute("aria-expanded", "false");
    this.newChatEnvironmentMenu.hidden = true;
    this.newChatBranchMenu.hidden = true;
    this.newChatEnvironmentControl.setAttribute("aria-expanded", "false");
    this.newChatBranchControl.setAttribute("aria-expanded", "false");
  }

  private el<T extends HTMLElement>(selector: string): T {
    const node = this.root.querySelector<T>(selector);
    if (!node) throw new Error(`Composer element not found: ${selector}`);
    return node;
  }

  private controlsElements(): ComposerControlsElements {
    return {
      model: this.el<HTMLSelectElement>("#model"),
      effort: this.el<HTMLSelectElement>("#effort"),
      modelToggle: this.el<HTMLButtonElement>("#model-toggle"),
      modelMenu: this.el<HTMLElement>("#model-menu"),
      modelMenuRoot: this.el<HTMLElement>("#model-menu-root"),
      modelSummary: this.el<HTMLElement>("#model-summary"),
      modelRoute: this.el<HTMLElement>("#model-route"),
      modelEffort: this.el<HTMLElement>("#model-effort"),
      modelValue: this.el<HTMLElement>("#model-value"),
      effortValue: this.el<HTMLElement>("#effort-value"),
      settingsSubmenu: this.el<HTMLElement>("#settings-submenu"),
      settingRows: [...this.root.querySelectorAll<HTMLButtonElement>("[data-setting]")],
      advancedSettings: this.el<HTMLButtonElement>("#advanced-settings"),
      advancedSettingsPanel: this.el<HTMLElement>("#advanced-settings-panel"),
      temperature: this.el<HTMLInputElement>("#temperature"),
      temperatureValue: this.el<HTMLElement>("#temperature-value"),
      agentTopologySummary: this.el<HTMLElement>("#agent-topology-summary"),
      contextMeter: this.el<HTMLButtonElement>("#context-meter"),
      contextUsagePopover: this.el<HTMLElement>("#context-usage-popover"),
      contextPercent: this.el<HTMLElement>("#context-percent"),
      contextTokens: this.el<HTMLElement>("#context-tokens"),
      contextCompactButton: this.el<HTMLButtonElement>("#context-compact"),
      contextCompactStatus: this.el<HTMLElement>("#context-compact-status"),
      accessModeToggle: this.el<HTMLButtonElement>("#access-mode-toggle"),
      accessModeMenu: this.el<HTMLElement>("#access-mode-menu"),
      accessModeLabel: this.el<HTMLElement>("#access-mode-label"),
      accessModeIcon: this.root.querySelector<SVGElement>("#access-mode-icon")!,
      accessModeChoices: [...this.root.querySelectorAll<HTMLButtonElement>("[data-access-mode]")],
    };
  }

  private bind(): void {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const launch = this.root.parentElement?.classList.contains("new-chat-open") ?? false;
      if (launch) this.root.classList.add("new-chat-launching");
      void Promise.resolve(this.options.onSubmit(this.submission)).finally(() => {
        if (this.root.parentElement?.classList.contains("new-chat-open")) this.root.classList.remove("new-chat-launching");
      });
    });
    this.prompt.addEventListener("input", () => {
      if (this.promptHistoryIndex !== -1) { this.promptHistoryIndex = -1; this.promptDraft = ""; }
      this.captureMediaCommand();
      this.resize();
      this.options.onInput(this.value);
    });
    this.prompt.addEventListener("paste", (event) => this.handlePaste(event));
    this.prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.form.requestSubmit();
        return;
      }
      if (event.key === "Backspace" && this.mediaCommand && this.prompt.selectionStart === 0 && this.prompt.selectionEnd === 0) {
        event.preventDefault();
        this.setMediaCommand(undefined);
        this.options.onValueChange(this.value);
        return;
      }
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing) {
        const browsing = this.promptHistoryIndex !== -1;
        const atStart = this.prompt.selectionStart === 0;
        if (event.key === "ArrowUp" ? browsing || atStart : browsing) {
          if (this.navigatePromptHistory(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
        }
      }
    });
    this.attachButton.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover(this.addMenu, this.attachButton, this.options.closeAllPopovers);
    });
    this.addMenu.addEventListener("click", (event) => event.stopPropagation());
    for (const command of this.root.querySelectorAll<HTMLButtonElement>("[data-composer-command]")) command.addEventListener("click", () => {
      this.setMediaCommand(command.dataset.composerCommand as MediaModality);
      this.closePopovers();
      this.options.onValueChange(this.value);
      this.prompt.focus();
    });
    this.el<HTMLButtonElement>("#upload-file").addEventListener("click", () => {
      this.closePopovers();
      this.options.onAttach();
    });
    this.mediaCommandTag.addEventListener("click", () => {
      this.setMediaCommand(undefined);
      this.options.onValueChange(this.value);
      this.prompt.focus();
    });
    this.newChatProjectControl.addEventListener("click", (event) => {
      event.stopPropagation();
      this.newChatProjectControl.hidden = true;
      this.options.onDismissProject();
    });
    this.newChatEnvironmentControl.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover(this.newChatEnvironmentMenu, this.newChatEnvironmentControl, this.options.closeAllPopovers);
    });
    this.newChatBranchControl.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.openBranchMenu();
    });
    this.newChatEnvironmentMenu.addEventListener("click", (event) => event.stopPropagation());
    this.newChatBranchMenu.addEventListener("click", (event) => event.stopPropagation());
    for (const choice of this.root.querySelectorAll<HTMLButtonElement>("[data-environment-choice]")) choice.addEventListener("click", () => this.chooseEnvironment(choice.dataset.environmentChoice ?? ""));
    this.branchSearch.addEventListener("input", () => this.renderBranchList());
    this.showCreateBranch.addEventListener("click", () => { this.showCreateBranch.hidden = true; this.createBranchForm.hidden = false; this.newBranchName.focus(); });
    this.el<HTMLButtonElement>("#create-branch-submit").addEventListener("click", () => void this.createAndCheckoutBranch());
    this.newBranchName.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void this.createAndCheckoutBranch(); } });
    this.el<HTMLButtonElement>("#create-worktree-submit").addEventListener("click", () => void this.createWorktree());
    this.newWorktreeBranch.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void this.createWorktree(); } });
  }

  private resize(): void {
    this.prompt.style.height = "auto";
    this.prompt.style.height = `${Math.min(this.prompt.scrollHeight, 180)}px`;
  }

  private applyDraft(text: string): void {
    this.setMediaCommand(undefined);
    this.prompt.value = text;
    this.captureMediaCommand();
  }

  private captureMediaCommand(): void {
    if (this.mediaCommand) return;
    const match = /^\/(video|audio|image)(?=\s)/i.exec(this.prompt.value);
    if (!match) return;
    this.setMediaCommand(match[1]!.toLowerCase() as MediaModality);
    this.prompt.value = this.prompt.value.slice(match[0].length).replace(/^\s/, "");
  }

  private setMediaCommand(command: MediaModality | undefined): void {
    this.mediaCommand = command;
    this.mediaCommandTag.hidden = !command;
    this.mediaCommandTag.textContent = command ?? "";
    this.mediaCommandTag.title = command ? `Remove /${command}` : "";
    this.mediaCommandTag.setAttribute("aria-label", command ? `Remove ${command} command` : "Media command");
  }

  private refreshAttachments(): void {
    this.composerAttachments.hidden = this.composerAttachments.childElementCount === 0;
  }

  private handlePaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      const kind = item.type.startsWith("image/") ? "image" : item.type === "application/pdf" ? "pdf" : undefined;
      if (!kind) continue;
      event.preventDefault();
      // Steering is text-only for now; pasted files wait for the next regular message.
      if (this.options.isRunning()) return;
      const file = item.getAsFile();
      if (!file) continue;
      if (file.size > 5_000_000) { this.options.onError("Pasted file is too large (max 5 MB)"); return; }
      this.readPastedFile(file, kind);
      break;
    }
  }

  private readPastedFile(file: File, kind: "image" | "pdf" | "file"): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const name = kind === "pdf"
        ? (file.name && /\.pdf$/i.test(file.name) ? file.name : `document-${Date.now()}.pdf`)
        : kind === "image" ? `screenshot-${Date.now()}.png`
        : (file.name || `file-${Date.now()}`);
      const chip = this.createPastedFileChip(dataUrl, file.type || (kind === "pdf" ? "application/pdf" : "application/octet-stream"), name, kind, () => this.removePastedFile(chip));
      this.composerAttachments.append(chip);
      this.pastedFiles.push({ dataUrl, mimeType: file.type || (kind === "pdf" ? "application/pdf" : "application/octet-stream"), name, kind, chip });
      this.refreshAttachments();
    };
    reader.readAsDataURL(file);
  }

  private createPastedFileChip(dataUrl: string, mimeType: string, name: string, kind: "image" | "pdf" | "file", onRemove: () => void): HTMLElement {
    const chip = document.createElement("div");
    chip.className = `attachment-chip ${kind === "image" ? "image-chip" : kind === "pdf" ? "pdf-chip" : "file-chip"}`;
    if (kind === "image") {
      chip.style.width = "96px";
      chip.style.height = "96px";
      chip.style.minWidth = "96px";
    }

    if (kind === "file") {
      // Generic files have no preview yet: a static body with an icon and name.
      const body = document.createElement("div");
      body.className = "file-chip-body";
      const icon = svg('<path d="M5 2.8h6l4 4v10.4H5z"></path><path d="M11 2.8v4h4"></path><path d="M7.5 9.5h5M7.5 12h5M7.5 14.5h3"></path>');
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "file-name";
      label.textContent = name;
      body.append(icon, label);
      chip.append(body);
    } else {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = `attachment-preview ${kind === "pdf" ? "pdf-preview" : "image-preview"}`;
      preview.title = kind === "pdf" ? "Preview PDF" : "Preview image";
      preview.setAttribute("aria-label", preview.title);
      preview.addEventListener("click", () => {
        this.options.onPreviewPasted(kind, dataUrl, mimeType, name);
      });

      if (kind === "image") {
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = "Pasted image";
        preview.append(img);
      } else {
        const icon = svg('<path d="M5 2.8h6l4 4v10.4H5z"></path><path d="M11 2.8v4h4"></path><path d="M7.5 9.5h5M7.5 12h5M7.5 14.5h3"></path>');
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "pdf-name";
        label.textContent = name;
        preview.append(icon, label);
      }
      chip.append(preview);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => { onRemove(); });

    chip.append(remove);
    return chip;
  }

  private removePastedFile(chip: HTMLElement): void {
    const index = this.pastedFiles.findIndex((pasted) => pasted.chip === chip);
    if (index >= 0) this.pastedFiles.splice(index, 1);
    chip.remove();
    this.refreshAttachments();
  }

  private navigatePromptHistory(direction: -1 | 1): boolean {
    if (!this.promptHistory.length) return false;
    if (direction === -1) {
      if (this.promptHistoryIndex === -1) {
        this.promptDraft = this.mediaCommand ? `/${this.mediaCommand} ${this.prompt.value}` : this.prompt.value;
        this.promptHistoryIndex = this.promptHistory.length - 1;
      } else if (this.promptHistoryIndex > 0) {
        this.promptHistoryIndex--;
      } else {
        return false; // already at the oldest entry
      }
    } else {
      if (this.promptHistoryIndex === -1) return false; // not browsing
      if (this.promptHistoryIndex < this.promptHistory.length - 1) {
        this.promptHistoryIndex++;
      } else {
        // Past the newest entry: restore the draft the user was typing.
        this.promptHistoryIndex = -1;
        this.applyDraft(this.promptDraft);
        this.promptDraft = "";
        this.afterPromptHistoryChange();
        return true;
      }
    }
    this.applyDraft(this.promptHistory[this.promptHistoryIndex] ?? "");
    this.afterPromptHistoryChange();
    return true;
  }

  private afterPromptHistoryChange(): void {
    this.resize();
    this.options.onValueChange(this.value);
    this.prompt.selectionStart = this.prompt.selectionEnd = this.prompt.value.length;
  }

  private applyBranchState(current: string, branches: string[]): void {
    this.currentBranch = current;
    this.availableBranches = branches;
    this.newChatBranchLabel.textContent = current;
    this.renderBranchList();
  }

  private async openBranchMenu(): Promise<void> {
    const opening = this.newChatBranchMenu.hidden;
    this.closePopovers();
    if (!opening) return;
    this.newChatBranchMenu.hidden = false;
    this.newChatBranchControl.setAttribute("aria-expanded", "true");
    this.branchSearch.value = "";
    this.showCreateBranch.hidden = false;
    this.createBranchForm.hidden = true;
    await this.refreshBranches();
    this.branchSearch.focus();
  }

  private renderBranchList(): void {
    const query = this.branchSearch.value.trim().toLowerCase();
    this.branchList.replaceChildren();
    for (const branch of this.availableBranches.filter((value) => value.toLowerCase().includes(query))) {
      const button = document.createElement("button"); button.type = "button"; button.classList.toggle("selected", branch === this.currentBranch);
      button.append(svg('<circle cx="6" cy="4.5" r="1.5"></circle><circle cx="6" cy="15.5" r="1.5"></circle><circle cx="14" cy="7" r="1.5"></circle><path d="M6 6v8M7.5 12.5c4 0 6.5-1.5 6.5-4"></path>'), Object.assign(document.createElement("span"), { textContent: branch }));
      button.addEventListener("click", () => void this.checkoutBranch(branch)); this.branchList.append(button);
    }
    if (!this.branchList.childElementCount) this.branchList.append(textBlock("panel-empty", "No matching branches"));
  }

  private async checkoutBranch(branch: string): Promise<void> {
    const rootPath = this.options.getProjectRoot(); if (!rootPath || branch === this.currentBranch) { this.closePopovers(); return; }
    try { const state = await this.options.bridge.checkoutBranch(rootPath, branch); this.currentBranch = state.current; this.availableBranches = state.branches; this.newChatBranchLabel.textContent = this.currentBranch; this.closePopovers(); }
    catch (error) { this.options.onError(errorMessage(error)); }
  }

  private async createAndCheckoutBranch(): Promise<void> {
    const rootPath = this.options.getProjectRoot(); const branch = this.newBranchName.value.trim(); if (!rootPath || !branch) return;
    try { const state = await this.options.bridge.createBranch(rootPath, branch); this.currentBranch = state.current; this.availableBranches = state.branches; this.newChatBranchLabel.textContent = this.currentBranch; this.newBranchName.value = ""; this.closePopovers(); }
    catch (error) { this.options.onError(errorMessage(error)); }
  }

  private chooseEnvironment(choice: string): void {
    if (choice === "local") { this.closePopovers(); return; }
    if (choice === "worktree") { this.createWorktreeForm.hidden = false; this.newWorktreeBranch.focus(); return; }
    if (choice === "usage") this.controls.openContextUsage();
  }

  private async createWorktree(): Promise<void> {
    const rootPath = this.options.getProjectRoot(); const branch = this.newWorktreeBranch.value.trim(); if (!rootPath || !branch) return;
    try {
      const worktree = await this.options.bridge.createWorktree(rootPath, branch);
      await this.options.onWorktreeCreated(worktree.path, worktree.branch);
      this.currentBranch = worktree.branch;
      this.availableBranches = [worktree.branch];
      this.newChatBranchLabel.textContent = this.currentBranch;
      this.newWorktreeBranch.value = "";
      this.closePopovers();
    } catch (error) { this.options.onError(errorMessage(error)); }
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
