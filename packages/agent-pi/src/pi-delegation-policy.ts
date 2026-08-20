import type { AgentRunRequest } from "@fitz/protocol";

type SubagentRoute = "default" | "fast" | "smart";
type SubagentRouteBudget = Readonly<Record<SubagentRoute, number>>;

export interface DelegationToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/**
 * Per-run delegation state. It owns initial local/cloud fan-out enforcement, Smart
 * peer admission, and delegated-worker tool budgets so every Pi callback uses
 * the same decisions and counters.
 */
export class PiDelegationPolicy {
  readonly initialRoutes: readonly SubagentRoute[];
  readonly toolCallBudget: number | undefined;
  readonly #admittedInitialSubagents = new Map<string, SubagentRoute>();
  #admittedParentWork = false;
  #delegatedToolCalls = 0;
  #finalReportOnly = false;

  constructor(request: AgentRunRequest, budget: SubagentRouteBudget | undefined) {
    this.initialRoutes = requiredInitialSubagentRoutes(request, budget);
    this.toolCallBudget = request.delegation?.role.toolCallBudget;
  }

  get requiresInitialFanout(): boolean {
    return this.initialRoutes.length > 0;
  }

  get initialFanoutComplete(): boolean {
    return this.#admittedInitialSubagents.size >= this.initialRoutes.length;
  }

  get shouldSuppressModelOutput(): boolean {
    return this.requiresInitialFanout && !this.initialFanoutComplete;
  }

  remainingInitialRoutes(): SubagentRoute[] {
    const remaining = [...this.initialRoutes];
    for (const route of this.#admittedInitialSubagents.values()) {
      const index = remaining.indexOf(route);
      if (index >= 0) remaining.splice(index, 1);
    }
    return remaining;
  }

  /**
   * Returns a blocking reason, or admits the call and consumes one delegated
   * tool-budget slot. Initial subagent calls are recorded by tool-call id so
   * repeated policy callbacks cannot satisfy the fan-out twice.
   */
  admissionReason(toolCall: DelegationToolCall): string | undefined {
    if (this.#finalReportOnly) return "Worker research is finished. Return the final report now; no more tools are available.";
    const fanoutReason = this.#initialFanoutReason(toolCall);
    if (fanoutReason) return fanoutReason;
    const smartPeerReason = this.#smartPeerReason(toolCall);
    if (smartPeerReason) return smartPeerReason;
    if (this.toolCallBudget === undefined) return undefined;
    if (this.#delegatedToolCalls >= this.toolCallBudget) return subagentBudgetReason(this.toolCallBudget);
    this.#delegatedToolCalls += 1;
    return undefined;
  }

  recordAllowedTool(toolCall: DelegationToolCall): void {
    if (toolCall.toolName !== "subagent" && toolCall.toolName !== "agent_plan") this.#admittedParentWork = true;
  }

  /** Permanently closes a delegated worker's tool phase. The runtime enters
   * this state before a recovery completion, so producing a terminal report is
   * mechanically enforced instead of merely requested in prose. */
  beginFinalReport(): string {
    this.#finalReportOnly = true;
    return "The tool phase is closed. Return the concise final report now without calling tools.";
  }

  initialPromptInstruction(): string | undefined {
    if (!this.requiresInitialFanout) return undefined;
    return `After creating the durable execution plan, launch ${formatSubagentRoutes(this.initialRoutes)} for distinct worker-eligible plan items, then begin independent parent tool work. The parent owns the overarching analysis and final synthesis.`;
  }

  retryPrompt(): string {
    return `Launch the still-required ${formatSubagentRoutes(this.remainingInitialRoutes())} now with the subagent tool. Do not answer in prose.`;
  }

  missingFanoutError(): Error {
    return new Error(`The selected main model did not launch the required ${formatSubagentRoutes(this.remainingInitialRoutes())}.`);
  }

  #initialFanoutReason(toolCall: DelegationToolCall): string | undefined {
    if (!this.requiresInitialFanout || this.initialFanoutComplete) return undefined;
    if (toolCall.toolName === "agent_plan") return undefined;
    if (toolCall.toolName === "subagent") {
      if (this.#admittedInitialSubagents.has(toolCall.toolCallId)) return undefined;
      const route = subagentRouteFromInput(toolCall.input);
      const remaining = this.remainingInitialRoutes();
      if (!route || !remaining.includes(route)) {
        return `This delegation does not match the required worker budget. Launch ${formatSubagentRoutes(remaining)} before using parent tools.`;
      }
      this.#admittedInitialSubagents.set(toolCall.toolCallId, route);
      return undefined;
    }
    return `Delegation must happen first. Launch ${formatSubagentRoutes(this.remainingInitialRoutes())} before using parent tools; do not research the project in the parent first.`;
  }

  #smartPeerReason(toolCall: DelegationToolCall): string | undefined {
    if (toolCall.toolName !== "subagent" || subagentRouteFromInput(toolCall.input) !== "smart" || this.#admittedParentWork) return undefined;
    return "A Smart child is a concurrent peer, not a delegated researcher. Start a substantive parent tool task first, then include the Smart subagent call in that same response so both run concurrently.";
  }
}

export function delegatedCompaction(contextWindow: number, maxTokens: number): { reserveTokens: number; keepRecentTokens: number } {
  const outputHeadroom = Math.max(2_048, Math.min(maxTokens, Math.floor(contextWindow / 4)));
  const estimatorSafety = Math.min(16_384, Math.floor(contextWindow / 2));
  return {
    reserveTokens: Math.min(Math.floor(contextWindow / 2), Math.max(8_192, outputHeadroom, estimatorSafety)),
    keepRecentTokens: Math.max(2_048, Math.min(4_096, Math.floor(contextWindow / 8))),
  };
}

export function requiredInitialSubagentRoutes(request: AgentRunRequest, budget: SubagentRouteBudget | undefined): SubagentRoute[] {
  if (request.delegation || !budget) return [];
  const lastUserText = [...request.messages].reverse().find((message) => message.role === "user");
  if (!lastUserText) return [];
  const text = extractTextFromContent(lastUserText.content).toLowerCase();
  const defaultCapacity = Array.from({ length: Math.max(0, budget.default) }, () => "default" as const);
  const fastCapacity = Array.from({ length: Math.max(0, budget.fast) }, () => "fast" as const);
  const smartCapacity = Array.from({ length: Math.max(0, budget.smart) }, () => "smart" as const);
  if (defaultCapacity.length + fastCapacity.length + smartCapacity.length === 0) return [];
  // Task semantics belong to the orchestrator and its durable plan. The runtime
  // does not classify request subjects. It forces initial fan-out only when the
  // user explicitly asks for workers, preserving that direct user instruction.
  const explicitCount = explicitlyRequestedSubagentCount(text);
  if (explicitCount === 0) return [];
  if (defaultCapacity.length) {
    const explicitlyCloud = /\b(?:fast|smart)\s+(?:\w+\s+)?subagents?\b/.test(text);
    return explicitlyCloud ? [] : defaultCapacity.slice(0, explicitCount);
  }
  const explicitlyFast = /\bfast\s+(?:\w+\s+)?subagents?\b/.test(text);
  const explicitlySmart = /\bsmart\s+(?:\w+\s+)?subagents?\b/.test(text);
  if (explicitlySmart && !explicitlyFast) return [];
  return fastCapacity.slice(0, explicitCount);
}

function explicitlyRequestedSubagentCount(text: string): number {
  if (!/\b(?:launch|spawn|run|use|delegate(?:\s+to)?)\b/.test(text)) return 0;
  if (!/\b(?:subagents?|workers?|researchers?|reviewers?|researcher\s+subagents?|worker\s+subagents?|reviewer\s+subagents?)\b/.test(text)) return 0;
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  };
  const count = text.match(/\b(?:launch|spawn|run|use|delegate(?:\s+to)?)\s+(?:up\s+to\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)\b/)?.[1];
  if (!count) return 1;
  const parsed = /^\d+$/.test(count) ? Number(count) : words[count];
  return Math.max(1, Math.min(16, parsed ?? 1));
}

function subagentRouteFromInput(input: unknown): SubagentRoute | undefined {
  if (!input || typeof input !== "object") return undefined;
  const route = (input as Record<string, unknown>).route;
  return route === "default" || route === "fast" || route === "smart" ? route : undefined;
}

function formatSubagentRoutes(routes: readonly SubagentRoute[]): string {
  const local = routes.filter((route) => route === "default").length;
  const fast = routes.filter((route) => route === "fast").length;
  const smart = routes.filter((route) => route === "smart").length;
  const parts = [
    ...(smart ? [`${smart} Smart subagent${smart === 1 ? "" : "s"}`] : []),
    ...(fast ? [`${fast} Fast subagent${fast === 1 ? "" : "s"}`] : []),
    ...(local ? [`${local} local worker${local === 1 ? "" : "s"}`] : []),
  ];
  return parts.join(" and ") || "the remaining subagents";
}

function subagentBudgetReason(toolCallBudget: number): string {
  return `The subagent's ${toolCallBudget}-tool budget is exhausted. Stop using tools and return the concise final report now.`;
}

function extractTextFromContent(content: AgentRunRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ");
}
