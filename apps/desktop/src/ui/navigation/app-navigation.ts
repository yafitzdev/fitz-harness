import type { WorkspacePageController } from "../layout/workspace-pages.js";
import { NavigationHistoryController, type AppLocation } from "./navigation-history.js";
import { canOpenManagementView, managementNavigationVisibility, type ManagementView } from "./navigation-policy.js";

export interface ManagementNavigationTarget {
  load: () => void | Promise<void>;
  openRoute?: (path: string[]) => void;
}

export interface AppNavigationOptions {
  blocked: () => boolean;
  closePopovers: () => void;
  closeInspector: () => void;
  closeEditors: () => void;
  pages: Pick<WorkspacePageController, "show">;
  navigation: Record<ManagementView, HTMLElement>;
  management: Record<ManagementView, ManagementNavigationTarget>;
  replayConversation: (location: AppLocation) => void | Promise<void>;
}

/**
 * Owns application-level workspace navigation: access checks, shared page
 * transitions, nested-route replay, and browser-style back/forward history.
 * Individual pages remain responsible only for loading and opening their own
 * route payloads.
 */
export class AppNavigationController {
  readonly #options: AppNavigationOptions;
  readonly #history: NavigationHistoryController;

  constructor(options: AppNavigationOptions) {
    this.#options = options;
    this.#history = new NavigationHistoryController({
      blocked: options.blocked,
      replay: (location) => this.#replay(location),
    });
  }

  remember(location: AppLocation): void {
    this.#history.remember(location);
  }

  rememberRoute(view: AppLocation["view"], path: string[] | undefined): void {
    this.remember({ view, ...(path?.length ? { path } : {}) });
  }

  navigate(offset: -1 | 1): Promise<void> {
    return this.#history.navigate(offset);
  }

  applyAvailability(): void {
    const visibility = managementNavigationVisibility();
    for (const [view, element] of Object.entries(this.#options.navigation) as Array<[ManagementView, HTMLElement]>) {
      element.hidden = !visibility[view];
    }
  }

  async openManagement(view: ManagementView): Promise<boolean> {
    if (!canOpenManagementView(view)) return false;
    this.#prepareNonConversation();
    this.#options.pages.show(view);
    await this.#options.management[view].load();
    this.remember({ view });
    return true;
  }

  showConversation(): void {
    this.#options.closeEditors();
    this.#options.pages.show("conversation");
  }

  #prepareNonConversation(): void {
    this.#options.closePopovers();
    this.#options.closeInspector();
    this.#options.closeEditors();
  }

  async #replay(location: AppLocation): Promise<void> {
    if (location.view === "conversation") {
      await this.#options.replayConversation(location);
      return;
    }
    if (!await this.openManagement(location.view)) return;
    if (location.path) this.#options.management[location.view].openRoute?.(location.path);
  }
}
