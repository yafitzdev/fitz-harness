export interface AdaptiveWorkspaceOptions {
  shell: HTMLElement;
  workspace: HTMLElement;
  inspectorBreakpoint?: number;
  onLayoutChange?: () => void;
}

/**
 * Owns responsive shell state that depends on more than CSS can observe.
 * In particular, a docked Inspector and a persistent project sidebar should
 * not squeeze the conversation below a useful width. The sidebar is restored
 * when the Inspector closes, unless the user changed it themselves.
 */
export class AdaptiveWorkspace {
  readonly #options: AdaptiveWorkspaceOptions;
  readonly #observer: ResizeObserver;
  #autoCollapsed = false;

  constructor(options: AdaptiveWorkspaceOptions) {
    this.#options = options;
    this.#observer = new ResizeObserver(this.sync);
    this.#observer.observe(options.shell);
  }

  readonly sync = (): void => {
    const inspectorOpen = this.#options.workspace.classList.contains("inspector-open");
    const compact = this.#options.shell.clientWidth < (this.#options.inspectorBreakpoint ?? 1100);
    const collapsed = this.#options.shell.classList.contains("sidebar-collapsed");

    if (inspectorOpen && compact && !collapsed) {
      this.#options.shell.classList.add("sidebar-collapsed");
      this.#autoCollapsed = true;
      this.#options.onLayoutChange?.();
    } else if (!inspectorOpen && this.#autoCollapsed) {
      this.#options.shell.classList.remove("sidebar-collapsed");
      this.#autoCollapsed = false;
      this.#options.onLayoutChange?.();
    }
  };

  toggleSidebar(): void {
    this.#autoCollapsed = false;
    this.#options.shell.classList.toggle("sidebar-collapsed");
    this.#options.onLayoutChange?.();
  }
}
