import { RouteResolver } from "@fitz/inference-core";
import type { SqliteStore } from "@fitz/storage";
import { resolveRecipeAgentTopology, type AgentRunRequest, type InferenceExecutionClass } from "@fitz/protocol";
import { UserRouteResolver } from "./user-route-resolver.js";
import { effortContextTokens } from "./agent-effort-policy.js";
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

/** Self-hosted inference always uses the context configured on its recipe;
 * effort changes worker admission only. Metered cloud routes retain the
 * product's cost-aware effort caps. Delegated self-hosted children use the
 * recipe's configured per-worker window. */
export function contextTokensForAgentRequest(store: SqliteStore, request: AgentRunRequest, ownerUserId = "local"): number {
  try {
    const resolver = routeResolver(store);
    const resolved = resolver.resolve(request.model, ownerUserId, request.model === "fast");
    const topology = resolveRecipeAgentTopology(resolved.recipe);
    if (resolver.executionClass(request.model, ownerUserId, request.model === "fast") === "self_hosted") {
      return request.delegation && topology.workerCount > 0 ? topology.workerContextTokens : topology.orchestratorContextTokens;
    }
    return Math.min(topology.orchestratorContextTokens, effortContextTokens(request.effort));
  } catch {
    return Math.min(100_000, effortContextTokens(request.effort));
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
