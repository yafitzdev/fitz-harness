import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun, AgentRuntimeRunOptions } from "@fitz/agent-core";
import type {
  AgentRunRequest,
  ChatMessage,
  SessionQueryMessage,
  SessionQueryRequest,
  SessionQuerySection,
  SessionQuerySnapshot,
  SessionQueryService,
  ToolAccessMode,
} from "@fitz/protocol";
import type { Message, Model } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
export type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { LSP_TOOL_NAME } from "./lsp-tool.js";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PiDelegationPolicy,
  delegatedCompaction,
} from "./pi-delegation-policy.js";
import { PiTurnOutputState, type PiInternalPromptPurpose } from "./pi-turn-output-state.js";
import { serializeWorkspaceMutationTools, type ToolLeaseAcquirer, type ToolLeaseRelease } from "./workspace-mutation-leases.js";
import {
  buildFitzSystemPrompt,
  constrainSystemPrompt,
  FITZ_SYSTEM_PROMPT_SEED,
  runtimeControlPrompt,
  type PromptProvenance,
} from "./prompts.js";

type PiEvent =
  | { type: "message_start"; message: { role?: string; content?: unknown } }
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string; content?: string } }
  | { type: "message_end"; message: { role?: string; stopReason?: string; errorMessage?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };
/** Pi thinking levels. Maps to the SDK's `ThinkingLevel`; kept local so the runtime boundary stays SDK-free. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingFormat = "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling" | "ninfer";
export interface PiImageContent { type: "image"; data: string; mimeType: string }
export interface PiSession {
  subscribe(listener: (event: PiEvent) => void): () => void;
  prompt(text: string, images?: PiImageContent[]): Promise<void>;
  /** Run a continuation whose instruction is injected into the trusted system
   * prompt for that request instead of impersonating a system role in user text. */
  promptControl?(purpose: string, instruction: string): Promise<void>;
  steer(text: string): Promise<void>;
  promptProvenance?: PromptProvenance;
  /** Remove a draft that Fitz deliberately withheld from both of Pi's active histories. */
  discardLastAssistantDraft?(): boolean;
  /** Strip provisional text from an assistant message while retaining its tool calls. */
  withholdLastAssistantText?(toolCallId: string): boolean;
  abort(): Promise<void>;
  dispose(): void;
}
type PiWorkContext = AgentRuntimeRunOptions;
const MAX_STALLED_PLAN_CONTINUATIONS = 3;
export interface PiToolCall { toolCallId: string; toolName: string; input: unknown }
export interface PiToolApprovalResult { allowed: boolean; reason?: string }
export interface ToolApprovalHandle { approvalId: string; decision: Promise<"approved" | "denied"> }
export type ToolApprovalRequester = (request: PiToolCall & { sessionId: string }, signal: AbortSignal) => ToolApprovalHandle;
/**
 * The mechanical outcome of evaluating one tool call. The host policy engine decides
 * allow/rewrite/block without a human; "ask" escalates to the approval gate.
 */
export type ToolEvaluation =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "rewrite"; input: Record<string, unknown> }
  | { action: "ask" };
/** Host-provided deterministic policy engine. Runs before the approval gate for every non-read-only tool call. */
export type ToolEvaluator = (request: PiToolCall & { sessionId?: string; cwd: string; runId?: string }, signal: AbortSignal) => Promise<ToolEvaluation>;
/** Redacts secrets from tool output before it reaches the model. Return undefined to leave output unchanged. */
export type ToolResultRedactor = (event: { toolName: string; content: unknown[] }) => unknown[] | undefined;
/** Outcome of moving paths to the agent trash. */
export interface TrashMoveResult { moved: number; entries: Array<{ originalPath: string; trashPath: string }> }
export type TrashToolHandler = (input: { paths: string[] }) => Promise<TrashMoveResult | { error: string }>;
/** Canonical query message/snapshot aliases kept for the Pi adapter boundary. */
export type PiSessionMessage = SessionQueryMessage;
export type PiSessionSnapshot = SessionQuerySnapshot;
export type PiSessionLookupSection = SessionQuerySection;
export type SubagentRoute = "default" | "fast" | "smart";
export type SubagentRouteBudget = Readonly<Record<SubagentRoute, number>>;
export interface PiRunPlanPolicy {
  initialInstruction: string;
  /** False while a run can still answer directly without tool work. */
  required?(): boolean;
  admissionReason(toolCall: PiToolCall): string | undefined;
  completionIssue(): string | undefined;
  phase(): "missing" | "active" | "ready_for_answer" | "completed";
  /**
   * Compatibility member for hosts and runtimes that overlap during a dev
   * reload. The current runtime deliberately does not call it: durable completion
   * belongs to the host after the final assistant transcript is persisted.
   */
  completeAfterAnswer?: () => void;
}
export type PiSessionFactory = (options: {
  cwd: string;
  tools?: readonly string[];
  /** Strict active-tool allowlist for deterministic command runs. */
  activeTools?: readonly string[];
  routeId: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  /** Modalities present in this run. Pi uses this to decide whether attached
   * images may be forwarded to the OpenAI-compatible endpoint. */
  input: Array<"text" | "image">;
  agentDir: string;
  llmRoot: string;
  thinkingLevel?: ThinkingLevel;
  thinkingFormat?: ThinkingFormat;
  /** Hard cap applied after secret redaction and before a tool result enters
   * model history. The marker tells the model to request a narrower slice. */
  maxToolResultChars?: number;
  /** Per-run compaction headroom. Delegated workers use a deliberately smaller
   * recent window so tool output cannot fill their shorter shared context. */
  compaction?: { reserveTokens: number; keepRecentTokens: number };
  approveTool: (request: PiToolCall) => Promise<PiToolApprovalResult>;
  /** Canonical session query boundary. */
  sessionQuery?: SessionQueryService;
  /** Deterministic policy evaluation. When present it runs before `approveTool` for every tool call. */
  evaluateTool?: (request: PiToolCall) => Promise<ToolEvaluation>;
  /** Acquire an exclusive lease immediately before an allowed mutating tool executes. */
  acquireToolLease?: (request: PiToolCall) => Promise<ToolLeaseRelease>;
  /** Post-execution redaction of tool results before the model sees them. */
  redactResult?: ToolResultRedactor;
  spillResult?: (request: Omit<ToolResultSpillRequest, "runId" | "sessionId">) => Promise<{ path: string }>;
  /** Extra tools registered per run (e.g. `fitz_trash`). */
  customTools?: ToolDefinition[];
  /** Trusted localhost-only correlation propagated to the Fitz completion gateway. */
  workContext?: PiWorkContext;
  /** Structured history that precedes the new user turn. System-role entries
   * become subordinate run instructions; other roles remain provider messages. */
  history?: ChatMessage[];
  requestInstructions?: string[];
  runInstructions?: string[];
}) => Promise<PiSession>;
export interface PiAgentRuntimeOptions {
  cwd?: string | ((request: AgentRunRequest) => string);
  tools?: readonly string[];
  baseUrl?: string;
  apiKey?: string;
  /** Model context window in tokens, or a per-request resolver (the request carries the resolved route id). */
  contextWindow?: number | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => number);
  thinkingLevel?: ThinkingLevel | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => ThinkingLevel);
  /** Provider wire format selected from the resolved recipe. Reasoning events
   * remain one engine-agnostic Fitz contract regardless of this transport. */
  thinkingFormat?: ThinkingFormat | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => ThinkingFormat | undefined);
  /** Maximum substantive root-agent tool calls. Planning and delegation calls
   * are exempt; delegated workers retain their versioned role budgets. */
  toolCallBudget?: number | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => number | undefined);
  createSession?: PiSessionFactory;
  requestToolApproval?: ToolApprovalRequester;
  agentDir?: string;
  llmRoot?: string;
  /** Canonical session query boundary for the read-only fitz_session tool. */
  sessionQuery?: SessionQueryService;
  /** Deterministic host policy engine; evaluated for every non-read-only tool call before any approval gate. */
  toolPolicy?: ToolEvaluator;
  /** Coordinates workspace-mutating tools across concurrent agent runs. */
  toolLease?: ToolLeaseAcquirer;
  /** Redacts secrets from tool results before the model reads them. */
  redactToolResult?: ToolResultRedactor;
  /** Persists an oversized, already-redacted tool result and returns the
   * stable path the model can use to inspect narrower ranges. */
  spillToolResult?: ToolResultSpiller;
  /** Extra tools to register for each run; called with the run's resolved working directory. */
  customTools?: (context: { cwd: string; runId?: string; request?: AgentRunRequest }) => ToolDefinition[];
  /** Route-specific child capacity for the selected parent route. Undefined
   * means this parent must not receive a delegation tool. */
  subagentBudget?: (request: AgentRunRequest, context?: AgentRuntimeRunOptions) => SubagentRouteBudget | undefined;
  /** Host-owned durable plan policy. It can gate tools before plan creation and
   * require another model turn until the plan reaches a valid terminal state. */
  runPlan?: (request: AgentRunRequest, context?: AgentRuntimeRunOptions) => PiRunPlanPolicy | undefined;
  /** Forward task correlation headers to the model endpoint. Enable only for Fitz's bundled localhost gateway. */
  forwardWorkContext?: boolean;
}

export interface ToolResultSpillRequest {
  runId?: string;
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  content: unknown[];
}
export type ToolResultSpiller = (request: ToolResultSpillRequest) => Promise<{ path: string }>;

const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
/** Opaque user-turn activation for a trusted per-request runtime instruction.
 * It deliberately carries no natural-language instruction for the model to
 * parrot or reinterpret; the actual control text lives in the system prompt. */
export const FITZ_RUNTIME_CONTROL_ACTIVATION = "<fitz_runtime_control activation=\"system-prompt\" />";
/** Read-only tool that reads a past conversation from the Fitz session store. */
export const SESSION_LOOKUP_TOOL = "fitz_session";
/** Explicit trash tool: the agent can offer to move files to the run trash instead of deleting. */
export const TRASH_TOOL = "fitz_trash";
/**
 * Media-generation tools (§5.9): Ask-first in every access mode — generation is paid
 * work (KD-7), so these never auto-allow even in full mode without a human gate.
 * The host registers the tool definitions via `customTools`; this set is what the
 * runtime and policy engine use to treat them as money-spending calls.
 */
export const MEDIA_TOOLS = new Set(["generate_image", "generate_video", "generate_audio"]);
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", SESSION_LOOKUP_TOOL,
  // Durable plan updates mutate host bookkeeping, not the user's workspace.
  // They must remain available in Read only mode or every planned chat loops
  // forever trying to create the mandatory plan with a blocked tool.
  "agent_plan",
  // Fitz's bundled research extension tools only fetch public content and are
  // safe in researcher/reviewer read-only child sessions.
  LSP_TOOL_NAME, "web_search", "fetch_content", "get_search_content",
]);

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly #cwd: string | ((request: AgentRunRequest) => string);
  readonly #tools: readonly string[] | undefined;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #contextWindow: number | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => number);
  readonly #thinkingLevel: ThinkingLevel | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => ThinkingLevel);
  readonly #thinkingFormat: ThinkingFormat | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => ThinkingFormat | undefined) | undefined;
  readonly #toolCallBudget: number | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => number | undefined) | undefined;
  readonly #createSession: PiSessionFactory;
  readonly #requestToolApproval: ToolApprovalRequester | undefined;
  readonly #agentDir: string;
  readonly #llmRoot: string;
  readonly #sessionQuery: SessionQueryService | undefined;
  readonly #toolPolicy: ToolEvaluator | undefined;
  readonly #toolLease: ToolLeaseAcquirer | undefined;
  readonly #redactToolResult: ToolResultRedactor | undefined;
  readonly #spillToolResult: ToolResultSpiller | undefined;
  readonly #customTools: ((context: { cwd: string; runId?: string; request?: AgentRunRequest }) => ToolDefinition[]) | undefined;
  readonly #subagentBudget: ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => SubagentRouteBudget | undefined) | undefined;
  readonly #runPlan: ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => PiRunPlanPolicy | undefined) | undefined;
  readonly #forwardWorkContext: boolean;
  constructor(options: PiAgentRuntimeOptions = {}) {
    this.#cwd = options.cwd ?? process.cwd();
    this.#tools = options.tools ?? CODING_TOOLS;
    this.#baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787/v1").replace(/\/$/, "");
    this.#apiKey = options.apiKey ?? "fitz-local";
    this.#contextWindow = options.contextWindow ?? 100_000;
    this.#thinkingLevel = options.thinkingLevel ?? "off";
    this.#thinkingFormat = options.thinkingFormat;
    this.#toolCallBudget = options.toolCallBudget;
    this.#createSession = options.createSession ?? createSdkSession;
    this.#requestToolApproval = options.requestToolApproval;
    this.#agentDir = options.agentDir ?? process.env.FITZ_PI_AGENT_DIR ?? `${process.cwd()}/.fitz-pi`;
    this.#llmRoot = options.llmRoot ?? process.env.FITZ_LLM_ROOT ?? `${process.cwd()}/.llm`;
    this.#sessionQuery = options.sessionQuery;
    this.#toolPolicy = options.toolPolicy;
    this.#toolLease = options.toolLease;
    this.#redactToolResult = options.redactToolResult;
    this.#spillToolResult = options.spillToolResult;
    this.#customTools = options.customTools;
    this.#subagentBudget = options.subagentBudget;
    this.#runPlan = options.runPlan;
    this.#forwardWorkContext = options.forwardWorkContext ?? false;
  }
  run(request: AgentRunRequest, signal?: AbortSignal, options?: AgentRuntimeRunOptions): AgentRuntimeRun {
    const channel = new EventChannel(); let session: PiSession | undefined; const controller = new AbortController();
    let outputState: PiTurnOutputState | undefined;
    const parentSubagentBudget = request.delegation ? undefined : this.#subagentBudget?.(request, options);
    const delegation = new PiDelegationPolicy(request, parentSubagentBudget);
    const runPlan = request.delegation ? undefined : this.#runPlan?.(request, options);
    const cancel = () => { controller.abort(); void session?.abort(); }; if (signal) { if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true }); }
    const cwd = typeof this.#cwd === "function" ? this.#cwd(request) : this.#cwd;
    const contextWindow = typeof this.#contextWindow === "function" ? this.#contextWindow(request, options) : this.#contextWindow;
    const thinkingLevel = typeof this.#thinkingLevel === "function" ? this.#thinkingLevel(request, options) : this.#thinkingLevel;
    const thinkingFormat = typeof this.#thinkingFormat === "function" ? this.#thinkingFormat(request, options) : this.#thinkingFormat;
    const input: Array<"text" | "image"> = request.messages.some((message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"))
      ? ["text", "image"] : ["text"];
    const rootToolCallBudget = request.delegation ? undefined
      : typeof this.#toolCallBudget === "function" ? this.#toolCallBudget(request, options) : this.#toolCallBudget;
    const workTools = new WorkToolBudget(rootToolCallBudget);
    const customTools = this.#customTools?.({ cwd, ...(options?.runId ? { runId: options.runId } : {}), request }) ?? [];
    const hasSubagentTool = customTools.some((tool) => tool.name === "subagent");
    const promptInput = preparePromptInput(request.messages);
    const initialInstructions = [runPlan?.initialInstruction, delegation.initialPromptInstruction(), workTools.initialInstruction()].filter((value): value is string => Boolean(value));
    const sessionTask = (async () => {
      if (delegation.requiresInitialFanout && !hasSubagentTool) {
        throw new Error("Subagents are unavailable for the selected route. Select a local recipe with worker capacity or configure a Fast or Smart cloud route first.");
      }
      const created = await this.#createSession({
        cwd,
        ...(this.#tools ? { tools: this.#tools } : {}),
        routeId: request.model,
        baseUrl: this.#baseUrl,
        apiKey: this.#apiKey,
        contextWindow,
        maxTokens: request.maxTokens ?? 16_384,
        input,
        agentDir: this.#agentDir,
        llmRoot: this.#llmRoot,
        thinkingLevel,
        ...(thinkingFormat ? { thinkingFormat } : {}),
        maxToolResultChars: request.delegation ? 8_000 : 12_000,
        ...(this.#spillToolResult ? { spillResult: (spill) => this.#spillToolResult!({ ...spill, ...(options?.runId ? { runId: options.runId } : {}), ...(request.sessionId ? { sessionId: request.sessionId } : {}) }) } : {}),
        ...(request.delegation ? { compaction: delegatedCompaction(contextWindow, request.maxTokens ?? 16_384) } : {}),
        approveTool: (toolCall) => {
          const admissionReason = runPlan?.admissionReason(toolCall) ?? delegation.admissionReason(toolCall) ?? workTools.admissionReason(toolCall);
          if (admissionReason) return Promise.resolve({ allowed: false, reason: admissionReason });
          return this.#approveTool(request.accessMode ?? "full", toolCall, controller.signal, channel).then((decision) => {
            if (decision.allowed) { delegation.recordAllowedTool(toolCall); workTools.recordAllowedTool(toolCall); }
            return decision;
          });
        },
        ...(this.#sessionQuery ? { sessionQuery: scopedSessionQuery(this.#sessionQuery, options?.ownerUserId) } : {}),
        ...(this.#toolPolicy || this.#requestToolApproval
          ? { evaluateTool: async (toolCall) => {
              const admissionReason = runPlan?.admissionReason(toolCall) ?? delegation.admissionReason(toolCall) ?? workTools.admissionReason(toolCall);
              if (admissionReason) return { action: "block" as const, reason: admissionReason };
              const outcome = await this.#evaluateTool(cwd, request.accessMode ?? "full", request.sessionId, options?.runId, toolCall, controller.signal, channel);
              if (outcome.action === "allow" || outcome.action === "rewrite") { delegation.recordAllowedTool(toolCall); workTools.recordAllowedTool(toolCall); }
              return outcome;
            } }
          : {}),
        ...(this.#toolLease
          ? { acquireToolLease: (toolCall) => this.#toolLease!({ ...toolCall, cwd, ...(options?.runId ? { runId: options.runId } : {}) }, controller.signal) }
          : {}),
        ...(this.#redactToolResult ? { redactResult: this.#redactToolResult } : {}),
        ...(this.#customTools ? { customTools } : {}),
        ...(this.#forwardWorkContext && options ? { workContext: options } : {}),
        ...(promptInput.history.length ? { history: promptInput.history } : {}),
        ...(promptInput.requestInstructions.length ? { requestInstructions: promptInput.requestInstructions } : {}),
        ...(initialInstructions.length ? { runInstructions: initialInstructions } : {}),
      }); session = created; if (controller.signal.aborted) { await created.abort(); throw abortError(); }
      return created;
    })();
    void (async () => { try {
      const activeSession = await sessionTask;
      const output = new PiTurnOutputState({
        ...(runPlan ? { plan: runPlan } : {}),
        delegated: Boolean(request.delegation),
        emit: (event) => channel.push(event),
        discardAssistantDraft: () => { activeSession.discardLastAssistantDraft?.(); },
        withholdAssistantDraftForTool: (toolCallId) => { activeSession.withholdLastAssistantText?.(toolCallId); },
      });
      outputState = output;
      if (activeSession.promptProvenance) channel.push({ type: "prompt.provenance", ...activeSession.promptProvenance });
      const failActiveSession = (error: Error) => {
        if (!output.beginFailure()) return;
        controller.abort();
        channel.fail(error);
        queueMicrotask(() => void activeSession.abort().catch(() => undefined));
      };
      // The first user message_start is the initial prompt; any later one is a steering
      // message Pi has pulled off its steer queue, i.e. the point where the user's text is
      // inserted into the running conversation.
      let sawInitialUserMessage = false;
      let completedToolCalls = 0;
      const unsubscribe = activeSession.subscribe((event) => {
        const failure = piFailure(event);
        if (failure) { failActiveSession(failure); return; }
        if (event.type === "message_start" && event.message?.role === "user") {
          if (!sawInitialUserMessage) { sawInitialUserMessage = true; return; }
          if (output.consumeInternalUserEcho()) return;
          const text = extractTextFromMessageContent(event.message.content);
          if (text) channel.push({ type: "user.steer", text });
          return;
        }
        if (event.type === "tool_execution_start") output.beforeToolStart(event.toolCallId, isPlanReadyCall(event));
        const translated = translateEvent(event);
        if (translated) {
          const delegationOutput = translated.type === "assistant.delta" || translated.type === "reasoning.delta" || translated.type === "reasoning.completed";
          if (!(delegation.shouldSuppressModelOutput && delegationOutput)) {
            output.accept(translated);
          }
        }
        if (event.type === "tool_execution_end") completedToolCalls += 1;
        if (event.type === "tool_execution_end" && output.afterToolEnd(event.toolCallId)) {
          // Pi would ordinarily perform another completion after a tool result.
          // The held plan-ready answer is already the final response.
          queueMicrotask(() => void activeSession.abort());
        }
        if (isCompletedMediaHandoff(event)) {
          // Media generation is an asynchronous handoff. Letting Pi request one
          // more text completion here makes that request sit behind the several-
          // minute GPU media job and eventually fail as `terminated`. The media
          // tracker owns the rest of the lifecycle, so end this agent turn cleanly
          // as soon as the durable media job id has been returned.
          output.beginMediaHandoff();
          queueMicrotask(() => void activeSession.abort());
        }
      }); try {
        const prompt = async (text: string, images?: PiImageContent[]) => {
          try { await activeSession.prompt(text, images); }
          catch (error) { if (!output.shouldIgnorePromptError) throw error; }
          output.settleAfterPrompt();
        };
        const internalPrompt = async (purpose: PiInternalPromptPurpose, text: string) => {
          output.expectInternalPrompt(purpose);
          try {
            if (activeSession.promptControl) {
              try { await activeSession.promptControl(purpose, text); }
              catch (error) { if (!output.shouldIgnorePromptError) throw error; }
              output.settleAfterPrompt();
            } else {
              await prompt(runtimeControlPrompt(purpose, text));
            }
          }
          finally { output.completeInternalPrompt(purpose); }
        };
        await prompt(promptInput.text, promptInput.images);
        if (output.phase === "media-handoff") { channel.close(); return; }
        if (controller.signal.aborted) throw abortError();
        if (delegation.requiresInitialFanout && !delegation.initialFanoutComplete) {
          await internalPrompt("delegation", delegation.retryPrompt());
        }
        if (delegation.requiresInitialFanout && !delegation.initialFanoutComplete) throw delegation.missingFanoutError();
        if (request.delegation && !output.hasWorkerReportCandidate) {
          const reportPrompt = delegation.beginFinalReport();
          for (let attempt = 0; attempt < 2 && !output.hasWorkerReportCandidate; attempt += 1) {
            await internalPrompt("worker-report", reportPrompt);
            if (controller.signal.aborted) throw abortError();
          }
        }
        let planRetries = 0;
        let stalledPlanContinuations = 0;
        for (let issue = runPlan?.completionIssue(); issue;) {
          if (planRetries >= 24) throw new Error(`The main agent did not complete its execution plan after ${planRetries} continuation turns.`);
          planRetries += 1;
          const completedToolsBefore = completedToolCalls;
          await internalPrompt("plan", issue);
          if (controller.signal.aborted) throw abortError();
          const nextIssue = runPlan?.completionIssue();
          stalledPlanContinuations = nextIssue === issue && completedToolCalls === completedToolsBefore
            ? stalledPlanContinuations + 1
            : 0;
          if (stalledPlanContinuations >= MAX_STALLED_PLAN_CONTINUATIONS) {
            throw new Error(`The main agent made no execution-plan progress after ${stalledPlanContinuations} continuation turns. Last issue: ${issue}`);
          }
          issue = nextIssue;
        }
        for (let attempt = 0; runPlan?.phase() === "ready_for_answer" && !output.sawFinalAssistant && attempt < 3; attempt += 1) {
          await internalPrompt("plan", "Prerequisite work is complete. Provide exactly one complete, standalone final answer now. Do not call tools and do not refer to any earlier draft.");
          if (controller.signal.aborted) throw abortError();
        }
        const completionError = output.finish();
        if (completionError) throw completionError;
        channel.close();
      } finally { unsubscribe(); activeSession.dispose(); }
    } catch (error) { if (outputState?.phase === "media-handoff") channel.close(); else channel.fail(error); } })();
    const steer = async (text: string): Promise<void> => {
      if (controller.signal.aborted) throw abortError();
      const activeSession = await sessionTask;
      await activeSession.steer(text);
    };
    return Object.assign(channel, { cancel, steer });
  }

  /**
   * Legacy SDK-facing approval gate. Reached when no policy engine is configured, or
   * after a policy "ask" outcome. Read-only tools always pass, full mode always passes,
   * read-only mode blocks mutations, and anything else goes through the durable gate.
   */
  async #approveTool(mode: ToolAccessMode, toolCall: PiToolCall, signal: AbortSignal, channel: EventChannel): Promise<PiToolApprovalResult> {
    if (READ_ONLY_TOOLS.has(toolCall.toolName)) return { allowed: true };
    // Media tools never auto-allow in full mode (§5.9): they fall through to the durable
    // approval gate (or a clear block when no approval service is available).
    if (mode === "full" && !MEDIA_TOOLS.has(toolCall.toolName)) return { allowed: true };
    if (mode === "read-only") return { allowed: false, reason: `${toolCall.toolName} is blocked in Read only mode` };
    if (!this.#requestToolApproval) return { allowed: false, reason: "This tool requires approval, but no approval service is available" };
    const handle = this.#requestToolApproval({ toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input, sessionId: "" }, signal);
    channel.push({ type: "tool.approval.requested", approvalId: handle.approvalId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input });
    const decision = await handle.decision;
    channel.push({ type: "tool.approval.resolved", approvalId: handle.approvalId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, decision });
    return decision === "approved" ? { allowed: true } : { allowed: false, reason: `The user denied ${toolCall.toolName}` };
  }

  /**
   * Deterministic evaluation for one tool call, run before any human gate.
   * When a host policy engine is configured it decides mechanically for every tool —
   * including read-only tools, which can still exfiltrate secrets (`cat ~/.ssh/id_rsa`)
   * — and only its "ask" outcome reaches a human. Read-only mode stays enforced above
   * the policy: writes are blocked outright, reads still pass through the policy.
   */
  async #evaluateTool(cwd: string, mode: ToolAccessMode, sessionId: string | undefined, runId: string | undefined, toolCall: PiToolCall, signal: AbortSignal, channel: EventChannel): Promise<ToolEvaluation> {
    const isReadOnlyTool = READ_ONLY_TOOLS.has(toolCall.toolName);
    if (this.#toolPolicy && (isReadOnlyTool || mode !== "read-only")) {
      const outcome = await this.#toolPolicy({ ...toolCall, ...(sessionId ? { sessionId } : {}), cwd, ...(runId ? { runId } : {}) }, signal);
      if (outcome.action !== "ask") return outcome;
      return this.#escalate(sessionId, toolCall, signal, channel);
    }
    // No policy configured: legacy behavior.
    if (isReadOnlyTool) return { action: "allow" };
    if (mode === "read-only") return { action: "block", reason: `${toolCall.toolName} is blocked in Read only mode` };
    // Media tools are Ask-first even in full mode (§5.9): generation is paid work, so the
    // legacy auto-allow is skipped and the call escalates to the approval gate (or blocks
    // when no approval service is available).
    if (mode === "full" && !MEDIA_TOOLS.has(toolCall.toolName)) return { action: "allow" };
    return this.#escalate(sessionId, toolCall, signal, channel);
  }

  /** Human approval gate, used only when the policy engine escalates or no policy is configured. */
  async #escalate(sessionId: string | undefined, toolCall: PiToolCall, signal: AbortSignal, channel: EventChannel): Promise<ToolEvaluation> {
    if (!sessionId || !this.#requestToolApproval) return { action: "block", reason: "This tool requires approval, but no approval service is available" };
    const handle = this.#requestToolApproval({ ...toolCall, sessionId }, signal);
    channel.push({ type: "tool.approval.requested", approvalId: handle.approvalId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input });
    const decision = await handle.decision;
    channel.push({ type: "tool.approval.resolved", approvalId: handle.approvalId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, decision });
    return decision === "approved" ? { action: "allow" } : { action: "block", reason: `The user denied ${toolCall.toolName}` };
  }
}

const TOOL_BUDGET_EXEMPT = new Set(["agent_plan", "subagent"]);

/** Per-root-run circuit breaker for runaway exploratory loops. Correctness does
 * not depend on the model honoring its notice: once capacity is consumed,
 * substantive tools are rejected while plan/status tools remain available. */
class WorkToolBudget {
  readonly #limit: number | undefined;
  readonly #admitted = new Set<string>();

  constructor(limit: number | undefined) {
    this.#limit = limit === undefined ? undefined : Math.max(1, Math.floor(limit));
  }

  admissionReason(toolCall: PiToolCall): string | undefined {
    if (this.#limit === undefined || TOOL_BUDGET_EXEMPT.has(toolCall.toolName) || this.#admitted.has(toolCall.toolCallId)) return undefined;
    return this.#admitted.size >= this.#limit
      ? `The ${this.#limit}-call substantive tool budget is exhausted. Do not call more research or mutation tools. Finish the durable plan from the evidence already gathered, state any uncertainty, and answer once the last required item automatically opens the final-answer phase.`
      : undefined;
  }

  recordAllowedTool(toolCall: PiToolCall): void {
    if (this.#limit !== undefined && !TOOL_BUDGET_EXEMPT.has(toolCall.toolName)) this.#admitted.add(toolCall.toolCallId);
  }

  initialInstruction(): string | undefined {
    if (this.#limit === undefined) return undefined;
    return `This run has a hard budget of ${this.#limit} substantive tool calls, excluding agent_plan and subagent. Scope the plan to fit, batch independent calls, inspect high-value sources first, and synthesize once the request is answerable.`;
  }
}

/** Builds the bounded model-facing preview for a result whose complete,
 * redacted content has already been persisted by the spill store. */
export function previewToolResultContent(content: unknown[], path: string, maxChars = 12_000): unknown[] {
  if (!Number.isFinite(maxChars) || maxChars < 1) return content;
  const textParts = content.filter((part): part is { type: string; text: string } =>
    part !== null && typeof part === "object" && "type" in part && "text" in part
      && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string");
  const total = textParts.reduce((sum, part) => sum + part.text.length, 0);
  if (total <= maxChars) return content;
  let remaining = Math.floor(maxChars);
  let markerWritten = false;
  return content.flatMap((part) => {
    if (!part || typeof part !== "object" || !("type" in part) || !("text" in part)
      || (part as { type?: unknown }).type !== "text" || typeof (part as { text?: unknown }).text !== "string") return [part];
    if (remaining <= 0) return [];
    const value = part as { type: string; text: string };
    if (value.text.length <= remaining) { remaining -= value.text.length; return [part]; }
    const marker = `\n\n[Full tool result (${total} characters) saved to ${path}. Read that file with a narrower range when more detail is required.]`;
    const kept = value.text.slice(0, Math.max(0, remaining - marker.length));
    remaining = 0;
    markerWritten = true;
    return [{ ...value, text: kept + marker }];
  }).concat(markerWritten ? [] : [{ type: "text", text: `[Full tool result (${total} characters) saved to ${path}.]` }]);
}

function toolResultTextLength(content: unknown[]): number {
  return content.reduce<number>((total, part) => total + (part !== null && typeof part === "object" && "type" in part && "text" in part
    && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
    ? (part as { text: string }).text.length : 0), 0);
}

async function createSdkSession(options: Parameters<PiSessionFactory>[0]): Promise<PiSession> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const settingsManager = sdk.SettingsManager.create(options.cwd, options.agentDir);
  if (options.compaction) {
    settingsManager.applyOverrides({
      compaction: {
        enabled: true,
        reserveTokens: options.compaction.reserveTokens,
        keepRecentTokens: options.compaction.keepRecentTokens,
      },
    });
  }
  const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null });
  await modelRuntime.setRuntimeApiKey("openrouter", options.apiKey, { allowNetwork: false });
  const model: Model<"openai-completions"> = {
    id: options.routeId,
    name: `Fitz ${options.routeId}`,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: options.baseUrl,
    reasoning: (options.thinkingLevel ?? "off") !== "off",
    input: options.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
    ...(options.workContext ? { headers: workContextHeaders(options.workContext) } : {}),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      supportsStrictMode: true,
      ...(options.thinkingFormat === "ninfer"
        ? { thinkingFormat: "chat-template" as const, chatTemplateKwargs: { preserve_thinking: true } }
        : options.thinkingFormat ? { thinkingFormat: options.thinkingFormat } : {}),
    },
  };
  const activeToolLeases = new Map<string, ToolLeaseRelease>();
  let fitzSystemPrompt = FITZ_SYSTEM_PROMPT_SEED;
  let piBaseSystemPrompt = FITZ_SYSTEM_PROMPT_SEED;
  let pendingRuntimeControl: { purpose: string; instruction: string } | undefined;
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    // Fitz owns the Pi extension layout: `{agentDir}/extensions/` is the registry
    // (extensions/registry.json), so upstream auto-discovery and settings.json packages
    // must not leak in. Only the registry's enabled package dirs are loaded.
    noExtensions: true,
    additionalExtensionPaths: await readEnabledExtensionDirs(options.agentDir),
    // A Fitz-owned seed prevents the SDK's Pi-branded default prompt from ever
    // becoming the base. The complete dynamic prompt is assembled below after
    // all active tools, skills, and project instructions are known.
    systemPrompt: FITZ_SYSTEM_PROMPT_SEED,
    extensionFactories: [{
      name: "fitz-tool-approval",
      hidden: true,
      factory: (pi) => {
        // AgentSession resets Agent.state to its resource-loader base before
        // every prompt. Own that supported pre-turn boundary so the complete
        // Fitz prompt and any ephemeral runtime control are present on the
        // very first provider request, not only after a tool turn.
        pi.on("before_agent_start", (event) => {
          const constrained = constrainSystemPrompt(fitzSystemPrompt, event.systemPrompt, piBaseSystemPrompt);
          return {
            systemPrompt: pendingRuntimeControl
              ? `${constrained}\n\n${runtimeControlPrompt(pendingRuntimeControl.purpose, pendingRuntimeControl.instruction)}`
              : constrained,
          };
        });
        const acquireLease = async (event: PiToolCall): Promise<undefined> => {
          if (!options.acquireToolLease) return undefined;
          activeToolLeases.get(event.toolCallId)?.();
          activeToolLeases.set(event.toolCallId, await options.acquireToolLease(event));
          return undefined;
        };
        pi.on("tool_call", async (event) => {
          const unsafeReason = broadFilesystemScanReason(event.toolName, event.input);
          if (unsafeReason) return { block: true, reason: unsafeReason };
          if (options.evaluateTool) {
            const outcome = await options.evaluateTool({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
            if (outcome.action === "allow") return acquireLease(event);
            if (outcome.action === "block") return { block: true, reason: outcome.reason };
            if (outcome.action === "rewrite") { Object.assign(event.input, outcome.input); return acquireLease(event); }
            // "ask": fall through to the approval gate.
          }
          const decision = await options.approveTool({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
          return decision.allowed ? acquireLease(event) : { block: true, reason: decision.reason ?? "Tool execution denied" };
        });
        pi.on("tool_result", async (event) => {
          activeToolLeases.get(event.toolCallId)?.();
          activeToolLeases.delete(event.toolCallId);
          const redacted = options.redactResult?.({ toolName: event.toolName, content: event.content });
          const content = redacted ?? event.content;
          const maxChars = options.maxToolResultChars ?? 12_000;
          if (toolResultTextLength(content) <= maxChars) return redacted ? { content: content as typeof event.content } : undefined;
          if (!options.spillResult) throw new Error(`Oversized ${event.toolName} result cannot be persisted because no spill store is configured`);
          const spill = await options.spillResult({ toolCallId: event.toolCallId, toolName: event.toolName, content });
          return { content: previewToolResultContent(content, spill.path, maxChars) as typeof event.content };
        });
      },
    }],
  });
  await resourceLoader.reload();
  const extensionTools = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  // The SDK treats `tools` as a strict allowlist that also filters custom tools, so every
  // custom tool we register (fitz_trash, fitz_session, the sandboxed bash) must be named
  // here or it is silently dropped from the session's tool registry.
  const customToolNames = [
    ...(options.sessionQuery ? [SESSION_LOOKUP_TOOL] : []),
    ...(options.customTools?.map((tool) => tool.name) ?? []),
  ];
  const enabledTools = options.activeTools
    ? [...new Set(options.activeTools)]
    : [...new Set([...(options.tools ?? CODING_TOOLS), ...extensionTools, ...customToolNames])];
  const result = await sdk.createAgentSession({
    cwd: options.cwd,
    tools: enabledTools,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    ...(options.sessionQuery || options.customTools?.length
      ? { customTools: [...(options.sessionQuery ? [createSessionLookupTool(options.sessionQuery)] : []), ...(options.customTools ?? [])] }
      : {}),
    sessionManager: sdk.SessionManager.inMemory(options.cwd),
  });
  const session = result.session;
  piBaseSystemPrompt = session.systemPrompt;
  const toolDefinitions = new Map<string, ToolDefinition>();
  for (const name of enabledTools) {
    const definition = session.getToolDefinition(name);
    if (definition) toolDefinitions.set(name, definition);
  }
  const renderedPrompt = buildFitzSystemPrompt({
    cwd: options.cwd,
    agentDir: options.agentDir,
    llmRoot: options.llmRoot,
    selectedTools: enabledTools,
    toolDefinitions,
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
    skills: resourceLoader.getSkills().skills,
    ...(options.requestInstructions ? { requestInstructions: options.requestInstructions } : {}),
    ...(options.runInstructions ? { runInstructions: options.runInstructions } : {}),
    // Extensions may declare an append-only resource contribution. Per-turn
    // whole-prompt rewrites are constrained by prepareNextTurnWithContext below.
    extensionInstructions: resourceLoader.getAppendSystemPrompt(),
  });
  // The Fitz inline extension runs after user extensions and rebases Pi's seed
  // prompt onto this complete contract at the supported pre-turn boundary.
  // Direct Agent.state assignment is transient because prompt() restores Pi's
  // private base before starting a completion.
  fitzSystemPrompt = renderedPrompt.text;
  const seededHistory = chatMessagesToPi(options.history ?? [], options.routeId);
  if (seededHistory.length) {
    session.agent.state.messages = seededHistory;
    for (const message of seededHistory) session.sessionManager.appendMessage(message);
  }
  const withheldAnswerToolCalls = new Set<string>();
  const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext;
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const prepared = await previousPrepareNextTurnWithContext?.(turn, signal);
    const context = { ...turn.context, ...(prepared?.context ?? {}) };
    return {
      ...(prepared ?? {}),
      context: {
        ...context,
        systemPrompt: constrainSystemPrompt(turn.context.systemPrompt, prepared?.context?.systemPrompt),
      },
    };
  };
  const previousTransformContext = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
    return withoutAssistantTextForTools(transformed, withheldAnswerToolCalls);
  };
  serializeWorkspaceMutationTools(session.agent.state.tools);
  return {
    subscribe: (listener) => session.subscribe((event) => listener(event as PiEvent)),
    prompt: (text, images) => session.prompt(text, images?.length ? { images } : undefined),
    promptControl: async (purpose, instruction) => {
      pendingRuntimeControl = { purpose, instruction };
      try { await session.prompt(FITZ_RUNTIME_CONTROL_ACTIVATION); }
      finally { pendingRuntimeControl = undefined; }
    },
    steer: (text) => session.steer(text),
    promptProvenance: renderedPrompt.provenance,
    discardLastAssistantDraft: () => {
      const messages = session.agent.state.messages;
      const lastMessage = messages.at(-1);
      const leaf = session.sessionManager.getLeafEntry();
      if (lastMessage?.role !== "assistant" || leaf?.type !== "message" || leaf.message.role !== "assistant") return false;

      const parent = leaf.parentId === null ? undefined : session.sessionManager.getEntry(leaf.parentId);
      const discardControlActivation = isRuntimeControlActivationMessage(messages.at(-2))
        && parent?.type === "message"
        && isRuntimeControlActivationMessage(parent.message);
      const branchFromId = discardControlActivation ? parent.parentId : leaf.parentId;

      // Agent.state is the live completion context. SessionManager owns the
      // parallel append-only tree used by AgentSession. Repointing its leaf
      // preserves discarded nodes for diagnostics while excluding them from
      // the branch used by every subsequent completion. A no-tool internal
      // continuation is one atomic control turn, so discard its opaque user
      // activation with the rejected assistant draft instead of accumulating
      // synthetic user messages across retries.
      session.agent.state.messages = messages.slice(0, discardControlActivation ? -2 : -1);
      if (branchFromId === null) session.sessionManager.resetLeaf();
      else session.sessionManager.branch(branchFromId);
      return true;
    },
    withholdLastAssistantText: (toolCallId) => {
      const messages = session.agent.state.messages;
      const lastMessage = messages.at(-1);
      const leaf = session.sessionManager.getLeafEntry();
      if (lastMessage?.role !== "assistant" || leaf?.type !== "message" || leaf.message.role !== "assistant") return false;
      if (!Array.isArray(lastMessage.content) || !lastMessage.content.some((part) => part.type === "toolCall" && part.id === toolCallId)) return false;
      withheldAnswerToolCalls.add(toolCallId);
      const content = lastMessage.content.filter((part) => part.type !== "text");
      if (content.length === lastMessage.content.length) return true;
      const withheld = { ...lastMessage, content };

      // The SDK session is append-only. Preserve the original node as forensic
      // history, repoint the active branch to its parent, and append a sanitized
      // assistant message containing the exact same reasoning/tool calls but no
      // provisional answer. The imminent tool result is then attached to this
      // sanitized branch and every retry sees only valid history.
      session.agent.state.messages = [...messages.slice(0, -1), withheld];
      if (leaf.parentId === null) session.sessionManager.resetLeaf();
      else session.sessionManager.branch(leaf.parentId);
      session.sessionManager.appendMessage(withheld);
      return true;
    },
    abort: () => session.abort(),
    dispose: () => {
      for (const release of activeToolLeases.values()) release();
      activeToolLeases.clear();
      session.dispose();
    },
  };
}

export function isRuntimeControlActivationMessage(message: { role?: string; content?: unknown } | undefined): boolean {
  if (message?.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const part = message.content[0];
  return typeof part === "object" && part !== null && "type" in part && "text" in part
    && part.type === "text" && part.text === FITZ_RUNTIME_CONTROL_ACTIVATION;
}

/**
 * The core agent loop works from a snapshot created when prompt() starts, so
 * rewriting Agent.state alone cannot affect a continuation already in flight.
 * This context transform is applied immediately before every engine request
 * and mechanically removes provisional answer text associated with a held
 * plan-ready tool call while preserving reasoning and tool protocol records.
 */
export function withoutAssistantTextForTools<T extends { role?: string; content?: unknown }>(messages: readonly T[], toolCallIds: ReadonlySet<string>): T[] {
  if (!toolCallIds.size) return [...messages];
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const ownsWithheldTool = message.content.some((part: unknown) =>
      part !== null && typeof part === "object"
      && (part as { type?: unknown }).type === "toolCall"
      && typeof (part as { id?: unknown }).id === "string"
      && toolCallIds.has((part as { id: string }).id));
    if (!ownsWithheldTool) return message;
    return { ...message, content: message.content.filter((part: unknown) =>
      part === null || typeof part !== "object" || (part as { type?: unknown }).type !== "text") } as T;
  });
}

function workContextHeaders(context: PiWorkContext): Record<string, string> {
  return {
    ...(context.runId ? { "x-fitz-run-id": context.runId } : {}),
    ...(context.ownerUserId ? { "x-fitz-owner-user-id": context.ownerUserId } : {}),
    ...(context.ownerDeviceId ? { "x-fitz-owner-device-id": context.ownerDeviceId } : {}),
    ...(context.sessionId ? { "x-fitz-session-id": context.sessionId } : {}),
  };
}

/**
 * The `fitz_session` read-only tool: lets the agent read a past conversation from the Fitz
 * session store (the host SQLite store) by session id. Registered only when the host supplies
 * a query service, so sessions without store access never see a dead tool.
 */
export function createSessionLookupTool(source: SessionQueryService): ToolDefinition {
  const parameters = Type.Object({
    sessionId: Type.String({ description: "The Fitz session id (a UUID, e.g. shown in the session header popover) to read" }),
    after: Type.Optional(Type.Number({ description: "Only return transcript entries with sequence greater than this value" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of transcript entries to return (default 200, max 1000)" })),
    section: Type.Optional(Type.Union([
      Type.Literal("overview"), Type.Literal("transcript"), Type.Literal("runs"),
      Type.Literal("evidence"), Type.Literal("artifacts"), Type.Literal("media"),
      Type.Literal("audit"), Type.Literal("all"),
    ], { description: "Forensic section to read; transcript is the default and all returns the complete session bundle" })),
    includeArtifactContent: Type.Optional(Type.Boolean({ description: "Include artifact bytes in the artifacts/all sections (default false)" })),
  });
  const tool: ToolDefinition<typeof parameters> = {
    name: SESSION_LOOKUP_TOOL,
    label: "Fitz session lookup",
    description:
      "Read a past Fitz Harness conversation or its versioned forensic record by session id. The default transcript section is paginated. Use overview first when diagnosing a failure, then runs/evidence/audit/artifacts/media as needed; use all only when the complete bundle is small enough. The current session's history is injected automatically, so this tool is for looking up OTHER sessions. Returns a formatted section, or a message saying the session was not found.",
    promptSnippet: "Read past Fitz conversations or forensic evidence by session id",
    promptGuidelines: [
      "When the user references a previous conversation, use this tool with the session id they provide (they can find it in the session header popover).",
      "Prefer reading a session over guessing what was discussed — the durable forensic bundle is the source of truth for conversation and execution history.",
      "For a failure, read overview, then the relevant run and evidence sections; do not infer a provider failure from transcript text alone.",
    ],
    parameters,
    execute: async (_toolCallId, params) => {
      try {
        const request: SessionQueryRequest = {
          sessionId: params.sessionId,
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.section !== undefined ? { section: params.section } : {}),
          ...(params.includeArtifactContent !== undefined ? { includeArtifactContent: params.includeArtifactContent } : {}),
        };
        const snapshot = (await source.query(request))?.snapshot;
        return snapshot
          ? toolResult(formatSessionSnapshot(snapshot, params.section), { source: "fitz_session", ...(params.section ? { section: params.section } : {}) })
          : toolResult(`No Fitz session found with id ${params.sessionId}.`);
      } catch (error) {
        return toolResult(`Could not read Fitz session ${params.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  return tool;
}

function scopedSessionQuery(service: SessionQueryService, ownerUserId: string | undefined): SessionQueryService {
  if (!ownerUserId) return service;
  return {
    query: (request) => service.query({ ...request, ownerUserId }),
  };
}

export function toolResult(text: string, details: unknown = undefined): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/**
 * The `fitz_trash` tool: moves paths into the run's agent trash instead of deleting them.
 * The host wires the handler to its TrashService so deletes the model performs explicitly
 * go through the same recoverable path as rewritten `rm` commands. Registered only when the
 * host supplies a trash handler via `customTools`.
 */
export function createTrashTool(handler: TrashToolHandler): ToolDefinition {
  const parameters = Type.Object({
    paths: Type.Array(Type.String({ description: "Files or directories to move to the agent trash. Use absolute paths or paths relative to the workspace root." })),
  });
  const tool: ToolDefinition<typeof parameters> = {
    name: TRASH_TOOL,
    label: "Fitz trash",
    description:
      "Move files or directories to the current run's trash folder instead of hard-deleting them. Trash lives inside the workspace under .fitz-trash, is recoverable, and is emptied only with the user's explicit approval. Prefer this over rm/rmdir/del for anything the user might want back.",
    promptSnippet: "Move files to the run trash instead of deleting",
    promptGuidelines: [
      "Prefer fitz_trash over destructive shell commands (rm, rmdir, del, rd, unlink, shred) whenever you are removing user-visible files.",
      "Trashed paths can be restored from the host management UI; never bypass the trash to permanently delete data.",
    ],
    parameters,
    execute: async (_toolCallId, params) => {
      try {
        const result = await handler({ paths: params.paths });
        if ("error" in result) return toolResult(result.error);
        const lines = result.entries.map((entry) => `  ${entry.originalPath} -> ${entry.trashPath}`);
        return toolResult(`Moved ${result.moved} path(s) to the run trash:\n${lines.join("\n")}`);
      } catch (error) {
        return toolResult(`Could not trash the requested paths: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  return tool;
}

export function formatSessionSnapshot(snapshot: PiSessionSnapshot, section: PiSessionLookupSection = "transcript"): string {
  if (snapshot.forensics && section !== "transcript") return formatForensics(snapshot, section);
  const lines = [
    `Session: ${snapshot.title}`,
    `Status: ${snapshot.status}`,
    `Updated: ${snapshot.updatedAt}`,
    ...snapshot.messages.map((message) => `[${message.sequence}] ${message.role.toUpperCase()}: ${message.text}`),
  ];
  return lines.join("\n");
}

function formatForensics(snapshot: PiSessionSnapshot, section: PiSessionLookupSection): string {
  const bundle = snapshot.forensics!;
  if (section === "overview") {
    return [
      `Session: ${bundle.session.title}`,
      `Status: ${bundle.session.status}`,
      `Updated: ${bundle.session.updatedAt}`,
      `Transcript entries: ${bundle.transcript.length}`,
      `Runs: ${bundle.runs.length}`,
      `Inference evidence: ${bundle.evidence.length}`,
      `Media jobs: ${bundle.mediaJobs.length}`,
      `Artifacts: ${bundle.artifacts.length}`,
      `Coverage: ${safeJson(bundle.coverage)}`,
      `Run ids: ${bundle.runs.map((entry) => `${entry.run.id} (${entry.run.status})`).join(", ") || "none"}`,
    ].join("\n");
  }
  const value = section === "runs" ? { runs: bundle.runs }
    : section === "evidence" ? { coverage: bundle.coverage, evidence: bundle.evidence, usage: bundle.usage }
      : section === "artifacts" ? { artifacts: bundle.artifacts }
        : section === "media" ? { mediaJobs: bundle.mediaJobs }
          : section === "audit" ? { auditEvents: bundle.auditEvents, lifecycleEvents: bundle.lifecycleEvents, legacyInferenceRequests: bundle.legacyInferenceRequests, gpuWork: bundle.gpuWork }
            : bundle;
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
}

/**
 * Absolute paths of the enabled Pi extension package dirs, per the Fitz-managed registry at
 * `{agentDir}/extensions/registry.json`. Fitz keeps all Pi packages in one folder that is
 * itself the registry, so these dirs are the only Pi extensions a session loads. Disabled
 * entries and dirs that no longer exist are excluded; any read/parse error yields an empty
 * list so a missing or corrupt registry never breaks session creation.
 */
export async function readEnabledExtensionDirs(agentDir: string): Promise<string[]> {
  try {
    const registry = JSON.parse(await readFile(join(agentDir, "extensions", "registry.json"), "utf8")) as {
      packages?: Array<{ name?: unknown; enabled?: unknown }>;
    };
    if (!Array.isArray(registry.packages)) return [];
    return registry.packages
      .filter((entry): entry is { name: string; enabled?: boolean } =>
        Boolean(entry) && typeof entry.name === "string" && entry.enabled !== false)
      .map((entry) => join(agentDir, "extensions", entry.name))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

export function buildFitzSystemInstructions(options: Pick<Parameters<PiSessionFactory>[0], "cwd" | "agentDir" | "llmRoot">): string {
  return buildFitzSystemPrompt({
    ...options,
    selectedTools: [],
    toolDefinitions: new Map(),
  }).text;
}

export function broadFilesystemScanReason(toolName: string, input: unknown): string | undefined {
  if (toolName !== "bash" || !input || typeof input !== "object") return undefined;
  const command = "command" in input && typeof input.command === "string" ? input.command.trim() : "";
  if (!command) return undefined;
  const scansRoot = /(?:^|[;&|]\s*)find\s+(?:\/|~)(?:\s|$)/i.test(command)
    || /Get-ChildItem\s+(?:['\"]?[A-Za-z]:\\['\"]?|['\"]?~['\"]?)\s+[^;\r\n]*-Recurse\b/i.test(command);
  return scansRoot
    ? "Fitz blocked an unbounded filesystem scan. Search the active project or the authoritative Fitz Pi/LLM directories supplied in the system instructions instead."
    : undefined;
}
function translateEvent(event: PiEvent): AgentRuntimeEvent | undefined { if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta) return { type: "assistant.delta", text: event.assistantMessageEvent.delta }; if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta" && event.assistantMessageEvent.delta) return { type: "reasoning.delta", text: event.assistantMessageEvent.delta }; if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") return { type: "reasoning.completed" }; if (event.type === "tool_execution_start") return { type: "tool.started", toolCallId: event.toolCallId, toolName: event.toolName, ...(event.args !== undefined ? { input: event.args } : {}) }; if (event.type === "tool_execution_end") return { type: "tool.completed", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, ...(event.isError !== undefined ? { isError: event.isError } : {}) }; return undefined; }
function isPlanReadyCall(event: Extract<PiEvent, { type: "tool_execution_start" }>): boolean {
  return event.toolName === "agent_plan" && Boolean(event.args && typeof event.args === "object" && "action" in event.args && event.args.action === "ready");
}
function isCompletedMediaHandoff(event: PiEvent): boolean {
  if (event.type !== "tool_execution_end" || event.isError || !MEDIA_TOOLS.has(event.toolName)) return false;
  if (!event.result || typeof event.result !== "object") return false;
  const details = "details" in event.result ? event.result.details : undefined;
  return Boolean(details && typeof details === "object" && "mediaJobId" in details && typeof details.mediaJobId === "string" && details.mediaJobId);
}
function piFailure(event: PiEvent): Error | undefined { return event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error" ? new Error(event.message.errorMessage ?? "Pi model request failed") : undefined; }
interface PreparedPromptInput {
  text: string;
  images: PiImageContent[];
  history: ChatMessage[];
  requestInstructions: string[];
}

/** Separates trusted request controls from structured history and the new turn. */
export function preparePromptInput(messages: readonly ChatMessage[]): PreparedPromptInput {
  const requestInstructions = messages
    .filter((message) => message.role === "system")
    .map((message) => extractTextFromContent(message.content).trim())
    .filter(Boolean);
  const conversation = messages.filter((message) => message.role !== "system");
  const current = conversation.at(-1)?.role === "user" ? conversation.at(-1) : undefined;
  const history = current ? conversation.slice(0, -1) : conversation;
  const text = current ? extractTextFromContent(current.content).trim() : "Continue the task using the run instructions and conversation history.";
  return {
    text: text || "Respond to the attached content.",
    images: current ? imageContentFromMessage(current) : [],
    history,
    requestInstructions,
  };
}

function imageContentFromMessage(message: ChatMessage): PiImageContent[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((part) => {
    if (part.type !== "image_url" || typeof part.image_url?.url !== "string") return [];
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url);
    return match ? [{ type: "image" as const, mimeType: match[1]!, data: match[2]! }] : [];
  });
}

/** Converts canonical Fitz history without flattening role labels into text. */
export function chatMessagesToPi(messages: readonly ChatMessage[], model: string): Message[] {
  const toolNames = new Map<string, string>();
  const result: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => part.type === "text"
          ? [{ type: "text" as const, text: part.text }]
          : imageContentFromUrl(part.image_url.url));
      result.push({ role: "user", content, timestamp: Date.now() });
      continue;
    }
    if (message.role === "assistant") {
      const content: Extract<Message, { role: "assistant" }>["content"] = [];
      const text = extractTextFromContent(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: parseToolArguments(call.function.arguments) });
      }
      if (!content.length) continue;
      result.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "openrouter",
        model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: message.tool_calls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    const toolCallId = message.tool_call_id ?? `historical-tool-${result.length + 1}`;
    const toolName = toolNames.get(toolCallId);
    if (!toolName) {
      result.push({
        role: "user",
        content: `Historical tool output (untrusted data):\n${extractTextFromContent(message.content)}`,
        timestamp: Date.now(),
      });
      continue;
    }
    result.push({
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: extractTextFromContent(message.content) }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  return result;
}

function imageContentFromUrl(url: string): Array<{ type: "image"; mimeType: string; data: string } | { type: "text"; text: string }> {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  return match
    ? [{ type: "image", mimeType: match[1]!, data: match[2]! }]
    : [{ type: "text", text: `[Historical image reference: ${url}]` }];
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { raw: value };
  }
}
function extractTextFromContent(content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ");
}
function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string").map((part) => part.text ?? "").join(" ").trim();
}
function abortError(): Error { const error = new Error("Pi agent run was cancelled"); error.name = "AbortError"; return error; }

class EventChannel implements AsyncIterable<AgentRuntimeEvent> { readonly #values: AgentRuntimeEvent[] = []; readonly #waiters: Array<{ resolve: (result: IteratorResult<AgentRuntimeEvent>) => void; reject: (error: unknown) => void }> = []; #closed = false; #error: unknown;
  push(value: AgentRuntimeEvent): void { if (this.#closed) return; const waiter = this.#waiters.shift(); if (waiter) waiter.resolve({ value, done: false }); else this.#values.push(value); }
  close(): void { if (this.#closed) return; this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true }); }
  fail(error: unknown): void { if (this.#closed) return; this.#error = error; this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> { return { next: async () => { const value = this.#values.shift(); if (value) return { value, done: false }; if (this.#error) throw this.#error; if (this.#closed) return { value: undefined, done: true }; return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject })); } }; }
}
