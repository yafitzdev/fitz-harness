import type { CatalogFacetOption, CatalogFilters, CatalogSortKey, CatalogSortOption } from "./catalog-filters.js";

export interface CatalogFilterBarOptions {
  sortOptions: CatalogSortOption[];
  facetOptions?: CatalogFacetOption[];
  /** Fired whenever the sort or a facet selection changes. */
  onChange?: () => void;
}

/**
 * The sort + facet filter row shared by the Plugins and Models stores. Each
 * catalog reads `filters` when building its query string, so a change here
 * re-queries the same way on either page. Facet options can be refreshed via
 * `setFacetOptions` (the Models store derives uploader chips from the loaded
 * results); selections whose option disappears are dropped.
 */
export class CatalogFilterBar {
  readonly element: HTMLElement;
  readonly sortSelect: HTMLSelectElement;
  private readonly facets: HTMLElement;
  private readonly facetButtons = new Map<string, HTMLButtonElement>();
  private facetOptions: CatalogFacetOption[];
  private onChange: (() => void) | undefined;

  constructor(options: CatalogFilterBarOptions) {
    this.facetOptions = options.facetOptions ?? [];
    this.onChange = options.onChange;

    this.element = document.createElement("div");
    this.element.className = "catalog-filter-bar";

    const sort = document.createElement("label");
    sort.className = "catalog-filter-sort";
    const caption = document.createElement("span");
    caption.textContent = "Sort";
    this.sortSelect = document.createElement("select");
    this.sortSelect.className = "catalog-filter-select";
    this.sortSelect.setAttribute("aria-label", "Sort catalog");
    for (const option of options.sortOptions) {
      const item = document.createElement("option");
      item.value = `${option.key}:${option.direction}`;
      item.textContent = option.label;
      this.sortSelect.append(item);
    }
    this.sortSelect.addEventListener("change", () => this.onChange?.());
    sort.append(caption, this.sortSelect);

    this.facets = document.createElement("div");
    this.facets.className = "catalog-filter-facets";
    this.renderFacets();

    this.element.append(sort, this.facets);
  }

  /** The current sort + facet selection, ready for `catalogQueryString`. */
  get filters(): CatalogFilters {
    const [key, direction] = this.sortSelect.value.split(":") as [CatalogSortKey, "asc" | "desc"];
    const facets = [...this.facetButtons.values()]
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.dataset.facet ?? "");
    return { sort: { key, direction }, facets };
  }

  /** Replaces the facet chips, keeping any selection whose option still exists. */
  setFacetOptions(options: CatalogFacetOption[]): void {
    this.facetOptions = options;
    this.renderFacets(new Set(this.filters.facets));
  }

  private renderFacets(selected: Set<string> = new Set()): void {
    this.facets.replaceChildren();
    this.facetButtons.clear();
    for (const option of this.facetOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "catalog-filter-chip";
      button.dataset.facet = option.key;
      button.textContent = option.label;
      button.setAttribute("aria-pressed", selected.has(option.key) ? "true" : "false");
      button.classList.toggle("active", selected.has(option.key));
      button.addEventListener("click", () => {
        const pressed = button.getAttribute("aria-pressed") === "true";
        button.setAttribute("aria-pressed", pressed ? "false" : "true");
        button.classList.toggle("active", !pressed);
        this.onChange?.();
      });
      this.facetButtons.set(option.key, button);
      this.facets.append(button);
    }
  }
}
