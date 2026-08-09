import { svgIcon } from "../primitives/dom.js";
import { ActionStatus } from "../primitives/action-status.js";

/** Shared refresh glyph used by every management tab's header action. */
export const managementRefreshIcon = '<path d="M15.5 7A6 6 0 1 0 16 12"></path><path d="M15.5 3v4h-4"></path>';
/** Shared magnifier glyph used by every management tab's search pill. */
export const managementSearchIcon = '<circle cx="9" cy="9" r="5.5"></circle><path d="m13 13 4 4"></path>';

export interface ManagementPageTab {
  id: string;
  label: string;
  active?: boolean;
  /** Extra attributes exposed as `data-*` on the tab button, e.g. `{ pipeline: "text-generation" }` → `data-pipeline`. */
  dataset?: Record<string, string>;
}

export interface ManagementPageAction {
  id: string;
  /** Text on a text button; also the accessible name when `icon` is set. */
  label: string;
  /** SVG markup for an icon-only button. Omit to render a text button. */
  icon?: string;
  /** Extra classes for a text button, e.g. "quiet-button compact-button". */
  className?: string;
}

export interface ManagementPageContentOptions {
  id?: string;
  hidden?: boolean;
  title: string;
  titleId?: string;
  description?: string;
  descriptionId?: string;
  search?: { id: string; placeholder: string };
  /** Elements appended after the heading and search pill. */
  body?: HTMLElement[];
  /** Insert the column before this sibling instead of after the previous column. */
  before?: HTMLElement;
}

/**
 * Shared chrome for every management tab (Connections, Playbooks, Plugins,
 * Administration). Each page is a `.management-page` section built from the
 * same pieces: a shared compact header with tabs on the left and actions on the right,
 * followed by one or more `.management-page-content` columns that own the
 * heading, description, search pill, and body. Because every tab renders the
 * identical structure, switching between them never shifts the layout.
 */
export class ManagementPageLayout {
  readonly header: HTMLElement;
  readonly tabs: HTMLElement;
  readonly actions: HTMLElement;
  readonly status: ActionStatus;

  readonly #tabButtons = new Map<string, HTMLButtonElement>();
  readonly #actionButtons = new Map<string, HTMLButtonElement>();
  #tabListener: ((id: string) => void) | undefined;
  #lastContent: HTMLElement | undefined;

  constructor(root: HTMLElement, options: { tabs?: ManagementPageTab[]; actions?: ManagementPageAction[] } = {}) {
    this.header = document.createElement("header");
    this.header.className = "management-page-header";
    this.tabs = document.createElement("div");
    this.tabs.className = "management-page-tabs";
    this.actions = document.createElement("div");
    this.actions.className = "management-actions";
    this.status = new ActionStatus();
    for (const tab of options.tabs ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = tab.id;
      button.textContent = tab.label;
      for (const [key, value] of Object.entries(tab.dataset ?? {})) button.dataset[key] = value;
      button.classList.toggle("active", Boolean(tab.active));
      button.addEventListener("click", () => {
        this.setActiveTab(tab.id);
        this.#tabListener?.(tab.id);
      });
      this.#tabButtons.set(tab.id, button);
      this.tabs.append(button);
    }
    for (const action of options.actions ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = action.id;
      if (action.icon) {
        button.className = "icon-button";
        button.title = action.label;
        button.setAttribute("aria-label", action.label);
        button.append(svgIcon(action.icon));
      } else {
        button.className = action.className ?? "quiet-button";
        button.textContent = action.label;
      }
      this.#actionButtons.set(action.id, button);
      this.actions.append(button);
    }
    this.header.append(this.tabs, this.actions);
    root.prepend(this.header);
    this.header.after(this.status.root);
  }

  /**
   * Builds a search pill exactly like the ones `addContent` renders, for
   * searches that live inside a content section rather than at the top of a
   * column (e.g. the Plugins page's Installed skills section).
   */
  static createSearch(options: { id: string; placeholder: string }): HTMLLabelElement {
    const search = document.createElement("label");
    search.className = "management-search";
    const input = document.createElement("input");
    input.id = options.id;
    input.type = "search";
    input.placeholder = options.placeholder;
    input.autocomplete = "off";
    search.append(svgIcon(managementSearchIcon), input);
    return search;
  }

  addContent(options: ManagementPageContentOptions): HTMLElement {
    const column = document.createElement("div");
    column.className = "management-page-content";
    if (options.id) column.id = options.id;
    if (options.hidden) column.hidden = true;
    const title = document.createElement("h1");
    if (options.titleId) title.id = options.titleId;
    title.textContent = options.title;
    column.append(title);
    if (options.description) {
      const description = document.createElement("p");
      if (options.descriptionId) description.id = options.descriptionId;
      description.textContent = options.description;
      column.append(description);
    }
    if (options.search) column.append(ManagementPageLayout.createSearch(options.search));
    if (options.body) column.append(...options.body);
    if (options.before) options.before.before(column);
    else if (this.#lastContent) this.#lastContent.after(column);
    else this.status.root.after(column);
    this.#lastContent = column;
    return column;
  }

  setActiveTab(id: string): void {
    for (const [tabId, button] of this.#tabButtons) button.classList.toggle("active", tabId === id);
  }

  onTabSelect(listener: (id: string) => void): void {
    this.#tabListener = listener;
  }

  getTab(id: string): HTMLButtonElement | undefined {
    return this.#tabButtons.get(id);
  }

  getAction(id: string): HTMLButtonElement | undefined {
    return this.#actionButtons.get(id);
  }
}
