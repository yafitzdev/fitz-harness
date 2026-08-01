import { randomUUID } from "node:crypto";
import type { ToolApprovalRecord } from "@fitz/protocol";
import type { ToolApprovalRequester } from "@fitz/agent-pi";
import type { SqliteStore } from "@fitz/storage";

export function createToolApprovalRequester(store: SqliteStore, pollIntervalMs = 100): ToolApprovalRequester {
  return (request, signal) => {
    const approval: ToolApprovalRecord = {
      id: randomUUID(),
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      status: "pending",
      request: recordRequest(request.input),
      requestedAt: new Date().toISOString(),
    };
    store.createToolApproval(approval);
    return { approvalId: approval.id, decision: waitForDecision(store, approval.id, signal, pollIntervalMs) };
  };
}

async function waitForDecision(store: SqliteStore, approvalId: string, signal: AbortSignal, pollIntervalMs: number): Promise<"approved" | "denied"> {
  try {
    while (!signal.aborted) {
      const approval = store.getToolApproval(approvalId);
      if (!approval || approval.status === "denied" || approval.status === "cancelled") return "denied";
      if (approval.status === "approved") return "approved";
      await abortableDelay(pollIntervalMs, signal);
    }
    throw abortError();
  } catch (error) {
    if (signal.aborted) store.cancelToolApproval(approvalId, "Agent run cancelled");
    throw error;
  }
}

function recordRequest(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", cancelled, { once: true });
    function done(): void { signal.removeEventListener("abort", cancelled); resolve(); }
    function cancelled(): void { clearTimeout(timer); reject(abortError()); }
  });
}

function abortError(): Error { const error = new Error("Tool approval was cancelled"); error.name = "AbortError"; return error; }
