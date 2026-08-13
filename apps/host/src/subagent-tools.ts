import { toolResult, type SubagentRoute, type SubagentRouteBudget, type ToolDefinition } from "@fitz/agent-pi";
import type { AgentEffort, AgentRunRequest, SubagentRole, ToolAccessMode } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";
import { Type } from "typebox";
import type { AgentRunCoordinator } from "./agent-runs.js";
import { hasCloudRouteBinding } from "./user-route-resolver.js";

export const SUBAGENT_TOOL = "subagent";

export const SUBAGENT_EFFORT_BUDGETS: Readonly<Record<AgentEffort, Readonly<Record<"fast" | "smart", SubagentRouteBudget>>>> = {
  light: {
    fast: { fast: 0, smart: 0 },
    smart: { fast: 0, smart: 0 },
  },
  normal: {
    fast: { fast: 2, smart: 0 },
    smart: { fast: 3, smart: 0 },
  },
  high: {
    fast: { fast: 3, smart: 0 },
    smart: { fast: 3, smart: 1 },
  },
};

const SUBAGENT_ACCESS: Readonly<Record<SubagentRole, ToolAccessMode>> = {
  worker: "full",
  reviewer: "read-only",
  researcher: "read-only",
};

const SUBAGENT_MAX_TOKENS: Readonly<Record<SubagentRole, number>> = {
  worker: 10_000,
  reviewer: 4_096,
  researcher: 4_096,
};

const SUBAGENT_TOOL_BUDGET: Readonly<Record<SubagentRole, number>> = {
  worker: 40,
  reviewer: 16,
  researcher: 20,
};

const parameters = Type.Object({
  route: Type.Union([Type.Literal("fast"), Type.Literal("smart")], { description: "Cloud route for this child; constrained by the selected parent mode's budget" }),
  role: Type.Union([
    Type.Literal("worker"),
    Type.Literal("reviewer"),
    Type.Literal("researcher"),
  ], { description: "Focused role for the delegated task" }),
  task: Type.String({ minLength: 1, maxLength: 12_000, description: "A self-contained task with the expected result and important constraints" }),
  concurrent_parent_task: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Required for a Smart child: the substantive work the Smart parent will perform concurrently" })),
  relevant_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Workspace paths the subagent should inspect first" })),
});

export interface SubagentToolsOptions {
  agentRuns: AgentRunCoordinator;
  store: SqliteStore;
}

/** Resolves child capacity from route and effort independently of maxTokens.
 * Default and Light never delegate. Missing owner-scoped bindings remove the
 * corresponding child route from the selected effort's maximum. */
export function subagentRouteBudget(store: SqliteStore, ownerUserId: string, parentRoute: string, effort: AgentEffort = "normal"): SubagentRouteBudget | undefined {
  const configured = SUBAGENT_EFFORT_BUDGETS[effort];
  if (parentRoute === "fast") {
    if (!hasCloudRouteBinding(store, ownerUserId, "fast") || configured.fast.fast === 0) return undefined;
    return configured.fast;
  }
  if (parentRoute !== "smart" || !hasCloudRouteBinding(store, ownerUserId, "smart")) return undefined;
  const budget = {
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
 * and consume the route-specific cloud budget of their parent turn. */
export function createSubagentTool(options: SubagentToolsOptions, context: { runId?: string }, budget: SubagentRouteBudget): ToolDefinition {
  const used: Record<SubagentRoute, number> = { fast: 0, smart: 0 };
  const budgetLabel = formatBudget(budget);
  return {
    name: SUBAGENT_TOOL,
    label: "Delegate task",
    description:
      `Delegate one focused task to an isolated Fitz cloud subagent and wait for its report. This turn may launch ${budgetLabel}. Fast children handle bounded delegated slices. The Smart child is an optional peer reserved for independent Smart-tier work that the Smart parent advances alongside its own substantive task. Subagents cannot delegate again.`,
    promptSnippet: "Delegate focused implementation, review, or research to an isolated subagent",
    promptGuidelines: [
      "Give the subagent a self-contained task, expected output, constraints, and the most relevant paths.",
      "Use worker for implementation, reviewer for independent review, and researcher for investigation or source gathering.",
      "When two or more delegated tasks are independent, issue their subagent calls together in the same turn.",
      `For broad project familiarization, proactively use the available Fast children only. Split the repository into disjoint scopes, dispatch them first, and start the parent's own overarching analysis in the same tool-call batch.`,
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
      const role = params.role as SubagentRole;
      const route = params.route as SubagentRoute;
      if (used[route] >= budget[route]) {
        return toolResult(`No ${route} subagent was launched: this turn's ${route} budget is exhausted (${budget[route]} allowed). Continue with the reports and parent tools already available; do not retry.`, {
          parentRunId,
          role,
          routeId: route,
          status: "not_launched",
          reason: "budget_exhausted",
        });
      }
      const concurrentParentTask = typeof params.concurrent_parent_task === "string" ? params.concurrent_parent_task.trim() : "";
      if (route === "smart" && !concurrentParentTask) {
        return toolResult("No Smart subagent was launched: Smart children are reserved for independent Smart-tier work performed concurrently with a substantive parent task. Supply concurrent_parent_task or use a Fast child for bounded delegated work.", {
          parentRunId,
          role,
          routeId: route,
          status: "not_launched",
          reason: "missing_concurrent_parent_task",
        });
      }
      used[route] += 1;
      const request: Omit<AgentRunRequest, "delegation" | "sessionId"> = {
        model: route,
        accessMode: SUBAGENT_ACCESS[role],
        maxTokens: SUBAGENT_MAX_TOKENS[role],
        messages: [{ role: "user", content: subagentPrompt(role, params.task, params.relevant_paths, SUBAGENT_TOOL_BUDGET[role], route === "smart" ? concurrentParentTask : undefined) }],
      };
      const result = await options.agentRuns.runSubagent({
        parentRunId,
        role,
        toolCallBudget: SUBAGENT_TOOL_BUDGET[role],
        request,
        ...(parent.ownerUserId ? { ownerUserId: parent.ownerUserId } : {}),
        ...(signal ? { signal } : {}),
      });
      if (result.run.status !== "completed") {
        throw new Error(result.run.error || `${role} subagent ${result.run.status}`);
      }
      return toolResult(result.text || `${role} subagent completed without a written report.`, {
        subagentRunId: result.run.id,
        parentRunId,
        role,
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
  ];
  return parts.join(" and ") || "no subagents";
}

function subagentPrompt(role: SubagentRole, task: string, relevantPaths: string[] | undefined, toolCallBudget: number, concurrentParentTask?: string): string {
  const roleInstructions: Record<SubagentRole, string> = {
    worker: "Implement the requested change. Inspect before editing, preserve unrelated work, and verify the result in proportion to risk.",
    reviewer: "Independently inspect and critique the requested scope. Do not modify files. Report concrete findings with file references and distinguish confirmed issues from suggestions.",
    researcher: "Investigate the requested question without modifying files. Gather evidence, cite files or sources precisely, and return a compact synthesis useful to the parent agent.",
  };
  const paths = relevantPaths?.length ? `\n\nInspect these paths first:\n${relevantPaths.map((path) => `- ${path}`).join("\n")}` : "";
  return [
    `You are the ${role} subagent in Fitz Codex.`,
    roleInstructions[role],
    "You have a fresh isolated context. Do not attempt to delegate to another agent.",
    `You have a hard budget of ${toolCallBudget} tool calls. Inspect the highest-value sources first and stop exploring once you can answer reliably.`,
    "Return a concise final report containing the outcome, evidence, verification performed, and any remaining risk. Do not dump exhaustive file listings or repeat source text.",
    ...(concurrentParentTask ? [`The Smart parent is concurrently handling this separate work; do not duplicate it:\n${concurrentParentTask}`] : []),
    `\nTask:\n${task}${paths}`,
  ].join("\n");
}
