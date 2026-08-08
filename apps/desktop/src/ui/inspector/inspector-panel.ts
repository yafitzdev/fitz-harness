import { svgIcon, textBlock } from "../primitives/dom.js";
import { ResizablePane } from "../primitives/resizable-pane.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { ResourceInspector } from "./resource-inspector.js";

type Json = Record<string, any>;

export interface InspectorPanelOptions {
  /** The workspace the panel docks into; the panel and its resizer append here. */
  mount: HTMLElement;
  getProjectRoot: () => string;
  getSearchRoots: () => string[];
  showToast: (message: string) => void;
  /** Reflows the conversation whenever the panel opens, closes, or is resized. */
  onLayoutChange: () => void;
}

/** One tab in the Inspector: the fixed repository base or a closable resource. */
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

const REPOSITORY_TAB = "repository";
const REPOSITORY_ICON = '<path d="M5 2.8h6l4 4v10.4H5z"></path><path d="M11 2.8v4h4"></path>';

/**
 * The Inspector — the right-hand resource panel. It is its own component: it
 * builds its shell (header, tab bar, preview surfaces, and resizer), owns the
 * open/close state and the resizable width, and composes the tabbed preview
 * surface. The first tab is the artifact repository (the defacto base, never
 * closable); every file, upload, URL, and pasted preview opens as its own
 * closable tab. The renderer never touches the panel's internals; it only
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
  readonly #tabs: InspectorTab[] = [];
  readonly #title: HTMLElement;
  readonly #location: HTMLElement;
  readonly #icon: HTMLElement;
  readonly #openButton: HTMLButtonElement;
  readonly #renderToggle: HTMLButtonElement;
  #activeTabId: string | undefined;
  #pastedCounter = 0;
  #open = false;

  constructor(options: InspectorPanelOptions) {
    this.#options = options;

    const element = document.createElement("aside");
    element.className = "inspector-panel";
    element.setAttribute("aria-label", "Inspector");
    element.hidden = true;

    const header = document.createElement("header");
    header.className = "inspector-header";

    const icon = document.createElement("span");
    icon.className = "inspector-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.append(svgIcon(REPOSITORY_ICON));

    const heading = document.createElement("div");
    heading.className = "inspector-heading";
    const title = document.createElement("strong");
    title.id = "inspector-title";
    title.textContent = "Artifacts";
    const location = document.createElement("small");
    location.id = "inspector-location";
    heading.append(title, location);

    const renderToggle = document.createElement("button");
    renderToggle.type = "button";
    renderToggle.className = "icon-button";
    renderToggle.id = "inspector-render-toggle";
    renderToggle.title = "View source";
    renderToggle.setAttribute("aria-label", "View source");
    renderToggle.setAttribute("aria-pressed", "false");
    renderToggle.hidden = true;
    renderToggle.append(svgIcon('<path d="m7 5-5 5 5 5M13 5l5 5-5 5M11.5 3 8.5 17"></path>'));

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "icon-button";
    openButton.id = "inspector-open";
    openButton.title = "Open outside Fitz";
    openButton.setAttribute("aria-label", "Open outside Fitz");
    openButton.hidden = true;
    openButton.append(svgIcon('<path d="M11 4h5v5M9 11l7-7"></path><path d="M14 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"></path>'));

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "icon-button";
    closeButton.id = "inspector-close";
    closeButton.title = "Close inspector";
    closeButton.setAttribute("aria-label", "Close inspector");
    closeButton.append(svgIcon('<path d="m5 5 10 10M15 5 5 15"></path>'));
    closeButton.addEventListener("click", () => this.close());

    header.append(icon, heading, renderToggle, openButton, closeButton);

    const tabBar = document.createElement("nav");
    tabBar.className = "inspector-tabs";
    tabBar.setAttribute("role", "tablist");
    tabBar.setAttribute("aria-label", "Inspector tabs");
    // Middle-click closes tabs, so stop Chromium's autoscroll from kicking in.
    tabBar.addEventListener("mousedown", (event) => {
      if (event.button === 1) event.preventDefault();
    });

    const content = document.createElement("div");
    content.id = "artifact-preview";
    content.className = "inspector-content";

    element.append(header, tabBar, content);

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

    this.#element = element;
    this.#resizer = resizer;
    this.#content = content;
    this.#tabBar = tabBar;
    this.#pane = pane;
    this.#title = title;
    this.#location = location;
    this.#icon = icon;
    this.#openButton = openButton;
    this.#renderToggle = renderToggle;

    // The artifact repository is the base tab: always present, never closable.
    const repositoryContent = document.createElement("div");
    repositoryContent.className = "inspector-tabpanel";
    const repositoryButton = this.#tabButton("Artifacts", false);
    tabBar.append(repositoryButton.button);
    content.append(repositoryContent);
    this.#repository = new ArtifactRepository({
      onOpenFile: (path) => void this.inspect(path),
      onOpenArtifact: (artifact) => void this.previewArtifact(artifact),
      getProjectRoot: this.#options.getProjectRoot,
    });
    this.#repository.render(repositoryContent);
    this.#tabs.push({ id: REPOSITORY_TAB, label: "Artifacts", closable: false, button: repositoryButton.button, closeButton: repositoryButton.closeButton, content: repositoryContent, inspector: undefined });
    this.#activeTabId = REPOSITORY_TAB;
    repositoryButton.button.classList.add("active");
    repositoryButton.button.setAttribute("aria-selected", "true");
    this.#showRepositoryHeader();
  }

  get element(): HTMLElement { return this.#element; }
  get resizer(): HTMLElement { return this.#resizer; }
  get isOpen(): boolean { return this.#open; }

  /** Current panel width in pixels (what the conversation reflows around). */
  width(): number { return this.#pane.value(); }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.#element.hidden = false;
    this.#resizer.hidden = false;
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
    this.#options.mount.classList.remove("inspector-open");
    this.#options.mount.parentElement?.classList.remove("context-open");
    // Tabs survive closing the panel, so reopening returns to the same view.
    this.#options.onLayoutChange();
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
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

  /** Restores the artifact repository while the panel is closed. */
  resetPreview(): void {
    if (this.#open) return;
    this.#activateRepositoryTab();
  }

  #tabButton(label: string, closable: boolean): { button: HTMLElement; closeButton: HTMLButtonElement | undefined } {
    const button = document.createElement("div");
    button.className = "inspector-tab";
    button.setAttribute("role", "tab");
    button.tabIndex = 0;
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
      title: this.#title,
      location: this.#location,
      icon: this.#icon,
      openButton: this.#openButton,
      renderToggle: this.#renderToggle,
      openPanel: () => this.open(),
      getProjectRoot: this.#options.getProjectRoot,
      getSearchRoots: this.#options.getSearchRoots,
      showToast: this.#options.showToast,
      onFileInspected: (path, name, reference) => this.#onFileInspected(tab.id, path, name, reference),
    });
    if (closeButton) closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.#closeTab(id);
    });
    button.addEventListener("click", () => this.#activateTab(id));
    // Middle-click (the mouse wheel button) closes a tab, like browsers do.
    button.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        this.#closeTab(id);
      }
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.#activateTab(id);
      }
    });
    this.#tabs.push(tab);
    this.#tabBar.append(button);
    this.#content.append(content);
    return tab;
  }

  /** Registers an inspected file in the repository and merges duplicate tabs. */
  #onFileInspected(tabId: string, path: string, name: string, reference?: string): void {
    this.#repository.registerFile(path, name, reference);
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    tab.resolvedPath = path;
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
    this.#activeTabId = id;
    if (tab.inspector) tab.inspector.setActive(true);
    else this.#showRepositoryHeader();
  }

  #activateRepositoryTab(): void { this.#activateTab(REPOSITORY_TAB); }

  #closeTab(id: string): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tab = this.#tabs[index];
    // The repository base tab is never closable, even through middle-click.
    if (!tab || !tab.closable) return;
    this.#tabs.splice(index, 1);
    tab.button.remove();
    tab.content.remove();
    tab.inspector?.cancelPending();
    if (this.#activeTabId === id) this.#activateRepositoryTab();
  }

  #showRepositoryHeader(): void {
    this.#title.textContent = "Artifacts";
    this.#location.textContent = "Artifact repository";
    this.#icon.replaceChildren(svgIcon(REPOSITORY_ICON));
    this.#openButton.hidden = true;
    this.#renderToggle.hidden = true;
  }
}
