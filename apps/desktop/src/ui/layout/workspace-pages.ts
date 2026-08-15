export type WorkspacePage = "conversation" | "playbooks" | "connections" | "plugins" | "models" | "administration" | "pairing";

export interface WorkspacePageControllerOptions {
  pages: Partial<Record<Exclude<WorkspacePage, "conversation">, HTMLElement>>;
  navigation: Partial<Record<WorkspacePage, HTMLElement>>;
  setConversationInert: (inert: boolean) => void;
}

/** Owns the mutually-exclusive workspace page state and its matching rail selection. */
export class WorkspacePageController {
  readonly #options: WorkspacePageControllerOptions;

  constructor(options: WorkspacePageControllerOptions) {
    this.#options = options;
  }

  show(page: WorkspacePage): void {
    for (const [name, element] of Object.entries(this.#options.pages)) {
      if (element) element.hidden = name !== page;
    }
    for (const [name, element] of Object.entries(this.#options.navigation)) {
      element?.classList.toggle("active", name === page);
    }
    this.#options.setConversationInert(page !== "conversation");
  }
}
