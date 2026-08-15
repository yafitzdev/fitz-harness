import type { SubagentRouteBudget } from "@fitz/agent-pi";
import type { AgentEffort } from "@fitz/protocol";

/** Cost-aware context ceilings for metered cloud inference. `normal` is the
 * protocol's stable value for the user-facing Medium tier. Self-hosted recipes
 * never use these limits; their configured topology is authoritative. */
export const AGENT_EFFORT_CONTEXT_TOKENS: Readonly<Record<AgentEffort, number>> = {
  light: 12_000,
  normal: 32_000,
  high: 64_000,
};

/** Engine-independent circuit breaker for root-agent exploration. These do not
 * change context size; they bound sequential tool-loop work at each effort. */
export const ROOT_AGENT_TOOL_CALL_BUDGETS: Readonly<Record<AgentEffort, number>> = {
  light: 16,
  normal: 24,
  high: 48,
};

export const CLOUD_SUBAGENT_EFFORT_BUDGETS: Readonly<Record<AgentEffort, Readonly<Record<"fast" | "smart", SubagentRouteBudget>>>> = {
  light: {
    fast: { default: 0, fast: 0, smart: 0 },
    smart: { default: 0, fast: 0, smart: 0 },
  },
  normal: {
    fast: { default: 0, fast: 3, smart: 0 },
    smart: { default: 0, fast: 3, smart: 0 },
  },
  high: {
    fast: { default: 0, fast: 6, smart: 0 },
    smart: { default: 0, fast: 6, smart: 2 },
  },
};

export function effortContextTokens(effort: AgentEffort | undefined): number {
  return AGENT_EFFORT_CONTEXT_TOKENS[effort ?? "normal"];
}

export function localWorkerBudget(effort: AgentEffort, configuredWorkers: number): number {
  if (effort === "light") return 0;
  if (effort === "normal") return Math.min(1, configuredWorkers);
  return configuredWorkers;
}

export function rootAgentToolCallBudget(effort: AgentEffort | undefined): number {
  return ROOT_AGENT_TOOL_CALL_BUDGETS[effort ?? "normal"];
}
