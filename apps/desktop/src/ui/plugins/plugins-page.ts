import { createPluginCatalogClient, PluginCatalogController, type PluginCatalogApi } from "./plugin-catalog.js";
import type { ActionFeedback } from "../primitives/action-status.js";

export interface PluginsPageOptions {
  /** The <section id="plugins-page"> element from the shell markup. */
  page: HTMLElement;
  api: PluginCatalogApi;
  openExternal: (url: string) => void | Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

/**
 * Owns the Plugins management page: the Pi package catalog, installed skills,
 * and their shared loading and refresh behavior. All catalog controls live
 * inside the page element, so element lookup is scoped instead of global, and
 * the catalog itself is delegated to PluginCatalogController.
 */
export class PluginsPageController {
  private readonly catalog: PluginCatalogController;

  constructor(options: PluginsPageOptions) {
    const require = <T extends HTMLElement>(id: string): T => {
      const value = options.page.querySelector<T>(`#${id}`);
      if (!value) throw new Error(`Plugins page is missing #${id}`);
      return value;
    };
    const typeTabs = [...options.page.querySelectorAll<HTMLButtonElement>(".management-page-tabs [data-type]")];
    if (typeTabs.length === 0) throw new Error("Plugins page is missing type tabs");
    this.catalog = new PluginCatalogController({
      pluginsView: require("plugins-view"),
      title: require("plugins-title"),
      installedSection: require("plugins-installed-section"),
      skillsSection: require("plugins-skills-section"),
      pluginSearch: require("plugin-search"),
      installedPlugins: require("installed-plugins"),
      pluginCatalog: require("plugin-catalog"),
      installedSkills: require("installed-skills"),
      loadMorePlugins: require("load-more-plugins"),
      refresh: require("refresh-plugins"),
      typeTabs,
    }, {
      api: createPluginCatalogClient(options.api),
      openExternal: options.openExternal,
      showStatus: options.showStatus,
      errorMessage: options.errorMessage,
    });
  }

  /** Replaces the installed section with a loading placeholder before a refresh. */
  showLoading(): void {
    this.catalog.showLoading();
  }

  /** Loads installed packages, skills, and the first catalog page. */
  async load(appendCatalog = false): Promise<void> {
    await this.catalog.load(appendCatalog);
  }
}
