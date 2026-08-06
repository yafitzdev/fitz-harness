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

export interface CatalogFacetOption {
  /** Stable key exposed as data-facet; also used in `CatalogFilters.facets`. */
  key: string;
  label: string;
}

export interface CatalogFilters {
  sort: CatalogSortSelection;
  /** Selected facet keys; empty means no facet filter. */
  facets: string[];
}

export const CATALOG_SORT_KEYS: readonly CatalogSortKey[] = ["downloads", "updated", "name", "likes"];

/** Serializes the shared filters into `sort=…&direction=…` query params. */
export function catalogQueryString(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  params.set("sort", filters.sort.key);
  params.set("direction", filters.sort.direction);
  return params.toString();
}
