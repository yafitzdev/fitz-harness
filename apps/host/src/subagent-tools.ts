import { toolResult, type ToolDefinition } from "@fitz/agent-pi";
import type { AgentRunRequest, SubagentRole, ToolAccessMode } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";
import { Type } from "typebox";
import type { AgentRunCoordinator } from "./agent-runs.js";

export const SUBAGENT_TOOL = "subagent";

export const SUBAGENT_ROUTES: Readonly<Record<SubagentRole, "fast">> = {
  worker: "fast",
  reviewer: "fast",
  researcher: "fast",
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
  role: Type.Union([
    Type.Literal("worker"),
    Type.Literal("reviewer"),
    Type.Literal("researcher"),
  ], { description: "Focused role for the delegated task" }),
  task: Type.String({ minLength: 1, maxLength: 12_000, description: "A self-contained task with the expected result and important constraints" }),
  relevant_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Workspace paths the subagent should inspect first" })),
});

export interface SubagentToolsOptions {
  agentRuns: AgentRunCoordinator;
  store: SqliteStore;
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
 * and share the consumer's explicitly configured Fast cloud role. */
export function createSubagentTool(options: SubagentToolsOptions, context: { runId?: string }): ToolDefinition {
  let researcherCalls = 0;
  return {
    name: SUBAGENT_TOOL,
    label: "Delegate task",
    description:
      "Delegate one focused task to an isolated Fitz subagent and wait for its report. Independent calls use your configured Fast cloud model concurrently. Use worker for implementation, reviewer for independent read-only review, and researcher for read-only repository or documentation research. A normal parent turn may call researcher only once; multiple researchers require the user's explicit request for an exhaustive investigation. Subagents cannot delegate again.",
    promptSnippet: "Delegate focused implementation, review, or research to an isolated subagent",
    promptGuidelines: [
      "Give the subagent a self-contained task, expected output, constraints, and the most relevant paths.",
      "Use worker for implementation, reviewer for independent review, and researcher for investigation or source gathering.",
      "When two or more delegated tasks are independent, issue their subagent calls together in the same turn. Fast cloud calls execute independently.",
      "For broad project familiarization, use ONE researcher with a consolidated scope unless the user explicitly requests exhaustive parallel research; in that case split disjoint scopes and issue the researcher calls together.",
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
      const parentRequest = options.store.getAgentRunRequest(parentRunId);
      if (role === "researcher") {
        if (researcherCalls >= 1 && !explicitlyRequestsExhaustiveResearch(parentRequest)) {
          throw new Error("This turn already used its researcher. Synthesize that report and use only targeted reads; multiple researchers require an explicit user request for exhaustive research.");
        }
        researcherCalls += 1;
      }
      const request: Omit<AgentRunRequest, "delegation" | "sessionId"> = {
        model: SUBAGENT_ROUTES[role],
        accessMode: SUBAGENT_ACCESS[role],
        maxTokens: SUBAGENT_MAX_TOKENS[role],
        messages: [{ role: "user", content: subagentPrompt(role, params.task, params.relevant_paths, SUBAGENT_TOOL_BUDGET[role]) }],
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

function subagentPrompt(role: SubagentRole, task: string, relevantPaths: string[] | undefined, toolCallBudget: number): string {
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
    `\nTask:\n${task}${paths}`,
  ].join("\n");
}

function explicitlyRequestsExhaustiveResearch(request: AgentRunRequest | undefined): boolean {
  const lastUserMessage = [...(request?.messages ?? [])].reverse().find((message) => message.role === "user");
  const text = typeof lastUserMessage?.content === "string"
    ? lastUserMessage.content
    : lastUserMessage?.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ") ?? "";
  return /\b(?:exhaustive|multiple researchers|multiple research subagents|several researchers|[2-9]\s+researchers)\b/i.test(text);
}
