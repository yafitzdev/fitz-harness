/**
 * The sandboxed `bash` tool.
 *
 * Replaces the SDK's built-in shell tool with one that runs every command through the
 * host's OS-level containment wrapper (bubblewrap on Linux/WSL2, direct spawn elsewhere).
 * The host supplies the executor; this module owns the tool contract and the output
 * formatting so agent-visible behavior matches the built-in bash tool.
 *
 * The safety policy still evaluates the command BEFORE this tool executes: the SDK's
 * `tool_call` hook rewrites deletes into trash moves and blocks destructive commands,
 * so the executor only ever sees policy-cleared (or policy-rewritten) commands.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The result of running one shell command through the containment wrapper. */
export interface SandboxedBashResult {
  /** Process exit code (0 on success). */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Whether the command actually executed inside the OS-level container. */
  contained: boolean;
}

/** Host-side runner: spawns the command through the containment wrapper. */
export type SandboxedBashExecutor = (input: {
  command: string;
  timeout?: number;
  signal?: AbortSignal;
}) => Promise<SandboxedBashResult>;

/** Matches the SDK's bash tool output limits: last 2000 lines or 50KB, whichever hits first. */
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface TruncatedOutput {
  text: string;
  truncated: boolean;
  startLine: number;
  totalLines: number;
  truncatedBy: "lines" | "bytes";
}

function truncateTail(content: string): TruncatedOutput {
  const lines = content === "" ? [] : content.split("\n");
  if (content.length <= MAX_OUTPUT_BYTES) {
    if (lines.length <= MAX_OUTPUT_LINES) {
      return { text: content, truncated: false, startLine: 1, totalLines: lines.length, truncatedBy: "lines" };
    }
    const kept = lines.slice(-MAX_OUTPUT_LINES);
    return {
      text: kept.join("\n"),
      truncated: true,
      startLine: lines.length - MAX_OUTPUT_LINES + 1,
      totalLines: lines.length,
      truncatedBy: "lines",
    };
  }
  return { text: content.slice(-MAX_OUTPUT_BYTES), truncated: true, startLine: 1, totalLines: lines.length, truncatedBy: "bytes" };
}

function appendTruncationFooter(text: string, trunc: TruncatedOutput): string {
  if (!trunc.truncated) return text;
  if (trunc.truncatedBy === "lines") {
    return `${text}\n\n[Showing lines ${trunc.startLine}-${trunc.totalLines} of ${trunc.totalLines}]`;
  }
  return `${text}\n\n[Truncated: showing the last ${formatSize(MAX_OUTPUT_BYTES)} of output]`;
}

/**
 * The `bash` tool, shadowing the SDK's built-in shell: same name, same parameters,
 * same output contract, but execution goes through the host's containment wrapper.
 * Registered via `customTools` whenever the host supplies a sandbox executor; because
 * custom tools override built-ins of the same name, the agent's shell is always the
 * sandboxed one.
 */
export function createSandboxedBashTool(executor: SandboxedBashExecutor): ToolDefinition {
  const parameters = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  });
  const tool: ToolDefinition<typeof parameters> = {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first). Optionally provide a timeout in seconds. Commands run inside the Fitz safety sandbox: the project workspace, the Fitz runtime dirs, and the temp dirs are writable; everything else is read-only, so destructive commands outside those areas cannot succeed.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: [
      "Prefer relative paths and commands that operate inside the project workspace.",
      "Everything outside the workspace, the Fitz runtime dirs, and the temp dirs is read-only inside the sandbox: do not attempt to delete or modify files there, and prefer fitz.trash for anything inside the workspace the user might want back.",
      "Do not attempt to bypass the sandbox or the safety policy.",
    ],
    parameters,
    execute: async (_toolCallId, params, signal) => {
      let outcome: SandboxedBashResult;
      try {
        outcome = await executor({
          command: params.command,
          ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "aborted") throw new Error("Command aborted");
        const timeoutMatch = /^timeout:(\d+)$/.exec(message);
        if (timeoutMatch) throw new Error(`Command timed out after ${timeoutMatch[1]} seconds`);
        throw error instanceof Error ? error : new Error(String(error));
      }
      const combined = outcome.stdout + (outcome.stderr ? `\n${outcome.stderr}` : "");
      const trunc = truncateTail(combined);
      const text = trunc.truncated ? appendTruncationFooter(trunc.text || "(no output)", trunc) : trunc.text || "(no output)";
      if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
        throw new Error(`${text}\n\nCommand exited with code ${outcome.exitCode}`);
      }
      return toolResult(text, { contained: outcome.contained, exitCode: outcome.exitCode });
    },
  };
  return tool;
}

function toolResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}
