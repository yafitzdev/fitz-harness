import { createModelCatalogClient, ModelCatalogController, type ModelCatalogApi } from "./model-catalog.js";
import type { ActionFeedback } from "../primitives/action-status.js";

export interface ModelsPageOptions {
  /** The <section id="models-page"> element from the shell markup. */
  page: HTMLElement;
  api: ModelCatalogApi;
  openExternal: (url: string) => void | Promise<void>;
  openPath: (path: string) => void | Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

/**
 * Owns the Models management page: the Hugging Face catalog separated by
 * output category, per-model downloads, and the list of GGUF files on the host.
 * The catalog behavior is delegated to ModelCatalogController; this wrapper
 * just resolves the page's elements and forwards the shared loading behavior.
 */
export class ModelsPageController {
  private readonly catalog: ModelCatalogController;

  constructor(options: ModelsPageOptions) {
    const require = <T extends HTMLElement>(id: string): T => {
      const value = options.page.querySelector<T>(`#${id}`);
      if (!value) throw new Error(`Models page is missing #${id}`);
      return value;
    };
    const categoryTabs = [...options.page.querySelectorAll<HTMLButtonElement>(".management-page-tabs [data-category]")];
    if (categoryTabs.length === 0) throw new Error("Models page is missing category tabs");
    this.catalog = new ModelCatalogController({
      view: require("models-view"),
      title: require("models-title"),
      modelSearch: require("model-search"),
      downloadedList: require("downloaded-models"),
      catalogList: require("model-catalog"),
      loadMoreModels: require("load-more-models"),
      refresh: require("refresh-models"),
      categoryTabs,
    }, {
      api: createModelCatalogClient(options.api),
      openExternal: options.openExternal,
      openPath: options.openPath,
      showStatus: options.showStatus,
      errorMessage: options.errorMessage,
    });
  }

  /** Replaces the lists with a loading placeholder before a refresh. */
  showLoading(): void {
    this.catalog.showLoading();
  }

  /** Loads downloaded models, active downloads, and the first catalog page. */
  async load(appendCatalog = false): Promise<void> {
    await this.catalog.load(appendCatalog);
  }
}
