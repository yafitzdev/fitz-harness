import { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import type { AgentRunRequest } from "@fitz/protocol";
import { localAgentTopology } from "./local-agent-topology.js";
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

/** Main local runs use the selected recipe's full context. Delegated local
 * workers use the smaller recipe-declared worker window; cloud routes retain
 * their provider recipe's own context. */
export function contextTokensForAgentRequest(store: SqliteStore, request: AgentRunRequest, ownerUserId = "local"): number {
  const routeContext = contextTokensForRoute(store, request.model, ownerUserId);
  if (!request.delegation || request.model !== "default") return routeContext;
  return Math.min(routeContext, localAgentTopology(store)?.workerContextTokens ?? routeContext);
}
