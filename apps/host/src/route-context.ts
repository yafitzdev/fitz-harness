import { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import { UserRouteResolver } from "./user-route-resolver.js";

/** Context window of the exact owner-scoped recipe Pi will call. Fast is an
 * internal cloud role. Unknown or unconfigured roles use Pi's 100k construction
 * default so context preparation can fail safely at route admission later. */
export function contextTokensForRoute(store: SqliteStore, routeId: string, ownerUserId = "local"): number {
  const resolver = new UserRouteResolver(
    store,
    new RouteResolver(store.listRoutes(), store.listRecipes()),
  );
  try {
    return resolver.contextTokens(routeId, ownerUserId, routeId === "fast");
  } catch {
    return 100_000;
  }
}
