import { toolResult, type SubagentRoute, type SubagentRouteBudget, type ToolDefinition } from "@fitz/agent-pi";
import type { AgentEffort, AgentRunRequest, SubagentRoleDefinition } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";
import { Type } from "typebox";
import type { AgentRunCoordinator } from "./agent-runs.js";
import { hasCloudRouteBinding } from "./user-route-resolver.js";
import { localAgentTopology } from "./local-agent-topology.js";

export const SUBAGENT_TOOL = "subagent";

export const SUBAGENT_EFFORT_BUDGETS: Readonly<Record<AgentEffort, Readonly<Record<"fast" | "smart", SubagentRouteBudget>>>> = {
  light: {
    fast: { default: 0, fast: 0, smart: 0 },
    smart: { default: 0, fast: 0, smart: 0 },
  },
  normal: {
    fast: { default: 0, fast: 2, smart: 0 },
    smart: { default: 0, fast: 3, smart: 0 },
  },
  high: {
    fast: { default: 0, fast: 3, smart: 0 },
    smart: { default: 0, fast: 3, smart: 1 },
  },
};

export interface SubagentToolsOptions {
  agentRuns: AgentRunCoordinator;
  store: SqliteStore;
}

/** Resolves child capacity from route and effort independently of maxTokens.
 * Local Default delegates exactly up to its selected recipe's anonymous worker
 * pool, independently of effort. Missing owner-scoped cloud bindings remove the corresponding child
 * route from the selected effort's maximum. */
export function subagentRouteBudget(store: SqliteStore, ownerUserId: string, parentRoute: string, effort: AgentEffort = "normal"): SubagentRouteBudget | undefined {
  const configured = SUBAGENT_EFFORT_BUDGETS[effort];
  if (parentRoute === "default") {
    const topology = localAgentTopology(store);
    const workers = topology?.maxWorkers ?? 0;
    return workers > 0 ? { default: workers, fast: 0, smart: 0 } : undefined;
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
export function createSubagentTool(options: SubagentToolsOptions, context: { runId?: string }, budget: SubagentRouteBudget): ToolDefinition {
  const roles = options.store.listSubagentRoles();
  if (!roles.length) throw new Error("No enabled subagent roles are registered");
  const roleDescription = roles.map((role) => `${role.id}: ${role.dispatchDescription}`).join(" ");
  const parameters = Type.Object({
    route: Type.Union([Type.Literal("default"), Type.Literal("fast"), Type.Literal("smart")], { description: "Route for this child; constrained by the selected parent mode's budget" }),
    role: Type.String({ enum: roles.map((role) => role.id), description: `Deterministic registered role for this dispatch. ${roleDescription}` }),
    task: Type.String({ minLength: 1, maxLength: 12_000, description: "A self-contained task with the expected result and important constraints" }),
    concurrent_parent_task: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Required for a Smart child: the substantive work the Smart parent will perform concurrently" })),
    relevant_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Workspace paths the subagent should inspect first" })),
  });
  const used: Record<SubagentRoute, number> = { default: 0, fast: 0, smart: 0 };
  const budgetLabel = formatBudget(budget);
  return {
    name: SUBAGENT_TOOL,
    label: "Delegate task",
    description:
      `Delegate one focused task to an isolated Fitz subagent and wait for its report. This turn may launch ${budgetLabel}. Local and Fast children handle bounded delegated slices. The Smart child is an optional peer reserved for independent Smart-tier work that the Smart parent advances alongside its own substantive task. Subagents cannot delegate again.`,
    promptSnippet: "Delegate focused implementation, review, or research to an isolated subagent",
    promptGuidelines: [
      "Give the subagent a self-contained task, expected output, constraints, and the most relevant paths.",
      `Choose one registered role for each dispatch: ${roleDescription}`,
      "When two or more delegated tasks are independent, issue their subagent calls together in the same turn.",
      "For broad project familiarization, proactively use the available bounded workers. Split the repository into disjoint scopes, dispatch them first, and start the parent's own overarching analysis in the same tool-call batch.",
      "Never use the Smart child for repository scanning, summaries, fact checks, overflow after the Fast budget, or any other Fast-tier work.",
      "Use the Smart child only for a genuinely independent Smart-tier task that should run concurrently with substantive work by the Smart parent. Emit an allowed parent tool call immediately before it in the same response, and describe that parent work in concurrent_parent_task.",
      "Budgets are maximums, not quotas. Do not retry a route after its budget is exhausted or a launch is declined.",
      "After the report returns, synthesize it directly and verify only critical or conflicting claims with targeted reads. Never repeat the child's full repository scan.",
    ],
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) => {
      const parentRunId = context.runId;
      if (!parentRunId) throw new Error("Subagent delegation requires a durable parent run");
      const parent = options.store.getAgentRun(parentRunId);
      if (!parent) throw new Error(`Parent agent run ${parentRunId} was not found`);
      const role = options.store.getSubagentRole(params.role);
      const route = params.route as SubagentRoute;
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
      if (route === "smart" && !concurrentParentTask) {
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
        accessMode: role.accessMode,
        maxTokens: role.maxOutputTokens,
        messages: [
          { role: "system", content: subagentSystemPrompt(role) },
          { role: "user", content: subagentAssignmentPrompt(params.task, params.relevant_paths, route === "smart" ? concurrentParentTask : undefined) },
        ],
      };
      const result = await options.agentRuns.runSubagent({
        parentRunId,
        role,
        request,
        ...(parent.ownerUserId ? { ownerUserId: parent.ownerUserId } : {}),
        ...(signal ? { signal } : {}),
      });
      if (result.run.status !== "completed") {
        throw new Error(result.run.error || `${role.id} subagent ${result.run.status}`);
      }
      return toolResult(result.text || `${role.id} subagent completed without a written report.`, {
        subagentRunId: result.run.id,
        parentRunId,
        roleId: role.id,
        roleVersion: role.version,
        routeId: result.run.routeId,
        status: result.run.status,
      });
    },
  } satisfies ToolDefinition<typeof parameters>;
}

function formatBudget(budget: SubagentRouteBudget): string {
  const parts = [
    ...(budget.smart ? [`${budget.smart} Smart subagent${budget.smart === 1 ? "" : "s"}`] : []),
    ...(budget.fast ? [`${budget.fast} Fast subagent${budget.fast === 1 ? "" : "s"}`] : []),
    ...(budget.default ? [`${budget.default} local worker${budget.default === 1 ? "" : "s"}`] : []),
  ];
  return parts.join(" and ") || "no subagents";
}

function subagentSystemPrompt(role: SubagentRoleDefinition): string {
  return [
    `You are an isolated Fitz Codex worker assigned the registered ${role.displayName} role (${role.id}@${role.version}).`,
    role.systemInstructions,
    "Do not attempt to delegate to another agent.",
    `You have a hard budget of ${role.toolCallBudget} tool calls.`,
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
