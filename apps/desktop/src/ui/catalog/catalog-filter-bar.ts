import type { CatalogFilters, CatalogNumericFilter, CatalogSortKey, CatalogSortOption } from "./catalog-filters.js";

/** A threshold slider: the range input holds a stop index; the readout shows the stop. */
interface NumericSlider {
  input: HTMLInputElement;
  stops: number[];
  format: ((value: number) => string) | undefined;
}

export interface CatalogFilterBarOptions {
  sortOptions: CatalogSortOption[];
  /** Threshold inputs rendered next to the sort (e.g. minimum likes/downloads). */
  numericFilters?: CatalogNumericFilter[];
  /** Fired whenever the sort or a threshold changes. */
  onChange?: () => void;
}

/**
 * The sort + threshold filter row shared by the Plugins and Models stores.
 * Each catalog reads `filters` when building its query string, so a change
 * here re-queries the same way on either page. Threshold sliders snap to
 * their stops; the readout follows the thumb while dragging, and the query
 * fires on release.
 */
export class CatalogFilterBar {
  readonly element: HTMLElement;
  readonly sortSelect: HTMLSelectElement;
  private readonly numericInputs = new Map<string, NumericSlider>();
  private onChange: (() => void) | undefined;

  constructor(options: CatalogFilterBarOptions) {
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

    const numeric = document.createElement("div");
    numeric.className = "catalog-filter-numeric";
    for (const filter of options.numericFilters ?? []) {
      const label = document.createElement("label");
      label.className = "catalog-filter-number";
      const labelCaption = document.createElement("span");
      labelCaption.textContent = filter.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = String(Math.max(0, filter.stops.length - 1));
      input.step = "1";
      input.value = "0";
      input.setAttribute("aria-label", filter.label);
      const readout = document.createElement("span");
      readout.className = "catalog-filter-value";
      readout.setAttribute("aria-live", "polite");
      const updateReadout = (): void => {
        const value = filter.stops[Number(input.value)] ?? 0;
        readout.textContent = filter.format ? filter.format(value) : String(value);
        input.setAttribute("aria-valuetext", String(value));
      };
      // The readout follows the thumb while dragging; the query fires on release.
      input.addEventListener("input", updateReadout);
      input.addEventListener("change", () => { updateReadout(); this.onChange?.(); });
      updateReadout();
      this.numericInputs.set(filter.key, { input, stops: filter.stops, format: filter.format });
      label.append(labelCaption, input, readout);
      numeric.append(label);
    }

    this.element.append(sort, numeric);
  }

  /** The current sort + threshold selection, ready for `catalogQueryString`. */
  get filters(): CatalogFilters {
    const [key, direction] = this.sortSelect.value.split(":") as [CatalogSortKey, "asc" | "desc"];
    const numeric: Record<string, number | undefined> = {};
    for (const [filterKey, slider] of this.numericInputs) {
      const value = slider.stops[Number(slider.input.value)] ?? 0;
      numeric[filterKey] = value > 0 ? value : undefined;
    }
    return { sort: { key, direction }, numeric };
  }
}
