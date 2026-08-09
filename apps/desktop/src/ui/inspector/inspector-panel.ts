import { svgIcon, textBlock } from "../primitives/dom.js";
import { projectRelativePath } from "../chat/tool-activity.js";
import { ResizablePane } from "../primitives/resizable-pane.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { ResourceInspector } from "./resource-inspector.js";

type Json = Record<string, any>;

export interface InspectorPanelOptions {
  /** The workspace the panel docks into; the panel and its resizer append here. */
  mount: HTMLElement;
  /**
   * Where the tab bar lives: the workspace header above the panel. The tabs
   * move up into this bar so the Inspector itself is content only.
   */
  tabMount: HTMLElement;
  getProjectRoot: () => string;
  getSearchRoots: () => string[];
  showToast: (message: string) => void;
  /**
   * The header's raw↔rendered toggle. Optional: it is wired to whichever
   * tab is active, and hidden unless a markdown or HTML doc is open.
   */
  renderToggle?: HTMLButtonElement;
  /** Reflows the conversation whenever the panel opens, closes, or is resized. */
  onLayoutChange: () => void;
}

/** One tab in the Inspector: a closable file, upload, URL, or pasted preview. */
type InspectorTab = {
  id: string;
  label: string;
  closable: boolean;
  button: HTMLElement;
  closeButton: HTMLButtonElement | undefined;
  content: HTMLElement;
  inspector: ResourceInspector | undefined;
  /** The resolved local path once a file preview lands (for duplicate merging). */
  resolvedPath?: string;
};

/**
 * The Inspector — the right-hand resource panel. It is its own component: it
 * builds its shell (preview surface and resizer), owns the open/close state
 * and the resizable width, and composes the tabbed preview surface. The tab
 * bar lives in the workspace header above the panel — bubble-style tabs grow
 * from the left edge of the inspector toward the header actions, and the
 * artifact repository is a dedicated view (the panel's home view) rather
 * than a tab. The renderer never touches the panel's internals; it only
 * drives this public surface.
 */
export class InspectorPanel {
  readonly #options: InspectorPanelOptions;
  readonly #element: HTMLElement;
  readonly #resizer: HTMLElement;
  readonly #content: HTMLElement;
  readonly #tabBar: HTMLElement;
  readonly #pane: ResizablePane;
  readonly #repository: ArtifactRepository;
  readonly #renderToggle: HTMLButtonElement | undefined;
  readonly #repositoryView: HTMLElement;
  readonly #tabs: InspectorTab[] = [];
  readonly #resizeObserver: ResizeObserver;
  #activeTabId: string | undefined;
  #pastedCounter = 0;
  #open = false;

  constructor(options: InspectorPanelOptions) {
    this.#options = options;

    const element = document.createElement("aside");
    element.className = "inspector-panel";
    element.setAttribute("aria-label", "Inspector");
    element.hidden = true;

    const content = document.createElement("div");
    content.id = "artifact-preview";
    content.className = "inspector-content";
    element.append(content);

    // The tab bar lives in the workspace header, above the panel.
    const tabBar = document.createElement("nav");
    tabBar.className = "inspector-tabs";
    tabBar.setAttribute("role", "tablist");
    tabBar.setAttribute("aria-label", "Inspector tabs");
    tabBar.hidden = true;
    // Middle-click closes tabs, so stop Chromium's autoscroll from kicking in.
    tabBar.addEventListener("mousedown", (event) => {
      if (event.button === 1) event.preventDefault();
    });
    // Mount into the workspace header; CSS anchors the bar to the inspector
    // panel's left edge, so it stays out of the header's flex flow.
    options.tabMount.append(tabBar);

    const resizer = document.createElement("div");
    resizer.id = "inspector-resizer";
    resizer.className = "inspector-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-label", "Resize Inspector");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-valuemin", "300");
    resizer.setAttribute("aria-valuemax", "760");
    resizer.tabIndex = 0;
    resizer.hidden = true;

    const pane = new ResizablePane({
      divider: resizer,
      storageKey: "fitz-inspector-width",
      defaultValue: 400,
      minimum: 200,
      maximum: () => Math.max(200, options.mount.getBoundingClientRect().width - 280),
      pointerValue: (event) => options.mount.getBoundingClientRect().right - event.clientX,
      keyboardDirection: -1,
      apply: (value) => options.mount.style.setProperty("--inspector-width", `${value}px`),
      onChange: options.onLayoutChange,
    });

    options.mount.append(resizer, element);

    // Re-clamp the panel whenever the workspace changes size (window resize,
    // sidebar drag). The pane's maximum depends on the workspace width but is
    // only enforced inside set(), so without this a shrunken window would
    // leave the panel overlapping the conversation. The user's preferred
    // width stays in localStorage; this only constrains what fits right now.
    this.#resizeObserver = new ResizeObserver(() => this.clampWidth());
    this.#resizeObserver.observe(options.mount);

    this.#element = element;
    this.#resizer = resizer;
    this.#content = content;
    this.#tabBar = tabBar;
    this.#pane = pane;
    this.#renderToggle = options.renderToggle;
    this.#repository = new ArtifactRepository({
      onOpenFile: (path) => void this.inspect(path),
      onOpenArtifact: (artifact) => void this.previewArtifact(artifact),
      getProjectRoot: this.#options.getProjectRoot,
    });

    // The repository is a persistent view behind the header's Artifacts
    // button, not a tab: it renders once and is the panel's home view.
    const repositoryView = document.createElement("div");
    repositoryView.className = "inspector-tabpanel";
    this.#repository.render(repositoryView);
    content.append(repositoryView);
    this.#repositoryView = repositoryView;
  }

  get element(): HTMLElement { return this.#element; }
  get resizer(): HTMLElement { return this.#resizer; }
  get isOpen(): boolean { return this.#open; }
  /** The tab bar (mounted in the workspace header), for tests and layout. */
  get tabBar(): HTMLElement { return this.#tabBar; }

  /** Current panel width in pixels (what the conversation reflows around). */
  width(): number { return this.#pane.value(); }

  /**
   * Pulls the panel back in when the workspace shrinks so it never
   * overspills the conversation: the pane's maximum is workspaceWidth - 280
   * (the conversation's floor), and re-applying it here enforces that live.
   * Driven by a ResizeObserver on the workspace; exposed for tests. The
   * clamped size is not persisted — the stored width is restored next launch.
   */
  clampWidth(): void {
    this.#pane.set(this.#pane.value());
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.#element.hidden = false;
    this.#resizer.hidden = false;
    this.#tabBar.hidden = false;
    // Without an active tab the repository is the panel's home view.
    if (!this.#tabs.some((candidate) => candidate.id === this.#activeTabId)) this.#showRepository();
    // Reapplies the raw↔rendered toggle for the doc that reopens.
    this.#tabs.find((candidate) => candidate.id === this.#activeTabId)?.inspector?.setActive(true);
    this.#options.mount.classList.add("inspector-open");
    // The app shell keeps the sidebar column when the Inspector is docked.
    this.#options.mount.parentElement?.classList.add("context-open");
    this.#options.onLayoutChange();
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#element.hidden = true;
    this.#resizer.hidden = true;
    this.#tabBar.hidden = true;
    if (this.#renderToggle) this.#renderToggle.hidden = true;
    this.#options.mount.classList.remove("inspector-open");
    this.#options.mount.parentElement?.classList.remove("context-open");
    // Tabs survive closing the panel, so reopening returns to the same view.
    this.#options.onLayoutChange();
  }

  /** The header's sidebar button: toggles the panel open and closed. Tabs and
   *  the active view survive a close, so reopening returns to the same doc —
   *  or to the artifact repository home view when nothing is open. */
  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /** Opens the panel on the artifact repository view. */
  showRepository(): void {
    this.open();
    this.#showRepository();
  }

  /**
   * Opens (or focuses) a tab for a local file or URL and previews it. Local
   * files are registered in the artifact repository once they resolve.
   */
  inspect(reference: string): Promise<void> {
    const id = /^https?:\/\//i.test(reference) ? `url:${reference}` : `file:${reference}`;
    const tab = this.#tabs.find((candidate) => candidate.id === id) ?? this.#addResourceTab(id, reference.split(/[\\/]/).pop() || reference);
    this.#activateTab(tab.id);
    return tab.inspector!.inspect(reference);
  }

  /**
   * Opens (or focuses) a tab for a session upload. The optional chat list
   * arguments keep the selected state of the sidebar artifact list in sync.
   */
  previewArtifact(artifact: Json, selected?: HTMLButtonElement, artifactList?: HTMLElement): Promise<void> {
    if (selected && artifactList) {
      for (const item of artifactList.querySelectorAll(".artifact-item")) item.classList.remove("active");
      selected.classList.add("active");
    }
    const id = `upload:${String(artifact.id)}`;
    const tab = this.#tabs.find((candidate) => candidate.id === id) ?? this.#addResourceTab(id, String(artifact.name ?? "Artifact"));
    this.#activateTab(tab.id);
    return tab.inspector!.previewArtifact(artifact);
  }

  /** Previews a locally pasted image (data URL) in its own tab. */
  previewImage(dataUrl: string, mimeType: string, name: string): void {
    const tab = this.#addResourceTab(`pasted:${++this.#pastedCounter}`, name);
    this.#activateTab(tab.id);
    tab.inspector!.previewImage(dataUrl, mimeType, name);
  }

  /** Previews a locally pasted PDF (data URL) in its own tab. */
  previewPdf(dataUrl: string, mimeType: string, name: string): void {
    const tab = this.#addResourceTab(`pasted:${++this.#pastedCounter}`, name);
    this.#activateTab(tab.id);
    tab.inspector!.previewPdf(dataUrl, mimeType, name);
  }

  empty(message: string): HTMLElement { return textBlock("inspector-empty", message); }

  /** Replaces the current session's uploads in the repository and drops stale upload tabs. */
  setSessionArtifacts(artifacts: Json[]): void {
    this.#repository.setSessionArtifacts(artifacts);
    const ids = new Set(artifacts.map((artifact) => String(artifact.id)));
    for (const tab of [...this.#tabs]) {
      if (tab.id.startsWith("upload:") && !ids.has(tab.id.slice("upload:".length))) this.#closeTab(tab.id);
    }
  }

  /**
   * Registers a file in the artifact repository as soon as it appears in the
   * conversation — no click needed. References are resolved lazily when the
   * entry is opened, and are superseded by the resolved absolute path once
   * the user actually inspects the file.
   */
  registerReference(reference: string): void {
    this.#repository.registerReference(reference);
  }

  /**
   * Scopes the artifact repository to a single chat: files registered while
   * viewing a session persist under that session's key, so another chat (or
   * project) never inherits them. Passing no session — the landing, or a
   * brand-new chat that hasn't created one yet — switches to a fresh,
   * empty repository. The panel's open state and tabs are untouched; call
   * reset() alongside when the chat itself changes.
   */
  setChat(sessionId: string | undefined): void {
    this.#repository.useStorage(sessionId ? `fitz-inspector-repository:${sessionId}` : "fitz-inspector-repository:draft");
  }

  /**
   * Closes the panel and drops every resource tab so the Inspector never
   * leaks state across chats: reopening lands on the artifact repository
   * home view, which the renderer reloads for the current session.
   */
  reset(): void {
    this.close();
    for (const tab of [...this.#tabs]) this.#closeTab(tab.id);
    this.#showRepository();
  }

  #tabButton(label: string, closable: boolean): { button: HTMLElement; closeButton: HTMLButtonElement | undefined } {
    const button = document.createElement("div");
    button.className = "inspector-tab";
    button.setAttribute("role", "tab");
    button.tabIndex = 0;
    button.title = label;
    const name = document.createElement("span");
    name.textContent = label;
    button.append(name);
    let closeButton: HTMLButtonElement | undefined;
    if (closable) {
      closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "inspector-tab-close";
      closeButton.title = "Close tab";
      closeButton.setAttribute("aria-label", `Close ${label}`);
      closeButton.append(svgIcon('<path d="m5 5 10 10M15 5 5 15"></path>'));
      button.append(closeButton);
    }
    return { button, closeButton };
  }

  #addResourceTab(id: string, label: string): InspectorTab {
    const { button, closeButton } = this.#tabButton(label, true);
    const content = document.createElement("div");
    content.className = "inspector-tabpanel";
    content.hidden = true;
    const tab: InspectorTab = { id, label, closable: true, button, closeButton, content, inspector: undefined };
    tab.inspector = new ResourceInspector({
      preview: content,
      openPanel: () => this.open(),
      getProjectRoot: this.#options.getProjectRoot,
      getSearchRoots: this.#options.getSearchRoots,
      showToast: this.#options.showToast,
      ...(this.#options.renderToggle ? { renderToggle: this.#options.renderToggle } : {}),
      onFileInspected: (path, name, reference) => this.#onFileInspected(tab.id, path, name, reference),
    });
    this.#attachTabHandlers(tab);
    this.#tabs.push(tab);
    this.#tabBar.append(button);
    this.#content.append(content);
    return tab;
  }

  /** Click, keyboard, close-button, and middle-click handling for a tab. */
  #attachTabHandlers(tab: InspectorTab): void {
    if (tab.closeButton) tab.closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.#closeTab(tab.id);
    });
    tab.button.addEventListener("click", () => this.#activateTab(tab.id));
    // Middle-click (the mouse wheel button) closes a tab, like browsers do.
    tab.button.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        this.#closeTab(tab.id);
      }
    });
    tab.button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.#activateTab(tab.id);
      }
    });
  }

  /** Registers an inspected file in the repository and merges duplicate tabs. */
  #onFileInspected(tabId: string, path: string, name: string, reference?: string): void {
    this.#repository.registerFile(path, name, reference);
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    tab.resolvedPath = path;
    // The tab tooltip keeps the project-relative location without a header.
    tab.button.title = projectRelativePath(path, this.#options.getProjectRoot());
    // The same file can open from a chat link (relative reference) and from
    // the repository (absolute path); once both resolve, keep the older tab.
    const duplicate = this.#tabs.find((candidate) => candidate.id !== tabId && candidate.resolvedPath === path);
    if (duplicate) {
      this.#closeTab(tabId);
      this.#activateTab(duplicate.id);
    }
  }

  #activateTab(id: string): void {
    const tab = this.#tabs.find((candidate) => candidate.id === id);
    if (!tab || this.#activeTabId === id) return;
    this.#tabs.find((candidate) => candidate.id === this.#activeTabId)?.inspector?.setActive(false);
    for (const candidate of this.#tabs) {
      const active = candidate.id === id;
      candidate.button.classList.toggle("active", active);
      candidate.button.setAttribute("aria-selected", String(active));
      candidate.content.hidden = !active;
    }
    this.#repositoryView.hidden = true;
    this.#activeTabId = id;
    if (tab.inspector) tab.inspector.setActive(true);
    else if (this.#renderToggle) this.#renderToggle.hidden = true;
  }

  /** Switches to the repository view: no tab selected, the repo list shown. */
  #showRepository(): void {
    this.#tabs.find((candidate) => candidate.id === this.#activeTabId)?.inspector?.setActive(false);
    this.#activeTabId = undefined;
    for (const candidate of this.#tabs) {
      candidate.button.classList.remove("active");
      candidate.button.setAttribute("aria-selected", "false");
      candidate.content.hidden = true;
    }
    this.#repositoryView.hidden = false;
    if (this.#renderToggle) this.#renderToggle.hidden = true;
  }

  #closeTab(id: string): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tab = this.#tabs[index];
    if (!tab || !tab.closable) return;
    const wasActive = this.#activeTabId === id;
    this.#tabs.splice(index, 1);
    tab.button.remove();
    tab.content.remove();
    tab.inspector?.cancelPending();
    if (!wasActive) return;
    if (this.#tabs.length > 0) {
      // Activate the tab that slides into the closed slot (or the new last).
      this.#activateTab(this.#tabs[Math.min(index, this.#tabs.length - 1)]!.id);
    } else {
      // No tabs left: fall back to the artifact repository home view.
      this.#showRepository();
    }
  }
}
