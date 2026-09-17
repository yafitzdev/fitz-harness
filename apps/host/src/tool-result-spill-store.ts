import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolResultSpillRequest } from "@fitz/agent-pi";

export type SessionWorkspaceResolver = (sessionId: string) => string | undefined;

/** Owns durable, session-scoped storage for complete model tool results. */
export class ToolResultSpillStore {
  constructor(private readonly workspaceForSession: SessionWorkspaceResolver) {}

  async write(request: ToolResultSpillRequest): Promise<{ path: string }> {
    if (!request.sessionId) throw new Error("A session is required to persist an oversized tool result");
    const workspace = this.workspaceForSession(request.sessionId);
    if (!workspace) throw new Error(`Session ${request.sessionId} has no durable workspace`);
    const run = safeSegment(request.runId ?? "untracked");
    const name = `${safeSegment(request.toolName)}-${safeSegment(request.toolCallId)}.txt`;
    const path = join(workspace, ".fitz", "tool-results", run, name);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, serializeToolResult(request.content), "utf8");
    await rename(temporary, path);
    return { path };
  }
}

export function serializeToolResult(content: unknown[]): string {
  return content.map((part) => {
    if (part && typeof part === "object" && "type" in part && "text" in part
      && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
      return (part as { text: string }).text;
    }
    return JSON.stringify(part, null, 2);
  }).join("\n");
}

function safeSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return safe || "result";
}
