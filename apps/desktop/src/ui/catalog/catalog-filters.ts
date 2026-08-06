/**
 * Shared filter contract for the Plugins and Models stores. Both catalogs are
 * server-paginated search results, so they share the same sort dimensions and
 * a single query-string builder; each store maps the generic keys to its own
 * upstream (`downloads` → npm popularity for plugins, HF `downloads` for
 * models, `updated` → npm `date` / HF `lastModified`, …).
 */

export type CatalogSortKey = "downloads" | "updated" | "name" | "likes";

/** The active sort, as carried by `CatalogFilters` and serialized to the query. */
export interface CatalogSortSelection {
  key: CatalogSortKey;
  direction: "asc" | "desc";
}

export interface CatalogSortOption extends CatalogSortSelection {
  /** Dropdown label, e.g. "Most downloads". */
  label: string;
}

/**
 * A threshold slider (e.g. minimum likes or downloads) rendered next to the
 * sort. The slider snaps to `stops`, which should be low → high round values
 * (typically log-spaced, since catalog stats are heavily skewed); position 0
 * means "no filter" and is dropped from the query string.
 */
export interface CatalogNumericFilter {
  /** Query-param key, e.g. `min_likes`; only serialized when set to a positive integer. */
  key: string;
  label: string;
  /** Discrete threshold stops, low → high; the slider snaps to these. */
  stops: number[];
  /** Optional display formatter for the readout, e.g. compact "12K". */
  format?: (value: number) => string;
}

export interface CatalogFilters {
  sort: CatalogSortSelection;
  /** Threshold values keyed by `CatalogNumericFilter.key`; `undefined` means unset. */
  numeric: Record<string, number | undefined>;
}

export const CATALOG_SORT_KEYS: readonly CatalogSortKey[] = ["downloads", "updated", "name", "likes"];

/** Serializes the shared filters into `sort=…&direction=…` query params (plus any thresholds). */
export function catalogQueryString(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  params.set("sort", filters.sort.key);
  params.set("direction", filters.sort.direction);
  for (const [key, value] of Object.entries(filters.numeric)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      params.set(key, String(Math.trunc(value)));
    }
  }
  return params.toString();
}
