import { toolResult, type SubagentRoute, type SubagentRouteBudget, type ToolDefinition } from "@fitz/agent-pi";
import type { AgentEffort, AgentRunRequest, InferenceExecutionClass, Recipe, ResolvedAgentTopology, SubagentRoleDefinition } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";
import { RouteResolver } from "@fitz/inference-core";
import { resolveLocalAgentTopology } from "@fitz/protocol";
import { Type } from "typebox";
import type { AgentRunCoordinator } from "./agent-runs.js";
import { hasCloudRouteBinding, UserRouteResolver } from "./user-route-resolver.js";
import { CLOUD_SUBAGENT_EFFORT_BUDGETS, localWorkerBudget } from "./agent-effort-policy.js";
import { assignPlanItemToWorker, reconcileAgentPlan } from "./agent-plan-tools.js";

export const SUBAGENT_TOOL = "subagent";

export const SUBAGENT_EFFORT_BUDGETS = CLOUD_SUBAGENT_EFFORT_BUDGETS;

export interface SubagentToolsOptions {
  agentRuns: AgentRunCoordinator;
  store: SqliteStore;
  executionClass?: InferenceExecutionClass;
}

/** Resolves child capacity from route and effort independently of maxTokens.
 * Local Default always delegates back to itself: Medium admits one configured
 * worker and High admits the recipe's complete anonymous pool. Missing owner-scoped cloud bindings remove the corresponding child
 * route from the selected effort's maximum. */
export function subagentRouteBudget(
  store: SqliteStore,
  ownerUserId: string,
  parentRoute: string,
  effort: AgentEffort = "normal",
  loadedLocalTopology?: (recipe: Recipe) => ResolvedAgentTopology,
): SubagentRouteBudget | undefined {
  const configured = SUBAGENT_EFFORT_BUDGETS[effort];
  const resolver = new UserRouteResolver(store, new RouteResolver(store.listRoutes(), store.listRecipes()));
  let resolved;
  try { resolved = resolver.resolve(parentRoute, ownerUserId, parentRoute === "fast"); }
  catch { return undefined; }
  if (resolver.executionClass(parentRoute, ownerUserId, parentRoute === "fast") === "self_hosted") {
    const topology = loadedLocalTopology?.(resolved.recipe) ?? resolveLocalAgentTopology(resolved.recipe);
    const workers = localWorkerBudget(effort, topology.workerCount);
    if (workers === 0 || (parentRoute !== "default" && parentRoute !== "fast" && parentRoute !== "smart")) return undefined;
    return {
      default: parentRoute === "default" ? workers : 0,
      fast: parentRoute === "fast" ? workers : 0,
      smart: parentRoute === "smart" ? workers : 0,
    };
  }
  if (parentRoute === "fast") {
    if (!hasCloudRouteBinding(store, ownerUserId, "fast") || configured.fast.fast === 0) return undefined;
    return configured.fast;
  }
  if (parentRoute !== "smart" || !hasCloudRouteBinding(store, ownerUserId, "smart")) return undefined;
  const budget = {
    default: 0,
    smart: configured.smart.smart,
    fast: hasCloudRouteBinding(store, ownerUserId, "fast") ? configured.smart.fast : 0,
  };
  return budget.fast > 0 || budget.smart > 0 ? budget : undefined;
}

/** Supports both the current Pi context (which carries the request directly)
 * and an already-running host/runtime boundary that only supplies runId. */
export function isDelegatedToolContext(
  store: SqliteStore,
  context: { runId?: string; request?: AgentRunRequest },
): boolean {
  const request = context.request ?? (context.runId ? store.getAgentRunRequest(context.runId) : undefined);
  return Boolean(request?.delegation);
}

/** Host-native delegation tool. Child turns use the normal embedded Pi runtime
 * and consume the route-specific local or cloud budget of their parent turn. */
export function createSubagentTool(options: SubagentToolsOptions, context: { runId?: string; cwd?: string }, budget: SubagentRouteBudget): ToolDefinition {
  const roles = options.store.listSubagentRoles();
  if (!roles.length) throw new Error("No enabled subagent roles are registered");
  const roleDescription = roles.map((role) => `${role.id}: ${role.dispatchDescription}`).join(" ");
  const availableRoutes = (["default", "fast", "smart"] as const).filter((route) => budget[route] > 0);
  const routeParameter = Type.String({ enum: availableRoutes, description: availableRoutes.length === 1
    ? `Defaults to the only available route: ${availableRoutes[0]}.`
    : "Route for this child; constrained by the selected parent mode's budget" });
  const parameters = Type.Object({
    route: availableRoutes.length === 1 ? Type.Optional(routeParameter) : routeParameter,
    role: Type.String({ enum: roles.map((role) => role.id), description: `Deterministic registered role for this dispatch. ${roleDescription}` }),
    plan_item_id: Type.String({ minLength: 1, maxLength: 80, description: "Worker-eligible item from the durable agent plan" }),
    concurrent_parent_task: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Required for a Smart child: the substantive work the Smart parent will perform concurrently" })),
    relevant_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Workspace paths the subagent should inspect first" })),
  });
  const used: Record<SubagentRoute, number> = { default: 0, fast: 0, smart: 0 };
  const meteredCloud = (options.executionClass ?? "metered_cloud") === "metered_cloud";
  const budgetLabel = formatBudget(budget, meteredCloud);
  return {
    name: SUBAGENT_TOOL,
    label: "Delegate task",
    description:
      `Launch one worker-eligible plan item asynchronously and immediately return control to the main agent. This turn may launch ${budgetLabel}. ${meteredCloud ? "Fast children handle bounded delegated slices. A Smart child is an optional peer reserved for independent Smart-tier work that the Smart parent advances alongside its own substantive task." : "Self-hosted workers run the same configured model as their parent."} Workers cannot delegate again.`,
    promptSnippet: "Delegate focused implementation, review, or research to an isolated subagent",
    promptGuidelines: [
      "Dispatch only a ready worker-eligible item from the durable plan. The plan item is the canonical assignment.",
      `Choose one registered role for each dispatch: ${roleDescription}`,
      "When two or more delegated tasks are independent, issue their subagent calls together in the same turn.",
      ...(meteredCloud ? [
        "Never use the Smart child for routine evidence gathering, summaries, fact checks, overflow after the Fast budget, or any other Fast-tier work.",
        "Use the Smart child only for a genuinely independent Smart-tier task that should run concurrently with substantive work by the Smart parent. Emit an allowed parent tool call immediately before it in the same response, and describe that parent work in concurrent_parent_task.",
      ] : []),
      "Budgets are maximums, not quotas. Do not retry a route after its budget is exhausted or a launch is declined.",
      "Continue substantive main-agent work immediately after launch. Collect results through agent_plan status and verify only critical or conflicting claims.",
    ],
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      const parentRunId = context.runId;
      if (!parentRunId) throw new Error("Subagent delegation requires a durable parent run");
      const parent = options.store.getAgentRun(parentRunId);
      if (!parent) throw new Error(`Parent agent run ${parentRunId} was not found`);
      const parentRequest = options.store.getAgentRunRequest(parentRunId);
      const role = options.store.getSubagentRole(params.role);
      const route = (params.route ?? (availableRoutes.length === 1 ? availableRoutes[0] : undefined)) as SubagentRoute | undefined;
      if (!route || typeof used[route] !== "number") throw new TypeError(`Choose a worker route: ${availableRoutes.join(", ")}`);
      const plan = reconcileAgentPlan(options.store, parentRunId);
      const planItem = plan?.items.find((item) => item.id === params.plan_item_id);
      if (!planItem) {
        return toolResult(`No worker was launched: plan item ${params.plan_item_id} does not exist.`, { parentRunId, status: "not_launched", reason: "unknown_plan_item" });
      }
      if (!planItem.workerEligible || planItem.status !== "pending") {
        return toolResult(`No worker was launched: plan item ${planItem.id} is ${planItem.status} and ${planItem.workerEligible ? "worker-eligible" : "main-only"}.`, { parentRunId, planItemId: planItem.id, status: "not_launched", reason: "plan_item_not_ready" });
      }
      const blockers = planItem.dependencies.filter((id) => plan?.items.find((item) => item.id === id)?.status !== "completed");
      if (blockers.length) {
        return toolResult(`No worker was launched: plan item ${planItem.id} is blocked by ${blockers.join(", ")}.`, { parentRunId, planItemId: planItem.id, status: "not_launched", reason: "plan_item_blocked" });
      }
      if (!role) {
        return toolResult(`No subagent was launched: ${params.role} is not an enabled registered role.`, {
          parentRunId,
          roleId: params.role,
          routeId: route,
          status: "not_launched",
          reason: "unknown_role",
        });
      }
      if (used[route] >= budget[route]) {
        return toolResult(`No ${route} subagent was launched: this turn's ${route} budget is exhausted (${budget[route]} allowed). Continue with the reports and parent tools already available; do not retry.`, {
          parentRunId,
          roleId: role.id,
          roleVersion: role.version,
          routeId: route,
          status: "not_launched",
          reason: "budget_exhausted",
        });
      }
      const concurrentParentTask = typeof params.concurrent_parent_task === "string" ? params.concurrent_parent_task.trim() : "";
      if (meteredCloud && route === "smart" && !concurrentParentTask) {
        return toolResult("No Smart subagent was launched: Smart children are reserved for independent Smart-tier work performed concurrently with a substantive parent task. Supply concurrent_parent_task or use a Fast child for bounded delegated work.", {
          parentRunId,
          roleId: role.id,
          roleVersion: role.version,
          routeId: route,
          status: "not_launched",
          reason: "missing_concurrent_parent_task",
        });
      }
      used[route] += 1;
      const request: Omit<AgentRunRequest, "delegation" | "sessionId"> = {
        model: route,
        effort: parentRequest?.effort ?? "normal",
        accessMode: role.accessMode,
        maxTokens: role.maxOutputTokens,
        messages: [
          { role: "system", content: subagentSystemPrompt(role, context.cwd) },
          { role: "user", content: subagentAssignmentPrompt(planItem.task, params.relevant_paths, meteredCloud && route === "smart" ? concurrentParentTask : undefined) },
        ],
      };
      const launch = options.agentRuns.launchSubagent({
        parentRunId,
        role,
        request,
        planItemId: planItem.id,
        ...(parent.ownerUserId ? { ownerUserId: parent.ownerUserId } : {}),
        ...(signal ? { signal } : {}),
      });
      try {
        assignPlanItemToWorker(options.store, parentRunId, planItem.id, launch.run.id);
      } catch (error) {
        options.agentRuns.cancel(launch.run.id);
        throw error;
      }
      void launch.result.then(
        () => { reconcileAgentPlan(options.store, parentRunId); },
        () => { reconcileAgentPlan(options.store, parentRunId); },
      );
      return toolResult(`${role.displayName} worker launched for ${planItem.id}. Continue the main-agent plan now; use agent_plan status when the result becomes relevant.`, {
        subagentRunId: launch.run.id,
        parentRunId,
        planItemId: planItem.id,
        roleId: role.id,
        roleVersion: role.version,
        routeId: launch.run.routeId,
        status: "running",
      });
    },
  } satisfies ToolDefinition<typeof parameters>;
}

function formatBudget(budget: SubagentRouteBudget, meteredCloud: boolean): string {
  if (!meteredCloud) {
    const workers = budget.default + budget.fast + budget.smart;
    return `${workers} self-hosted worker${workers === 1 ? "" : "s"}`;
  }
  const parts = [
    ...(budget.smart ? [`${budget.smart} Smart subagent${budget.smart === 1 ? "" : "s"}`] : []),
    ...(budget.fast ? [`${budget.fast} Fast subagent${budget.fast === 1 ? "" : "s"}`] : []),
    ...(budget.default ? [`${budget.default} local worker${budget.default === 1 ? "" : "s"}`] : []),
  ];
  return parts.join(" and ") || "no subagents";
}

function subagentSystemPrompt(role: SubagentRoleDefinition, cwd?: string): string {
  return [
    `You are an isolated Fitz Harness worker assigned the registered ${role.displayName} role (${role.id}@${role.version}).`,
    `Workspace root: ${cwd ?? "the working directory resolved by the Fitz runtime"}.`,
    role.systemInstructions,
    "Do not attempt to delegate to another agent.",
    `You have a hard budget of ${role.toolCallBudget} tool calls.`,
    "Your report is evidence for the parent agent, not a user-facing final answer. Distinguish observed evidence from inference and include precise paths or commands used for verification.",
    "If blocked, report the exact blocker, what you verified, and the safest next action; never imply completion.",
    role.outputContract,
  ].join("\n");
}

function subagentAssignmentPrompt(task: string, relevantPaths: string[] | undefined, concurrentParentTask?: string): string {
  const paths = relevantPaths?.length ? `\n\nInspect these paths first:\n${relevantPaths.map((path) => `- ${path}`).join("\n")}` : "";
  return [
    ...(concurrentParentTask ? [`The Smart parent is concurrently handling this separate work; do not duplicate it:\n${concurrentParentTask}`] : []),
    `Task:\n${task}${paths}`,
  ].join("\n");
}
