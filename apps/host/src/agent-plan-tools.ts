import { toolResult, type PiRunPlanPolicy, type ToolDefinition } from "@fitz/agent-pi";
import type { AgentPlanItem, AgentRunPlan } from "@fitz/protocol";
import type { SqliteStore } from "@fitz/storage";
import { Type } from "typebox";

export const AGENT_PLAN_TOOL = "agent_plan";

export interface AgentPlanToolsOptions {
  store: SqliteStore;
  requiredWorkerRoutes?: Array<"default" | "fast" | "smart">;
}

const planItemInput = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" }),
  task: Type.String({ minLength: 1, maxLength: 4_000 }),
  dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 50 })),
  worker_eligible: Type.Optional(Type.Boolean()),
  required: Type.Optional(Type.Boolean()),
});

const parameters = Type.Object({
  action: Type.String({ enum: ["set", "update", "status", "ready"] }),
  items: Type.Optional(Type.Array(planItemInput, { minItems: 1, maxItems: 100 })),
  item_id: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  status: Type.Optional(Type.String({ enum: ["pending", "running", "completed"] })),
  result: Type.Optional(Type.String({ maxLength: 20_000 })),
  wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 30, description: "For status only: wait briefly for running workers after main work is exhausted" })),
});

/** The plan tool is the root agent's durable gameplan boundary. It owns plan
 * creation, main-task progress, worker reconciliation, and completion gating. */
export function createAgentPlanTool(options: AgentPlanToolsOptions, context: { runId?: string }): ToolDefinition<typeof parameters> {
  return {
    name: AGENT_PLAN_TOOL,
    label: "Update task plan",
    description: "Create, revise, and inspect the prerequisite work plan for this run. Final synthesis is implicit: completing the last required work item automatically opens the final-answer phase; action=ready remains an idempotent compatibility transition.",
    promptSnippet: "Maintain the run's durable task plan and completion state",
    promptGuidelines: [
      "Your first tool call must set a concrete task plan. This is the execution gameplan, not optional narration.",
      "Keep blockers and critical-path tasks owned by the main agent. Mark only independent, bounded speed-up tasks as worker_eligible.",
      "Update main-owned items as you start and complete them. Worker-owned items are updated automatically.",
      "Do not add a synthesis, final-answer, or respond-to-user item; final synthesis is an implicit runtime-owned phase.",
      "When the last required item completes, write the final answer in the next assistant response. A failed worker is reassigned to the main agent and must be completed there.",
    ],
    parameters,
    execute: async (_toolCallId, params) => {
      const runId = context.runId;
      if (!runId) throw new Error("Agent planning requires a durable run");
      if (!options.store.getAgentRun(runId)) throw new Error(`Agent run ${runId} was not found`);
      if (params.action === "set") {
        if (!params.items?.length) return result("A plan requires at least one item.", undefined, true);
        try {
          const plan = setPlan(options.store, runId, params.items, options.requiredWorkerRoutes);
          return result(formatPlan(plan), plan);
        } catch (error) {
          return result(error instanceof Error ? error.message : String(error), undefined, true);
        }
      }
      if (params.action === "status") {
        const deadline = Date.now() + Math.max(0, Math.min(30, params.wait_seconds ?? 0)) * 1_000;
        let plan = reconcileAgentPlan(options.store, runId);
        while (plan?.items.some((item) => item.owner === "worker" && item.status === "running") && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
          plan = reconcileAgentPlan(options.store, runId);
        }
        return plan ? result(formatPlan(plan), plan) : result("No plan exists. Set the task plan first.", undefined, true);
      }
      if (params.action === "update") {
        if (!params.item_id || !params.status) return result("update requires item_id and status.", undefined, true);
        try {
          const plan = updateMainItem(options.store, runId, params.item_id, params.status as "pending" | "running" | "completed", params.result);
          return result(formatPlan(plan), plan);
        } catch (error) {
          return result(error instanceof Error ? error.message : String(error), undefined, true);
        }
      }
      try {
        const plan = readyPlan(options.store, runId);
        return result(`${formatPlan(plan)}\nAll prerequisite work is complete. Now provide one complete, standalone final answer. Do not refer to an earlier draft or call another tool.`, plan, plan.status !== "ready_for_answer" && plan.status !== "completed");
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), undefined, true);
      }
    },
  };
}

export function planPromptInstruction(): string {
  return [
    "If the request can be answered directly without tools, answer normally. Before other tool work, create the durable prerequisite plan with agent_plan action=set.",
    "Keep critical-path work with the main agent and mark only independent, bounded tasks as worker_eligible. Do not add final synthesis as a plan item.",
    "Update main-owned items as work advances, continue independent parent work after delegation, and use status only after ready parent work is exhausted.",
    "Completing the last required item automatically opens the final-answer phase; then provide the standalone final answer. Failed worker items return to the main agent.",
  ].join(" ");
}

/** Makes durable planning conditional on actual tool work. A direct answer has
 * no fake plan; the first attempted tool call flips the policy to mandatory and
 * is held behind the normal plan-first admission gate. */
export function createAgentRunPlanPolicy(store: SqliteStore, runId: string): PiRunPlanPolicy {
  let required = Boolean(store.getAgentRunPlan(runId));
  return {
    initialInstruction: planPromptInstruction(),
    required: () => required || Boolean(store.getAgentRunPlan(runId)),
    admissionReason: (toolCall) => {
      if (!store.getAgentRunPlan(runId) && toolCall.toolName !== AGENT_PLAN_TOOL) required = true;
      if (toolCall.toolName === AGENT_PLAN_TOOL) required = true;
      return planAdmissionReason(store, runId, toolCall);
    },
    completionIssue: () => required || store.getAgentRunPlan(runId) ? planCompletionIssue(store, runId) : undefined,
    phase: () => store.getAgentRunPlan(runId)?.status ?? "missing",
    completeAfterAnswer: () => undefined,
  };
}

/** Runtime admission for the durable plan protocol. This is deliberately
 * independent of model wording: planning, parent progress, and waiting rules
 * remain true even when a provider ignores every prompt guideline. */
export function planAdmissionReason(
  store: SqliteStore,
  runId: string,
  toolCall: { toolName: string; input: unknown },
): string | undefined {
  const plan = store.getAgentRunPlan(runId);
  if (!plan && toolCall.toolName !== AGENT_PLAN_TOOL) {
    return "Create the durable execution plan with agent_plan before using any other tool.";
  }
  if (plan?.status === "ready_for_answer" || plan?.status === "completed") {
    if (toolCall.toolName === AGENT_PLAN_TOOL && isRecord(toolCall.input) && toolCall.input.action === "ready") return undefined;
    return "Prerequisite work is complete. Return one standalone final answer without starting new work.";
  }
  if (plan && toolCall.toolName !== AGENT_PLAN_TOOL
    && plan.items.filter((item) => item.required).every((item) => item.status === "completed")) {
    return "All required plan items are complete. Return one standalone final answer from the evidence already gathered.";
  }
  if (!plan || toolCall.toolName !== AGENT_PLAN_TOOL || !isRecord(toolCall.input)) return undefined;
  const waitsForWorkers = toolCall.input.action === "status"
    && typeof toolCall.input.wait_seconds === "number"
    && toolCall.input.wait_seconds > 0;
  if (!waitsForWorkers) return undefined;

  const readyMain = plan.items.filter((item) => item.required && item.owner === "main" && item.status !== "completed"
    && item.dependencies.every((dependency) => plan.items.find((candidate) => candidate.id === dependency)?.status === "completed"));
  if (readyMain.length) {
    return `The main agent still has ready work: ${readyMain.map((item) => item.id).join(", ")}. Complete that work before waiting for workers.`;
  }
  if (plan.items.some((item) => item.owner === "worker" && item.status === "running") && !hasParentToolAfterWorkerLaunch(store, runId)) {
    return "Workers are accelerators, not blockers. Perform substantive parent tool work after launching them before waiting for their results.";
  }
  return undefined;
}

/** Returns a deterministic reason the runtime must continue instead of ending. */
export function planCompletionIssue(store: SqliteStore, runId: string): string | undefined {
  const plan = reconcileAgentPlan(store, runId);
  if (!plan) return "No execution plan exists yet. Call agent_plan with action=set before answering the user.";
  if (plan.status === "ready_for_answer" || plan.status === "completed") return undefined;
  const missingWorkers = missingRequiredWorkers(store, plan);
  if (missingWorkers.length) return `Required worker launches are not yet durably assigned: ${missingWorkers.join(", ")}. Ensure the plan contains enough ready worker-eligible items, launch those workers, and continue substantive main-agent work.`;
  const running = plan.items.filter((item) => item.status === "running").map((item) => item.id);
  const pending = plan.items.filter((item) => item.required && item.status !== "completed").map((item) => item.id);
  if (!pending.length) return "All prerequisite work items are complete. Return one standalone final answer; final synthesis is implicit.";
  return `The execution plan is not complete. Required items still open: ${pending.join(", ")}.${running.length ? ` Workers/main currently running: ${running.join(", ")}.` : ""} Continue the main-agent work and collect worker status when useful.`;
}

export function reconcileAgentPlan(store: SqliteStore, runId: string): AgentRunPlan | undefined {
  return mutatePlan(store, runId, (plan) => {
    let changed = false;
    const items = plan.items.map((item) => {
      if (item.owner !== "worker" || item.status !== "running" || !item.workerRunId) return item;
      const worker = store.getAgentRun(item.workerRunId);
      if (!worker || worker.status === "queued" || worker.status === "running") return item;
      changed = true;
      if (worker.status === "completed") {
        const text = store.agentEventsAfter(worker.id, 0)
          .filter((event) => event.type === "assistant.delta")
          .map((event) => String(event.data.text ?? ""))
          .join("");
        return { ...withoutError(item), status: "completed" as const, result: text || "Worker completed without a written report." };
      }
      return {
        ...item,
        owner: "main" as const,
        status: "pending" as const,
        error: worker.error || `Worker ${worker.status}; reassigned to the main agent.`,
      };
    });
    return changed ? { ...plan, items } : undefined;
  });
}

export function assignPlanItemToWorker(store: SqliteStore, runId: string, itemId: string, workerRunId: string): AgentRunPlan {
  const updated = mutatePlan(store, runId, (plan) => {
    const item = plan.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Plan item ${itemId} was not found`);
    if (!item.workerEligible) throw new Error(`Plan item ${itemId} is not worker-eligible`);
    if (item.status !== "pending") throw new Error(`Plan item ${itemId} is ${item.status}, not pending`);
    const blockers = item.dependencies.filter((dependency) => plan.items.find((candidate) => candidate.id === dependency)?.status !== "completed");
    if (blockers.length) throw new Error(`Plan item ${itemId} is blocked by ${blockers.join(", ")}`);
    const items = plan.items.map((candidate) => candidate.id === itemId
      ? { ...withoutError(candidate), owner: "worker" as const, status: "running" as const, attempts: candidate.attempts + 1, workerRunId }
      : candidate);
    if (!items.some((candidate) => candidate.required && candidate.owner === "main")) {
      throw new Error("Cannot delegate every required plan item. Keep at least one required item owned by the main agent.");
    }
    return { ...plan, items };
  });
  if (!updated) throw new Error("Plan disappeared while assigning worker");
  return updated;
}

function setPlan(store: SqliteStore, runId: string, inputs: Array<{ id: string; task: string; dependencies?: string[]; worker_eligible?: boolean; required?: boolean }>, requiredWorkerRoutes: Array<"default" | "fast" | "smart"> = []): AgentRunPlan {
  const ids = inputs.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("Plan item ids must be unique");
  const known = new Set(ids);
  for (const item of inputs) {
    if (isImplicitFinalizationItem(item)) throw new Error(`Plan item ${item.id} duplicates the implicit final-answer phase. Remove it and keep only prerequisite work.`);
    for (const dependency of item.dependencies ?? []) if (!known.has(dependency)) throw new Error(`Plan item ${item.id} depends on unknown item ${dependency}`);
    if ((item.dependencies ?? []).includes(item.id)) throw new Error(`Plan item ${item.id} cannot depend on itself`);
  }
  assertAcyclic(inputs.map((item) => ({ id: item.id, dependencies: item.dependencies ?? [] })));
  if (requiredWorkerRoutes.length) {
    const requiredItems = inputs.filter((item) => item.required !== false);
    const workerItems = requiredItems.filter((item) => item.worker_eligible);
    if (workerItems.length < requiredWorkerRoutes.length) {
      throw new Error(`The plan needs at least ${requiredWorkerRoutes.length} required worker-eligible items for the required worker fan-out.`);
    }
    if (!requiredItems.some((item) => !item.worker_eligible)) {
      throw new Error("The plan must retain at least one required main-only item so the parent has independent work while workers run.");
    }
  }
  const existing = store.getAgentRunPlan(runId);
  if (existing && existing.status !== "active") throw new Error("A plan that is ready for its answer cannot be revised");
  const runningRemoved = existing?.items.filter((item) => item.status === "running" && !known.has(item.id)) ?? [];
  if (runningRemoved.length) throw new Error(`Cannot remove running plan items: ${runningRemoved.map((item) => item.id).join(", ")}`);
  const now = new Date().toISOString();
  const items: AgentPlanItem[] = inputs.map((input) => {
    const prior = existing?.items.find((item) => item.id === input.id);
    return {
      id: input.id,
      task: input.task.trim(),
      dependencies: [...new Set(input.dependencies ?? [])],
      owner: prior?.owner ?? "main",
      workerEligible: input.worker_eligible ?? false,
      required: input.required ?? true,
      status: prior?.status ?? "pending",
      attempts: prior?.attempts ?? 0,
      ...(prior?.workerRunId ? { workerRunId: prior.workerRunId } : {}),
      ...(prior?.result ? { result: prior.result } : {}),
      ...(prior?.error ? { error: prior.error } : {}),
    };
  });
  const plan = promotePlanIfComplete(store, { runId, revision: (existing?.revision ?? 0) + 1, status: "active", items, ...(requiredWorkerRoutes.length ? { requiredWorkerRoutes: [...requiredWorkerRoutes] } : {}), createdAt: existing?.createdAt ?? now, updatedAt: now } satisfies AgentRunPlan);
  if (!store.saveAgentRunPlan(plan, existing?.revision)) throw new Error("Plan changed concurrently; inspect status and retry");
  return plan;
}

function updateMainItem(store: SqliteStore, runId: string, itemId: string, status: "pending" | "running" | "completed", itemResult?: string): AgentRunPlan {
  const updated = mutatePlan(store, runId, (plan) => {
    if (plan.status !== "active") throw new Error("A plan that is ready for its answer cannot be changed");
    const item = plan.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Plan item ${itemId} was not found`);
    if (item.owner === "worker" && item.status === "running") throw new Error(`Plan item ${itemId} is owned by a running worker`);
    if (status === "running") {
      const blockers = item.dependencies.filter((dependency) => plan.items.find((candidate) => candidate.id === dependency)?.status !== "completed");
      if (blockers.length) throw new Error(`Plan item ${itemId} is blocked by ${blockers.join(", ")}`);
    }
    return { ...plan, items: plan.items.map((candidate) => {
      if (candidate.id !== itemId) return candidate;
      const base = status === "completed" ? withoutError(candidate) : candidate;
      return {
        ...base,
        owner: "main",
        status,
        ...(status === "completed" ? { result: itemResult?.trim() || candidate.result || "Completed by main agent." } : {}),
      };
    }) };
  });
  if (!updated) throw new Error("No plan exists. Set the task plan first");
  return updated;
}

function readyPlan(store: SqliteStore, runId: string): AgentRunPlan {
  reconcileAgentPlan(store, runId);
  const updated = mutatePlan(store, runId, (plan) => {
    if (plan.status === "ready_for_answer" || plan.status === "completed") return undefined;
    const missingWorkers = missingRequiredWorkers(store, plan);
    if (missingWorkers.length) throw new Error(`Required workers were not launched: ${missingWorkers.join(", ")}`);
    const open = plan.items.filter((item) => item.required && item.status !== "completed");
    if (open.length) throw new Error(`Plan is not complete. Required items still open: ${open.map((item) => `${item.id} (${item.owner}/${item.status})`).join(", ")}`);
    const { completedAt: _completedAt, ...active } = plan;
    return { ...active, status: "ready_for_answer" };
  });
  if (!updated) throw new Error("No plan exists. Set the task plan first");
  return updated;
}

/** Runtime-only transition: a model cannot complete a plan before its answer exists. */
export function completePlanAfterAnswer(store: SqliteStore, runId: string): AgentRunPlan {
  const updated = mutatePlan(store, runId, (plan) => {
    if (plan.status === "completed") return undefined;
    if (plan.status !== "ready_for_answer") throw new Error("The plan is not ready for a final answer");
    const now = new Date().toISOString();
    return { ...plan, status: "completed", completedAt: now };
  });
  if (!updated) throw new Error("No plan exists. Set the task plan first");
  return updated;
}

function missingRequiredWorkers(store: SqliteStore, plan: AgentRunPlan): string[] {
  const remaining = [...(plan.requiredWorkerRoutes ?? [])];
  for (const item of plan.items) {
    if (!item.workerRunId) continue;
    const route = store.getAgentRunRequest(item.workerRunId)?.model;
    const index = remaining.indexOf(route as "default" | "fast" | "smart");
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

function mutatePlan(store: SqliteStore, runId: string, mutate: (plan: AgentRunPlan) => AgentRunPlan | undefined): AgentRunPlan | undefined {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = store.getAgentRunPlan(runId);
    if (!current) return undefined;
    const candidate = mutate(current) ?? current;
    const changed = promotePlanIfComplete(store, candidate);
    if (changed === current) return current;
    const next = { ...changed, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    if (store.saveAgentRunPlan(next, current.revision)) return next;
  }
  throw new Error("Plan changed concurrently too many times; inspect status and retry");
}

/** Keeps the durable phase derived from durable prerequisite state. A model can
 * still request `ready` explicitly, but it is never responsible for repairing
 * an active/completed mismatch before Fitz will accept its answer. */
function promotePlanIfComplete(store: SqliteStore, plan: AgentRunPlan): AgentRunPlan {
  if (plan.status !== "active") return plan;
  if (plan.items.some((item) => item.required && item.status !== "completed")) return plan;
  if (missingRequiredWorkers(store, plan).length) return plan;
  const { completedAt: _completedAt, ...active } = plan;
  return { ...active, status: "ready_for_answer" };
}

function assertAcyclic(items: Array<{ id: string; dependencies: string[] }>): void {
  const dependencies = new Map(items.map((item) => [item.id, item.dependencies]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Plan dependencies contain a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const item of items) visit(item.id);
}

function formatPlan(plan: AgentRunPlan): string {
  const lines = plan.items.map((item) => `- ${item.id}: ${item.status} · ${item.owner}${item.workerEligible ? " · worker-eligible" : ""}${item.dependencies.length ? ` · after ${item.dependencies.join(", ")}` : ""} — ${item.task}${item.error ? ` (${item.error})` : ""}`);
  // Pi sends content to the model; details.plan is only structured UI data.
  // A completed flag without the report forces the parent to repeat the work.
  const reports = plan.items.filter((item) => item.workerRunId && item.status === "completed" && item.result)
    .map((item) => `Worker report for ${item.id}:\n${item.result}`);
  return [`Plan ${plan.status} (revision ${plan.revision})\n${lines.join("\n")}`, ...reports].join("\n\n");
}

function isImplicitFinalizationItem(item: { id: string; task: string }): boolean {
  if (/^(?:final|final[-_]?answer|answer|response|synthesis|synthesize)$/i.test(item.id.trim())) return true;
  return /\b(?:synthesi[sz]e findings into (?:a |the )?(?:final )?(?:answer|response)|write (?:a |the )?final answer|deliver (?:a |the )?(?:answer|response)|respond to the user)\b/i.test(item.task);
}

function result(text: string, plan?: AgentRunPlan, isError = false) {
  return toolResult(text, { status: isError ? "rejected" : plan?.status ?? "missing", ...(plan ? { plan } : {}) });
}

function withoutError(item: AgentPlanItem): Omit<AgentPlanItem, "error"> {
  const { error: _error, ...rest } = item;
  return rest;
}

function hasParentToolAfterWorkerLaunch(store: SqliteStore, runId: string): boolean {
  const events = store.agentEventsAfter(runId, 0);
  const firstWorker = events.find((event) => event.type === "tool.started" && event.data.toolName === "subagent");
  if (!firstWorker) return true;
  return events.some((event) => event.sequence > firstWorker.sequence && event.type === "tool.started"
    && event.data.toolName !== "subagent" && event.data.toolName !== AGENT_PLAN_TOOL);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
