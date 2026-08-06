import { ModelCatalogController, type ModelCatalogApi } from "./model-catalog.js";

export interface ModelsPageOptions {
  /** The <section id="models-page"> element from the shell markup. */
  page: HTMLElement;
  api: ModelCatalogApi;
  openExternal: (url: string) => void | Promise<void>;
  openPath: (path: string) => void | Promise<void>;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

/**
 * Owns the Models management page: the Hugging Face catalog filtered by
 * pipeline tag, per-model downloads, and the list of GGUF files on the host.
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
    const pipelineTabs = [...options.page.querySelectorAll<HTMLButtonElement>(".management-page-tabs [data-pipeline]")];
    if (pipelineTabs.length === 0) throw new Error("Models page is missing pipeline tabs");
    this.catalog = new ModelCatalogController({
      view: require("models-view"),
      title: require("models-title"),
      modelSearch: require("model-search"),
      downloadedList: require("downloaded-models"),
      catalogList: require("model-catalog"),
      loadMoreModels: require("load-more-models"),
      refresh: require("refresh-models"),
      pipelineTabs,
    }, {
      api: options.api,
      openExternal: options.openExternal,
      openPath: options.openPath,
      showToast: options.showToast,
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
