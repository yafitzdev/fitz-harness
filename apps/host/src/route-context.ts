import { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import { LOCAL_MAIN_CONTEXT_TOKENS, LOCAL_WORKER_CONTEXT_TOKENS, resolveLocalAgentTopology, type AgentRunRequest, type InferenceExecutionClass, type Recipe, type ResolvedAgentTopology } from "@fitz/protocol";
import { UserRouteResolver } from "./user-route-resolver.js";
import type { ThinkingFormat } from "@fitz/agent-pi";

/** Context window of the exact owner-scoped recipe Pi will call. Fast is an
 * internal cloud role. Unknown or unconfigured roles use Pi's 100k construction
 * default so context preparation can fail safely at route admission later. */
export function contextTokensForRoute(store: SqliteStore, routeId: string, ownerUserId = "local"): number {
  try {
    return routeResolver(store).contextTokens(routeId, ownerUserId, routeId === "fast");
  } catch {
    return 100_000;
  }
}

export function executionClassForRoute(store: SqliteStore, routeId: string, ownerUserId = "local"): InferenceExecutionClass {
  try { return routeResolver(store).executionClass(routeId, ownerUserId, routeId === "fast"); }
  catch { return "self_hosted"; }
}

/** Context allocation is engine-independent: every main agent receives the
 * 131k quality ceiling and delegated workers receive the derived local window
 * (32k target with a 10% boundary tolerance). Effort affects
 * worker admission counts, never an individual agent's context window. */
export function contextTokensForAgentRequest(
  store: SqliteStore,
  request: AgentRunRequest,
  ownerUserId = "local",
  loadedLocalTopology?: (recipe: Recipe) => ResolvedAgentTopology,
): number {
  try {
    const resolver = routeResolver(store);
    const resolved = resolver.resolve(request.model, ownerUserId, request.model === "fast");
    if (resolver.executionClass(request.model, ownerUserId, request.model === "fast") === "self_hosted") {
      const local = loadedLocalTopology?.(resolved.recipe) ?? resolveLocalAgentTopology(resolved.recipe);
      return request.delegation && local.workerCount > 0 ? local.workerContextTokens : local.orchestratorContextTokens;
    }
    return request.delegation
      ? Math.min(LOCAL_WORKER_CONTEXT_TOKENS, resolved.recipe.contextTokens)
      : Math.min(LOCAL_MAIN_CONTEXT_TOKENS, resolved.recipe.contextTokens);
  } catch {
    return request.delegation ? LOCAL_WORKER_CONTEXT_TOKENS : LOCAL_MAIN_CONTEXT_TOKENS;
  }
}

/** Reasoning is normalized for every engine. This selects only the resolved
 * provider's wire-level controls. NInfer can preserve closed-turn Qwen
 * reasoning, keeping recurrent prefix reuse intact across tool loops. */
export function thinkingFormatForAgentRequest(store: SqliteStore, request: AgentRunRequest, ownerUserId = "local"): ThinkingFormat | undefined {
  try {
    const resolved = routeResolver(store).resolve(request.model, ownerUserId, request.model === "fast");
    return resolved.recipe.adapter === "ninfer" ? "ninfer" : undefined;
  } catch {
    return undefined;
  }
}

function routeResolver(store: SqliteStore): UserRouteResolver {
  return new UserRouteResolver(store, new RouteResolver(store.listRoutes(), store.listRecipes()));
}
