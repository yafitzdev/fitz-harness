import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun, AgentRuntimeRunOptions } from "@fitz/agent-core";
import type { AgentRunRequest, MediaModality, ToolAccessMode } from "@fitz/protocol";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
export type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PiDelegationPolicy,
  delegatedCompaction,
} from "./pi-delegation-policy.js";
import type { ToolLeaseAcquirer, ToolLeaseRelease } from "./workspace-mutation-leases.js";

type PiEvent =
  | { type: "message_start"; message: { role?: string; content?: unknown } }
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string; content?: string } }
  | { type: "message_end"; message: { role?: string; stopReason?: string; errorMessage?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };
/** Pi thinking levels. Maps to the SDK's `ThinkingLevel`; kept local so the runtime boundary stays SDK-free. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PiSession { subscribe(listener: (event: PiEvent) => void): () => void; prompt(text: string): Promise<void>; steer(text: string): Promise<void>; abort(): Promise<void>; dispose(): void }
type PiWorkContext = AgentRuntimeRunOptions & { forcedToolName?: string };
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
/** One canonical transcript entry, reduced to what an agent needs to read. */
export interface PiSessionMessage { sequence: number; role: "user" | "assistant" | "tool" | "system"; text: string }
/** A past Fitz Codex conversation, as served to the agent's `fitz_session` tool. */
export interface PiSessionSnapshot { title: string; status: string; updatedAt: string; messages: PiSessionMessage[] }
/**
 * Reads a past conversation from the Fitz session store. The host provides the store-backed
 * implementation; the pi package owns the contract and the tool that uses it.
 */
export type PiSessionReader = (sessionId: string, options?: { after?: number; limit?: number }) => Promise<PiSessionSnapshot | undefined>;
export type SubagentRoute = "default" | "fast" | "smart";
export type SubagentRouteBudget = Readonly<Record<SubagentRoute, number>>;
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
  agentDir: string;
  llmRoot: string;
  thinkingLevel?: ThinkingLevel;
  /** Per-run compaction headroom. Delegated workers use a deliberately smaller
   * recent window so tool output cannot fill their shorter shared context. */
  compaction?: { reserveTokens: number; keepRecentTokens: number };
  approveTool: (request: PiToolCall) => Promise<PiToolApprovalResult>;
  sessionReader?: PiSessionReader;
  /** Deterministic policy evaluation. When present it runs before `approveTool` for every tool call. */
  evaluateTool?: (request: PiToolCall) => Promise<ToolEvaluation>;
  /** Acquire an exclusive lease immediately before an allowed mutating tool executes. */
  acquireToolLease?: (request: PiToolCall) => Promise<ToolLeaseRelease>;
  /** Post-execution redaction of tool results before the model sees them. */
  redactResult?: ToolResultRedactor;
  /** Extra tools registered per run (e.g. `fitz_trash`). */
  customTools?: ToolDefinition[];
  /** Trusted localhost-only correlation propagated to the Fitz completion gateway. */
  workContext?: PiWorkContext;
}) => Promise<PiSession>;
export interface PiAgentRuntimeOptions {
  cwd?: string | ((request: AgentRunRequest) => string);
  tools?: readonly string[];
  baseUrl?: string;
  apiKey?: string;
  /** Model context window in tokens, or a per-request resolver (the request carries the resolved route id). */
  contextWindow?: number | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => number);
  thinkingLevel?: ThinkingLevel;
  createSession?: PiSessionFactory;
  requestToolApproval?: ToolApprovalRequester;
  agentDir?: string;
  llmRoot?: string;
  sessionReader?: PiSessionReader;
  /** Deterministic host policy engine; evaluated for every non-read-only tool call before any approval gate. */
  toolPolicy?: ToolEvaluator;
  /** Coordinates workspace-mutating tools across concurrent agent runs. */
  toolLease?: ToolLeaseAcquirer;
  /** Redacts secrets from tool results before the model reads them. */
  redactToolResult?: ToolResultRedactor;
  /** Extra tools to register for each run; called with the run's resolved working directory. */
  customTools?: (context: { cwd: string; runId?: string; request?: AgentRunRequest }) => ToolDefinition[];
  /** Route-specific child capacity for the selected parent route. Undefined
   * means this parent must not receive a delegation tool. */
  subagentBudget?: (request: AgentRunRequest, context?: AgentRuntimeRunOptions) => SubagentRouteBudget | undefined;
  /** Forward task correlation headers to the model endpoint. Enable only for Fitz's bundled localhost gateway. */
  forwardWorkContext?: boolean;
}

const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
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
  // Fitz's bundled research extension tools only fetch public content and are
  // safe in researcher/reviewer read-only child sessions.
  "web_search", "fetch_content", "get_search_content",
]);

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly #cwd: string | ((request: AgentRunRequest) => string);
  readonly #tools: readonly string[] | undefined;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #contextWindow: number | ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => number);
  readonly #thinkingLevel: ThinkingLevel;
  readonly #createSession: PiSessionFactory;
  readonly #requestToolApproval: ToolApprovalRequester | undefined;
  readonly #agentDir: string;
  readonly #llmRoot: string;
  readonly #sessionReader: PiSessionReader | undefined;
  readonly #toolPolicy: ToolEvaluator | undefined;
  readonly #toolLease: ToolLeaseAcquirer | undefined;
  readonly #redactToolResult: ToolResultRedactor | undefined;
  readonly #customTools: ((context: { cwd: string; runId?: string; request?: AgentRunRequest }) => ToolDefinition[]) | undefined;
  readonly #subagentBudget: ((request: AgentRunRequest, context?: AgentRuntimeRunOptions) => SubagentRouteBudget | undefined) | undefined;
  readonly #forwardWorkContext: boolean;
  constructor(options: PiAgentRuntimeOptions = {}) {
    this.#cwd = options.cwd ?? process.cwd();
    this.#tools = options.tools ?? CODING_TOOLS;
    this.#baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787/v1").replace(/\/$/, "");
    this.#apiKey = options.apiKey ?? "fitz-local";
    this.#contextWindow = options.contextWindow ?? 100_000;
    this.#thinkingLevel = options.thinkingLevel ?? "off";
    this.#createSession = options.createSession ?? createSdkSession;
    this.#requestToolApproval = options.requestToolApproval;
    this.#agentDir = options.agentDir ?? process.env.FITZ_PI_AGENT_DIR ?? `${process.cwd()}/.fitz-pi`;
    this.#llmRoot = options.llmRoot ?? process.env.FITZ_LLM_ROOT ?? `${process.cwd()}/.llm`;
    this.#sessionReader = options.sessionReader;
    this.#toolPolicy = options.toolPolicy;
    this.#toolLease = options.toolLease;
    this.#redactToolResult = options.redactToolResult;
    this.#customTools = options.customTools;
    this.#subagentBudget = options.subagentBudget;
    this.#forwardWorkContext = options.forwardWorkContext ?? false;
  }
  run(request: AgentRunRequest, signal?: AbortSignal, options?: AgentRuntimeRunOptions): AgentRuntimeRun {
    const channel = new EventChannel(); let session: PiSession | undefined; const controller = new AbortController();
    let completedMediaHandoff = false;
    const parentSubagentBudget = request.delegation ? undefined : this.#subagentBudget?.(request, options);
    const delegation = new PiDelegationPolicy(request, parentSubagentBudget);
    const cancel = () => { controller.abort(); void session?.abort(); }; if (signal) { if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true }); }
    const cwd = typeof this.#cwd === "function" ? this.#cwd(request) : this.#cwd;
    const contextWindow = typeof this.#contextWindow === "function" ? this.#contextWindow(request, options) : this.#contextWindow;
    const forcedToolName = request.mediaCommand ? `generate_${request.mediaCommand}` : undefined;
    const customTools = this.#customTools?.({ cwd, ...(options?.runId ? { runId: options.runId } : {}), request }) ?? [];
    const hasSubagentTool = customTools.some((tool) => tool.name === "subagent");
    const sessionTask = (async () => {
      if (delegation.requiresInitialFanout && !hasSubagentTool) {
        throw new Error("Subagents are unavailable for the selected route. Select a local recipe with worker capacity or configure a Fast or Smart cloud route first.");
      }
      const created = await this.#createSession({
        cwd,
        ...(forcedToolName
          ? { tools: [], activeTools: [forcedToolName] }
          : this.#tools ? { tools: this.#tools } : {}),
        routeId: request.model,
        baseUrl: this.#baseUrl,
        apiKey: this.#apiKey,
        contextWindow,
        maxTokens: request.maxTokens ?? 16_384,
        agentDir: this.#agentDir,
        llmRoot: this.#llmRoot,
        thinkingLevel: this.#thinkingLevel,
        ...(request.delegation ? { compaction: delegatedCompaction(contextWindow, request.maxTokens ?? 16_384) } : {}),
        approveTool: (toolCall) => {
          const admissionReason = delegation.admissionReason(toolCall);
          if (admissionReason) return Promise.resolve({ allowed: false, reason: admissionReason });
          return this.#approveTool(request.accessMode ?? "full", toolCall, controller.signal, channel).then((decision) => {
            if (decision.allowed) delegation.recordAllowedTool(toolCall);
            return decision;
          });
        },
        ...(this.#sessionReader ? { sessionReader: this.#sessionReader } : {}),
        ...(this.#toolPolicy || this.#requestToolApproval
          ? { evaluateTool: async (toolCall) => {
              const admissionReason = delegation.admissionReason(toolCall);
              if (admissionReason) return { action: "block" as const, reason: admissionReason };
              // A reviewed /image, /video, or /audio creation card is itself
              // explicit user approval. The run exposes exactly this one tool,
              // so asking again after the planner expands the brief would be a
              // redundant second confirmation.
              if (forcedToolName && toolCall.toolName === forcedToolName) {
                delegation.recordAllowedTool(toolCall);
                return { action: "allow" as const };
              }
              const outcome = await this.#evaluateTool(cwd, request.accessMode ?? "full", request.sessionId, options?.runId, toolCall, controller.signal, channel);
              if (outcome.action === "allow" || outcome.action === "rewrite") delegation.recordAllowedTool(toolCall);
              return outcome;
            } }
          : {}),
        ...(this.#toolLease
          ? { acquireToolLease: (toolCall) => this.#toolLease!({ ...toolCall, cwd, ...(options?.runId ? { runId: options.runId } : {}) }, controller.signal) }
          : {}),
        ...(this.#redactToolResult ? { redactResult: this.#redactToolResult } : {}),
        ...(this.#customTools ? { customTools } : {}),
        ...(this.#forwardWorkContext && options ? { workContext: { ...options, ...(forcedToolName ? { forcedToolName } : {}) } } : {}),
      }); session = created; if (controller.signal.aborted) { await created.abort(); throw abortError(); }
      return created;
    })();
    void (async () => { try {
      const activeSession = await sessionTask;
      let sawAssistant = false;
      let internalDelegationRetry = false;
      // The first user message_start is the initial prompt; any later one is a steering
      // message Pi has pulled off its steer queue, i.e. the point where the user's text is
      // inserted into the running conversation.
      let sawInitialUserMessage = false;
      const unsubscribe = activeSession.subscribe((event) => {
        const failure = piFailure(event);
        if (failure) { if (!completedMediaHandoff) channel.fail(failure); return; }
        if (event.type === "message_start" && event.message?.role === "user") {
          if (!sawInitialUserMessage) { sawInitialUserMessage = true; return; }
          if (internalDelegationRetry) { internalDelegationRetry = false; return; }
          const text = extractTextFromMessageContent(event.message.content);
          if (text) channel.push({ type: "user.steer", text });
          return;
        }
        const translated = translateEvent(event);
        if (translated) {
          if (translated.type === "assistant.delta") sawAssistant = true;
          const delegationOutput = translated.type === "assistant.delta" || translated.type === "reasoning.delta" || translated.type === "reasoning.completed";
          if (!(delegation.shouldSuppressModelOutput && delegationOutput)) channel.push(translated);
        }
        if (event.type === "tool_execution_end") {
          const budgetSteer = delegation.claimBudgetSteer();
          if (budgetSteer) queueMicrotask(() => void activeSession.steer(budgetSteer).catch(() => undefined));
        }
        if (isCompletedMediaHandoff(event)) {
          // Media generation is an asynchronous handoff. Letting Pi request one
          // more text completion here makes that request sit behind the several-
          // minute GPU media job and eventually fail as `terminated`. The media
          // tracker owns the rest of the lifecycle, so end this agent turn cleanly
          // as soon as the durable media job id has been returned.
          completedMediaHandoff = true;
          queueMicrotask(() => void activeSession.abort());
        }
      }); try {
        await activeSession.prompt(formatPrompt(request, delegation.initialPromptInstruction()));
        if (completedMediaHandoff) { channel.close(); return; }
        if (controller.signal.aborted) throw abortError();
        if (delegation.requiresInitialFanout && !delegation.initialFanoutComplete) {
          internalDelegationRetry = true;
          await activeSession.prompt(delegation.retryPrompt());
        }
        if (delegation.requiresInitialFanout && !delegation.initialFanoutComplete) throw delegation.missingFanoutError();
        if (!sawAssistant) throw new Error("Pi agent completed without an assistant response");
        channel.close();
      } finally { unsubscribe(); activeSession.dispose(); }
    } catch (error) { if (completedMediaHandoff) channel.close(); else channel.fail(error); } })();
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
    input: ["text"],
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
    },
  };
  const activeToolLeases = new Map<string, ToolLeaseRelease>();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    // Fitz owns the Pi extension layout: `{agentDir}/extensions/` is the registry
    // (extensions/registry.json), so upstream auto-discovery and settings.json packages
    // must not leak in. Only the registry's enabled package dirs are loaded.
    noExtensions: true,
    additionalExtensionPaths: await readEnabledExtensionDirs(options.agentDir),
    appendSystemPrompt: [buildFitzSystemInstructions(options)],
    extensionFactories: [{
      name: "fitz-tool-approval",
      hidden: true,
      factory: (pi) => {
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
        pi.on("tool_result", (event) => {
          activeToolLeases.get(event.toolCallId)?.();
          activeToolLeases.delete(event.toolCallId);
          if (!options.redactResult) return undefined;
          const redacted = options.redactResult({ toolName: event.toolName, content: event.content });
          return redacted ? { content: redacted as typeof event.content } : undefined;
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
    ...(options.sessionReader ? [SESSION_LOOKUP_TOOL] : []),
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
    ...(options.sessionReader || options.customTools?.length
      ? { customTools: [...(options.sessionReader ? [createSessionLookupTool(options.sessionReader)] : []), ...(options.customTools ?? [])] }
      : {}),
    sessionManager: sdk.SessionManager.inMemory(options.cwd),
  });
  const session = result.session as PiSession;
  return {
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text),
    steer: (text) => session.steer(text),
    abort: () => session.abort(),
    dispose: () => {
      for (const release of activeToolLeases.values()) release();
      activeToolLeases.clear();
      session.dispose();
    },
  };
}

function workContextHeaders(context: PiWorkContext): Record<string, string> {
  return {
    ...(context.runId ? { "x-fitz-run-id": context.runId } : {}),
    ...(context.ownerUserId ? { "x-fitz-owner-user-id": context.ownerUserId } : {}),
    ...(context.sessionId ? { "x-fitz-session-id": context.sessionId } : {}),
    ...(context.forcedToolName ? { "x-fitz-forced-tool": context.forcedToolName } : {}),
  };
}

/**
 * The `fitz_session` read-only tool: lets the agent read a past conversation from the Fitz
 * session store (the host SQLite store) by session id. Registered only when the host supplies
 * a `sessionReader`, so sessions without store access never see a dead tool.
 */
export function createSessionLookupTool(reader: PiSessionReader): ToolDefinition {
  const parameters = Type.Object({
    sessionId: Type.String({ description: "The Fitz session id (a UUID, e.g. shown in the session header popover) to read" }),
    after: Type.Optional(Type.Number({ description: "Only return transcript entries with sequence greater than this value" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of transcript entries to return (default 200, max 1000)" })),
  });
  const tool: ToolDefinition<typeof parameters> = {
    name: SESSION_LOOKUP_TOOL,
    label: "Fitz session lookup",
    description:
      "Read the transcript of a past Fitz Codex conversation by its session id. Use this when the user refers to an earlier conversation, past session, or previous chat: the transcript includes user and assistant messages, tool activity, and any compaction summaries. The current session's history is injected automatically, so this tool is for looking up OTHER sessions. Returns a formatted transcript, or a message saying the session was not found.",
    promptSnippet: "Read past Fitz Codex conversations from the session store",
    promptGuidelines: [
      "When the user references a previous conversation, use this tool with the session id they provide (they can find it in the session header popover).",
      "Prefer reading a session over guessing what was discussed — the store is the single source of truth for conversation history.",
    ],
    parameters,
    execute: async (_toolCallId, params) => {
      try {
        const snapshot = await reader(params.sessionId, {
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        });
        return snapshot
          ? toolResult(formatSessionSnapshot(snapshot), { source: "fitz_session" })
          : toolResult(`No Fitz session found with id ${params.sessionId}.`);
      } catch (error) {
        return toolResult(`Could not read Fitz session ${params.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  return tool;
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

export function formatSessionSnapshot(snapshot: PiSessionSnapshot): string {
  const lines = [
    `Session: ${snapshot.title}`,
    `Status: ${snapshot.status}`,
    `Updated: ${snapshot.updatedAt}`,
    ...snapshot.messages.map((message) => `[${message.sequence}] ${message.role.toUpperCase()}: ${message.text}`),
  ];
  return lines.join("\n");
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
  const extensionsDir = `${options.agentDir.replace(/[\\/]$/, "")}/extensions`;
  const enginesDir = `${options.llmRoot.replace(/[\\/]$/, "")}/engines`;
  const modelsDir = `${options.llmRoot.replace(/[\\/]$/, "")}/models`;
  return [
    "You are running inside Fitz Codex. Treat the following runtime locations as authoritative; do not substitute upstream Pi defaults:",
    `- Active project and working directory: ${options.cwd}`,
    `- Fitz Pi runtime root: ${options.agentDir}`,
    `- User-installed Pi extensions: ${extensionsDir}`,
    `- Canonical local LLM root: ${options.llmRoot}`,
    `- Inference engines: ${enginesDir}`,
    `- Model artifacts: ${modelsDir}`,
    `When asked about installed Pi extensions, inspect ${extensionsDir} directly. Do not inspect ~/.pi or infer installation state from upstream defaults.`,
    "Past conversations are stored by Fitz in its session store. Use the fitz_session tool with a session id to read any earlier conversation the user asks about; the current session's history is injected automatically when it is continued.",
    "The shell tool runs in Git Bash on Windows. Prefer the exact paths above and the active project directory.",
    "Never recursively search /, an entire drive, or the whole home directory to discover Fitz resources. Search the active project or an authoritative directory above. Ask before expanding beyond those locations.",
    "Do not read or reveal authentication files, API keys, bearer tokens, or other secrets unless the user explicitly asks for the exact secret-bearing operation.",
    "Keep progress updates concise, use tools only when they materially advance the task, and verify changes before reporting completion.",
  ].join("\n");
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
function isCompletedMediaHandoff(event: PiEvent): boolean {
  if (event.type !== "tool_execution_end" || event.isError || !MEDIA_TOOLS.has(event.toolName)) return false;
  if (!event.result || typeof event.result !== "object") return false;
  const details = "details" in event.result ? event.result.details : undefined;
  return Boolean(details && typeof details === "object" && "mediaJobId" in details && typeof details.mediaJobId === "string" && details.mediaJobId);
}
function piFailure(event: PiEvent): Error | undefined { return event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error" ? new Error(event.message.errorMessage ?? "Pi model request failed") : undefined; }
function formatPrompt(request: AgentRunRequest, initialDelegationInstruction?: string): string {
  const mediaCommand = request.mediaCommand;
  if (!mediaCommand) {
    const transcript = request.messages.map((message) => `${message.role.toUpperCase()}: ${extractTextFromContent(message.content)}`).join("\n\n");
    return initialDelegationInstruction ? [initialDelegationInstruction, transcript].join("\n\n") : transcript;
  }
  // A media command run exposes exactly one tool (`generate_<modality>`, see the
  // activeTools allowlist above), and the host no longer forces tool_choice because
  // thinking-mode providers reject it. Rewrite the command into an explicit tool-call
  // instruction so the model deterministically invokes the media tool instead of
  // answering in prose. An empty prompt (bare `/video` + Enter) gets a default so the
  // media tool's required prompt field is always populated.
  const toolName = `generate_${mediaCommand}`;
  return request.messages.map((message, index) => {
    const text = extractTextFromContent(message.content);
    if (index !== request.messages.length - 1) return `${message.role.toUpperCase()}: ${text}`;
    const prompt = stripMediaCommandPrefix(text) || DEFAULT_MEDIA_PROMPTS[mediaCommand];
    if (mediaCommand === "audio") {
      return `USER: The user issued the /audio music command. Call generate_audio immediately and reply with nothing but the tool call.

Before constructing its arguments:
- Rewrite a casual idea into a detailed production caption covering genre, tempo/BPM, mood, vocals, instrumentation, arrangement, and production style. Do not merely copy a vague request.
- If the request says "song about", implies singing/vocals, or otherwise names a lyrical topic, write concise original lyrics about that topic using [Intro], [Verse], [Chorus], [Bridge], and [Outro] where useful.
- If the request is clearly instrumental, omit lyrics. Never invent vocals for an instrumental request.
- If the user supplied lyrics, preserve them verbatim.
- Preserve an explicit maximum duration in duration_seconds. Music 3 may end naturally before that ceiling, so create enough arrangement and lyrics to fill most of the requested window.

User's music brief:

${prompt}`;
    }
    return `USER: The user issued the /${mediaCommand} media command. Call the ${toolName} tool immediately with the following prompt, and reply with nothing but the tool call:\n\n${prompt}`;
  }).join("\n\n");
}

const DEFAULT_MEDIA_PROMPTS: Record<MediaModality, string> = {
  image: "a vivid, detailed image",
  video: "a short video clip",
  audio: "a short audio clip",
};

function stripMediaCommandPrefix(text: string): string {
  return text.replace(/^\/(?:video|audio|image)(?:\s|$)/i, "").trim();
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
