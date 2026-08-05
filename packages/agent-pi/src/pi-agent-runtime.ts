import type { AgentRuntime, AgentRuntimeEvent, AgentRuntimeRun } from "@fitz/agent-core";
import type { AgentRunRequest, ToolAccessMode } from "@fitz/protocol";
import type { Model } from "@earendil-works/pi-ai/compat";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type PiEvent =
  | { type: "message_start"; message: { role?: string; content?: unknown } }
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string; content?: string } }
  | { type: "message_end"; message: { role?: string; stopReason?: string; errorMessage?: string } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };
/** Pi thinking levels. Maps to the SDK's `ThinkingLevel`; kept local so the runtime boundary stays SDK-free. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PiSession { subscribe(listener: (event: PiEvent) => void): () => void; prompt(text: string): Promise<void>; steer(text: string): Promise<void>; abort(): Promise<void>; dispose(): void }
export interface PiToolCall { toolCallId: string; toolName: string; input: unknown }
export interface PiToolApprovalResult { allowed: boolean; reason?: string }
export interface ToolApprovalHandle { approvalId: string; decision: Promise<"approved" | "denied"> }
export type ToolApprovalRequester = (request: PiToolCall & { sessionId: string }, signal: AbortSignal) => ToolApprovalHandle;
export type PiSessionFactory = (options: {
  cwd: string;
  tools?: readonly string[];
  routeId: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  agentDir: string;
  llmRoot: string;
  thinkingLevel?: ThinkingLevel;
  approveTool: (request: PiToolCall) => Promise<PiToolApprovalResult>;
}) => Promise<PiSession>;
export interface PiAgentRuntimeOptions {
  cwd?: string | ((request: AgentRunRequest) => string);
  tools?: readonly string[];
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  thinkingLevel?: ThinkingLevel;
  createSession?: PiSessionFactory;
  requestToolApproval?: ToolApprovalRequester;
  agentDir?: string;
  llmRoot?: string;
}

const CODING_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  readonly #cwd: string | ((request: AgentRunRequest) => string);
  readonly #tools: readonly string[] | undefined;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #contextWindow: number;
  readonly #thinkingLevel: ThinkingLevel;
  readonly #createSession: PiSessionFactory;
  readonly #requestToolApproval: ToolApprovalRequester | undefined;
  readonly #agentDir: string;
  readonly #llmRoot: string;
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
  }
  run(request: AgentRunRequest, signal?: AbortSignal): AgentRuntimeRun {
    const channel = new EventChannel(); let session: PiSession | undefined; const controller = new AbortController();
    const cancel = () => { controller.abort(); void session?.abort(); }; if (signal) { if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true }); }
    const sessionTask = (async () => {
      const created = await this.#createSession({
        cwd: typeof this.#cwd === "function" ? this.#cwd(request) : this.#cwd,
        ...(this.#tools ? { tools: this.#tools } : {}),
        routeId: request.model,
        baseUrl: this.#baseUrl,
        apiKey: this.#apiKey,
        contextWindow: this.#contextWindow,
        maxTokens: request.maxTokens ?? 16_384,
        agentDir: this.#agentDir,
        llmRoot: this.#llmRoot,
        thinkingLevel: this.#thinkingLevel,
        approveTool: (toolCall) => this.#approveTool(request.accessMode ?? "full", request.sessionId, toolCall, controller.signal, channel),
      }); session = created; if (controller.signal.aborted) { await created.abort(); throw abortError(); }
      return created;
    })();
    void (async () => { try {
      const activeSession = await sessionTask;
      let sawAssistant = false;
      // The first user message_start is the initial prompt; any later one is a steering
      // message Pi has pulled off its steer queue, i.e. the point where the user's text is
      // inserted into the running conversation.
      let sawInitialUserMessage = false;
      const unsubscribe = activeSession.subscribe((event) => {
        const failure = piFailure(event);
        if (failure) { channel.fail(failure); return; }
        if (event.type === "message_start" && event.message?.role === "user") {
          if (!sawInitialUserMessage) { sawInitialUserMessage = true; return; }
          const text = extractTextFromMessageContent(event.message.content);
          if (text) channel.push({ type: "user.steer", text });
          return;
        }
        const translated = translateEvent(event);
        if (translated) { if (translated.type === "assistant.delta") sawAssistant = true; channel.push(translated); }
      }); try {
        await activeSession.prompt(formatPrompt(request));
        if (controller.signal.aborted) throw abortError();
        if (!sawAssistant) throw new Error("Pi agent completed without an assistant response");
        channel.close();
      } finally { unsubscribe(); activeSession.dispose(); }
    } catch (error) { channel.fail(error); } })();
    const steer = async (text: string): Promise<void> => {
      if (controller.signal.aborted) throw abortError();
      const activeSession = await sessionTask;
      await activeSession.steer(text);
    };
    return Object.assign(channel, { cancel, steer });
  }

  async #approveTool(mode: ToolAccessMode, sessionId: string | undefined, toolCall: PiToolCall, signal: AbortSignal, channel: EventChannel): Promise<PiToolApprovalResult> {
    if (mode === "full" || READ_ONLY_TOOLS.has(toolCall.toolName)) return { allowed: true };
    if (mode === "read-only") return { allowed: false, reason: `${toolCall.toolName} is blocked in Read only mode` };
    if (!sessionId || !this.#requestToolApproval) return { allowed: false, reason: "This tool requires approval, but no approval service is available" };
    const handle = this.#requestToolApproval({ ...toolCall, sessionId }, signal);
    channel.push({ type: "tool.approval.requested", approvalId: handle.approvalId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, input: toolCall.input });
    const decision = await handle.decision;
    channel.push({ type: "tool.approval.resolved", approvalId: handle.approvalId, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, decision });
    return decision === "approved" ? { allowed: true } : { allowed: false, reason: `The user denied ${toolCall.toolName}` };
  }
}

async function createSdkSession(options: Parameters<PiSessionFactory>[0]): Promise<PiSession> {
  const sdk = await import("@earendil-works/pi-coding-agent");
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
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      supportsStrictMode: true,
    },
  };
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
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
        pi.on("tool_call", async (event) => {
          const unsafeReason = broadFilesystemScanReason(event.toolName, event.input);
          if (unsafeReason) return { block: true, reason: unsafeReason };
          const decision = await options.approveTool({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
          return decision.allowed ? undefined : { block: true, reason: decision.reason ?? "Tool execution denied" };
        });
      },
    }],
  });
  await resourceLoader.reload();
  const extensionTools = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const enabledTools = [...new Set([...(options.tools ?? CODING_TOOLS), ...extensionTools])];
  const result = await sdk.createAgentSession({
    cwd: options.cwd,
    tools: enabledTools,
    model,
    thinkingLevel: options.thinkingLevel ?? "off",
    modelRuntime,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(options.cwd),
  });
  return result.session as PiSession;
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
function piFailure(event: PiEvent): Error | undefined { return event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error" ? new Error(event.message.errorMessage ?? "Pi model request failed") : undefined; }
function formatPrompt(request: AgentRunRequest): string { return request.messages.map((message) => `${message.role.toUpperCase()}: ${extractTextFromContent(message.content)}`).join("\n\n"); }
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
