/**
 * The host's custom (non-Pi-native) agent tools, composed in one place.
 *
 * `buildCustomToolDefinitions` is the single source of truth for the tools the
 * agent runtime registers per run (wired through `PiAgentRuntime.customTools`).
 * `listCustomToolSummaries` reuses that same composition to project the full
 * set of custom tools into display metadata for the management UI, so the
 * Plugins page's "Custom" section can never drift from what the runtime
 * actually registers.
 */

import { createLspTool, requiredInitialSubagentRoutes, type ToolDefinition } from "@fitz/agent-pi";
import type { LspService } from "@fitz/lsp";
import type { SecurityService } from "@fitz/security";
import type { SqliteStore } from "@fitz/storage";
import type { AgentRunRequest, Recipe, ResolvedAgentTopology } from "@fitz/protocol";
import type { AgentRunCoordinator } from "./agent-runs.js";
import type { AgentSafetyService } from "./agent-safety/index.js";
import { createAgentPlanTool } from "./agent-plan-tools.js";
import type { MediaJobCoordinator } from "./media-jobs.js";
import { createMediaTools } from "./media-tools.js";
import { executionClassForRoute } from "./route-context.js";
import { createSubagentTool, isDelegatedToolContext, subagentRouteBudget } from "./subagent-tools.js";
import { LOCAL_OWNER_ID } from "./user-route-resolver.js";

/** Display metadata for one custom tool, as shown in the management UI. */
export interface CustomToolSummary {
  name: string;
  label: string;
  description: string;
}

/** The per-run context the runtime hands to the `customTools` hook. */
export type CustomToolContext = { cwd: string; runId?: string; request?: AgentRunRequest };

/** Everything `buildCustomToolDefinitions` needs to compose the tool set. */
export interface CustomToolDependencies {
  store: SqliteStore;
  safety: AgentSafetyService;
  lsp: LspService;
  lspEnabled: boolean;
  mediaJobs?: MediaJobCoordinator;
  agentRuns?: AgentRunCoordinator;
  security?: SecurityService;
  loadedLocalTopology?: (recipe: Recipe) => ResolvedAgentTopology;
}

/**
 * Composes the custom tools for one agent run. This is the exact set the
 * runtime registers: the safety tools (trash + sandboxed bash), the LSP tool
 * (when a provider is configured), and — for non-delegated (root) runs — the
 * plan, media, and subagent tools.
 */
export function buildCustomToolDefinitions(deps: CustomToolDependencies, context: CustomToolContext): ToolDefinition[] {
  const { store, safety, lsp, lspEnabled, mediaJobs, agentRuns, security, loadedLocalTopology } = deps;
  const delegated = isDelegatedToolContext(store, context);
  const ownerUserId = (context.runId ? store.getAgentRun(context.runId)?.ownerUserId : undefined) ?? LOCAL_OWNER_ID;
  const parentRequest = context.request ?? (context.runId ? store.getAgentRunRequest(context.runId) : undefined);
  const parentRoute = parentRequest?.model ?? "default";
  const subagentBudget = subagentRouteBudget(store, ownerUserId, parentRoute, parentRequest?.effort ?? "normal", loadedLocalTopology);
  return [
    ...safety.createCustomTools()(context),
    ...(lspEnabled ? [createLspTool(lsp, context)] : []),
    ...(!delegated ? [createAgentPlanTool({
      store,
      ...(parentRequest && subagentBudget ? { requiredWorkerRoutes: [...requiredInitialSubagentRoutes(parentRequest, subagentBudget)] } : {}),
    }, context)] : []),
    // Authenticated runs enforce the owner's media quota and route grants.
    // Explicit local auth-disabled mode has no user and follows the existing
    // administrator-diagnostic path used by the management media test.
    ...(!delegated && mediaJobs ? createMediaTools({ mediaJobs, store, ...(security ? { security } : {}) })(context) : []),
    ...(!delegated && subagentBudget && agentRuns ? [createSubagentTool({
      agentRuns,
      store,
      executionClass: executionClassForRoute(store, parentRoute, ownerUserId),
    }, context, subagentBudget)] : []),
  ];
}

/**
 * The full set of custom tools the host can register, projected to display
 * metadata. Uses a representative root-agent context (not delegated, default
 * route, normal effort) so the list reflects the richest tool set a run gets.
 */
export function listCustomToolSummaries(deps: CustomToolDependencies): CustomToolSummary[] {
  const context: CustomToolContext = { cwd: "", request: { model: "default", effort: "normal", messages: [] } };
  return buildCustomToolDefinitions(deps, context).map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
  }));
}