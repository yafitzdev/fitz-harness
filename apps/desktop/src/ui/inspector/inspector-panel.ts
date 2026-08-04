import { svgIcon, textBlock } from "../primitives/dom.js";
import { ResizablePane } from "../primitives/resizable-pane.js";
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

/**
 * The Inspector — the right-hand resource panel. It is its own component: it
 * builds its shell (header, preview surface, and resizer), owns the open/close
 * state and the resizable width, and composes the {@link ResourceInspector}
 * preview controller. The renderer never touches the panel's internals; it only
 * drives this public surface.
 */
export class InspectorPanel {
  readonly #options: InspectorPanelOptions;
  readonly #element: HTMLElement;
  readonly #resizer: HTMLElement;
  readonly #content: HTMLElement;
  readonly #pane: ResizablePane;
  readonly #inspector: ResourceInspector;
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
    icon.append(svgIcon('<path d="M5 2.8h6l4 4v10.4H5z"></path><path d="M11 2.8v4h4"></path>'));

    const heading = document.createElement("div");
    heading.className = "inspector-heading";
    const title = document.createElement("strong");
    title.id = "inspector-title";
    title.textContent = "Inspector";
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

    const content = document.createElement("div");
    content.id = "artifact-preview";
    content.className = "inspector-content";
    content.append(textBlock("inspector-empty", "Select a file or link in the conversation to inspect it here."));

    element.append(header, content);

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

    const inspector = new ResourceInspector({
      preview: content,
      title,
      location,
      icon,
      openButton,
      renderToggle,
      openPanel: () => this.open(),
      getProjectRoot: options.getProjectRoot,
      getSearchRoots: options.getSearchRoots,
      showToast: options.showToast,
    });

    options.mount.append(resizer, element);

    this.#element = element;
    this.#resizer = resizer;
    this.#content = content;
    this.#pane = pane;
    this.#inspector = inspector;
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
    this.#inspector.cancelPending();
    this.#options.onLayoutChange();
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  inspect(reference: string): Promise<void> { return this.#inspector.inspect(reference); }

  previewArtifact(artifact: Json, selected: HTMLButtonElement, artifactList: HTMLElement): Promise<void> {
    return this.#inspector.previewArtifact(artifact, selected, artifactList);
  }

  /** Previews a locally pasted image (data URL) in the Inspector. */
  previewImage(dataUrl: string, mimeType: string, name: string): void {
    this.#inspector.previewImage(dataUrl, mimeType, name);
  }

  /** Previews a locally pasted PDF (data URL) in the Inspector. */
  previewPdf(dataUrl: string, mimeType: string, name: string): void {
    this.#inspector.previewPdf(dataUrl, mimeType, name);
  }

  empty(message: string): HTMLElement { return this.#inspector.empty(message); }

  /** Restores the "select a resource" hint while the panel is closed. */
  resetPreview(): void {
    if (!this.#open) this.#content.replaceChildren(this.empty("Select a file or link in the conversation to inspect it here."));
  }
}
