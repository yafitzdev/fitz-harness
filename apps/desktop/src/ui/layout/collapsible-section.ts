import { svgIcon } from "../primitives/dom.js";

/** Shared chevron glyph used by every collapsible row's header toggle. */
export const collapseChevronIcon = '<path d="m6 8 4 4 4-4"></path>';

export interface CollapsibleSectionOptions {
  /** Key within the persisted collapsed set; defaults to the title. */
  id?: string;
  /** localStorage key that stores the collapsed set; omit to keep the section stateless. */
  storageKey?: string;
  title: string;
  /** Heading level for the title; item rows use h3, page sections use h2. */
  titleLevel?: 2 | 3;
  /** Extra class on the section root, e.g. "consumer-playbook-card". */
  className?: string;
  /** Buttons/actions placed in the heading row, right of the toggle. */
  actions?: HTMLElement[];
  /** Initial body content. */
  body?: HTMLElement[];
  /** Start collapsed instead of reading the persisted state. */
  collapsed?: boolean;
  /** Fired whenever the collapse state changes (after persistence). */
  onToggle?: (collapsed: boolean) => void;
}

export interface AdoptCollapsibleSectionOptions {
  /** localStorage key that stores the collapsed set for the adopted sections. */
  storageKey: string;
  /** Key within the persisted set; defaults to the toggle's `data-collapsible-key`. */
  key?: string;
}

interface CollapsibleSectionElements {
  root: HTMLElement;
  heading: HTMLElement;
  toggle: HTMLButtonElement;
  chevron: HTMLElement;
  title: HTMLElement;
  actions: HTMLElement;
  body: HTMLElement;
}

let nextBodyId = 1;

/**
 * The collapsible row shared by every management tab. A heading owns a chevron
 * toggle on the left and optional actions on the right, then a body that hides
 * while the row is collapsed. Connections, Playbooks, Plugins, and
 * Administration all build their collapsible rows from this component, so the
 * chevron, title, actions, and body align identically across tabs.
 *
 * Rows created from data (`CollapsibleSection.create`) build their own markup;
 * rows that live in the shell (`CollapsibleSection.adopt` / `adoptAll`) are
 * bound to the same collapse and persistence behavior in place.
 */
export class CollapsibleSection {
  readonly root: HTMLElement;
  readonly heading: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly chevron: HTMLElement;
  readonly title: HTMLElement;
  readonly actions: HTMLElement;
  readonly body: HTMLElement;

  #collapsed: boolean;
  readonly #storageKey: string | undefined;
  readonly #id: string;
  readonly #onToggle: ((collapsed: boolean) => void) | undefined;

  private constructor(
    elements: CollapsibleSectionElements,
    id: string,
    storageKey: string | undefined,
    initiallyCollapsed: boolean | undefined,
    onToggle: ((collapsed: boolean) => void) | undefined,
  ) {
    this.root = elements.root;
    this.heading = elements.heading;
    this.toggle = elements.toggle;
    this.chevron = elements.chevron;
    this.title = elements.title;
    this.actions = elements.actions;
    this.body = elements.body;
    this.#id = id;
    this.#storageKey = storageKey;
    this.#onToggle = onToggle;
    this.#collapsed = initiallyCollapsed ?? (storageKey ? storedSet(storageKey).has(id) : false);
    this.root.classList.toggle("collapsed", this.#collapsed);
    this.toggle.setAttribute("aria-expanded", String(!this.#collapsed));
    this.toggle.addEventListener("click", () => this.toggleCollapsed());
  }

  /** Builds a fresh collapsible row. */
  static create(options: CollapsibleSectionOptions): CollapsibleSection {
    const root = document.createElement("section");
    root.className = "collapsible-section";
    if (options.className) root.classList.add(options.className);

    const heading = document.createElement("div");
    heading.className = "collapsible-heading";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "collapsible-toggle";

    const chevron = document.createElement("span");
    chevron.className = "collapsible-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.append(svgIcon(collapseChevronIcon));

    const title = document.createElement(options.titleLevel === 2 ? "h2" : "h3");
    title.className = "collapsible-title";
    title.textContent = options.title;
    toggle.append(chevron, title);

    const actions = document.createElement("div");
    actions.className = "collapsible-actions";
    if (options.actions) actions.append(...options.actions);
    heading.append(toggle, actions);

    const body = document.createElement("div");
    body.className = "collapsible-body";
    body.id = `collapsible-body-${nextBodyId++}`;
    toggle.setAttribute("aria-controls", body.id);
    if (options.body) body.append(...options.body);
    root.append(heading, body);

    return new CollapsibleSection(
      { root, heading, toggle, chevron, title, actions, body },
      options.id ?? options.title,
      options.storageKey,
      options.collapsed,
      options.onToggle,
    );
  }

  /** Binds an existing collapsible row from shell markup to the shared behavior. */
  static adopt(root: HTMLElement, options: AdoptCollapsibleSectionOptions): CollapsibleSection {
    root.classList.add("collapsible-section");
    const heading = root.querySelector<HTMLElement>(".collapsible-heading");
    const toggle = root.querySelector<HTMLButtonElement>(".collapsible-toggle");
    if (!heading || !toggle) throw new Error("CollapsibleSection is missing its .collapsible-heading or .collapsible-toggle");
    const title = toggle.querySelector<HTMLElement>("h2, h3");
    if (!title) throw new Error("CollapsibleSection toggle is missing its heading");
    const body = root.querySelector<HTMLElement>(".collapsible-body");
    if (!body) throw new Error("CollapsibleSection is missing its .collapsible-body");
    let chevron = toggle.querySelector<HTMLElement>(".collapsible-chevron");
    if (!chevron) {
      chevron = document.createElement("span");
      chevron.className = "collapsible-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.append(svgIcon(collapseChevronIcon));
      toggle.prepend(chevron);
    }
    let actions = heading.querySelector<HTMLElement>(".collapsible-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "collapsible-actions";
      heading.append(actions);
    }
    const id = options.key ?? toggle.dataset.collapsibleKey ?? body.id;
    return new CollapsibleSection(
      { root, heading, toggle, chevron, title, actions, body },
      id,
      options.storageKey,
      undefined,
      undefined,
    );
  }

  /** Binds every collapsible row inside `container`; sections without a toggle are left alone. */
  static adoptAll(container: HTMLElement, options: AdoptCollapsibleSectionOptions): CollapsibleSection[] {
    const adopted: CollapsibleSection[] = [];
    for (const root of container.querySelectorAll<HTMLElement>(".collapsible-section")) {
      if (!root.querySelector(".collapsible-toggle")) continue;
      adopted.push(CollapsibleSection.adopt(root, options));
    }
    return adopted;
  }

  get collapsed(): boolean {
    return this.#collapsed;
  }

  setCollapsed(collapsed: boolean): void {
    if (this.#collapsed === collapsed) return;
    this.#collapsed = collapsed;
    this.root.classList.toggle("collapsed", collapsed);
    this.toggle.setAttribute("aria-expanded", String(!collapsed));
    if (this.#storageKey) {
      const set = storedSet(this.#storageKey);
      if (collapsed) set.add(this.#id);
      else set.delete(this.#id);
      saveSet(this.#storageKey, set);
    }
    this.#onToggle?.(collapsed);
  }

  toggleCollapsed(): void {
    this.setCollapsed(!this.#collapsed);
  }

  appendBody(...nodes: Node[]): void {
    this.body.append(...nodes);
  }
}

function storedSet(key: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

function saveSet(key: string, values: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...values]));
}
