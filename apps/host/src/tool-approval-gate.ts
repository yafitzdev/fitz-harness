import { randomUUID } from "node:crypto";
import { MEDIA_TOOLS, type PiToolCall } from "@fitz/agent-pi";
import type { ToolApprovalRecord } from "@fitz/protocol";
import type { ToolApprovalRequester } from "@fitz/agent-pi";
import type { SqliteStore } from "@fitz/storage";
import { creditCostCentsFor } from "./media-jobs.js";

export function createToolApprovalRequester(store: SqliteStore, pollIntervalMs = 100): ToolApprovalRequester {
  return (request, signal) => {
    const enriched = enrichMediaRequest(store, request);
    const approval: ToolApprovalRecord = {
      id: randomUUID(),
      sessionId: enriched.sessionId,
      toolCallId: enriched.toolCallId,
      toolName: enriched.toolName,
      status: "pending",
      request: recordRequest(enriched.input),
      requestedAt: new Date().toISOString(),
    };
    store.createToolApproval(approval);
    return { approvalId: approval.id, decision: waitForDecision(store, approval.id, signal, pollIntervalMs, request) };
  };
}

/**
 * Media approvals (§5.9) carry an estimated credit cost so the approver sees what the
 * generation is billed at (`recipe.configuration.costCentsPerJob`, in cents). The
 * estimate is display-only: the executed job's ledger entry is whatever the coordinator
 * computes at submit time. The injected field is harmless to non-media tools — they are
 * returned unchanged.
 */
function enrichMediaRequest(store: SqliteStore, request: PiToolCall & { sessionId: string }): PiToolCall & { sessionId: string } {
  if (!MEDIA_TOOLS.has(request.toolName)) return request;
  const input = request.input !== null && typeof request.input === "object" && !Array.isArray(request.input) ? request.input as Record<string, unknown> : undefined;
  const routeId = typeof input?.route_id === "string" && input.route_id ? input.route_id : mediaRouteIdFor(request.toolName);
  const route = store.listRoutes().find((candidate) => candidate.id === routeId);
  const recipe = route ? store.listRecipes().find((candidate) => candidate.id === route.recipeId) : undefined;
  const cost = recipe ? creditCostCentsFor(recipe) : undefined;
  if (cost === undefined) return request;
  return { ...request, input: { ...(input ?? {}), estimated_credit_cost_cents: cost } };
}

/** Well-known media route id for a tool: `generate_image` → "image", etc. */
function mediaRouteIdFor(toolName: string): string {
  return toolName === "generate_video" ? "video" : toolName === "generate_audio" ? "audio" : "image";
}

async function waitForDecision(store: SqliteStore, approvalId: string, signal: AbortSignal, pollIntervalMs: number, toolCall: PiToolCall): Promise<"approved" | "denied"> {
  try {
    while (!signal.aborted) {
      const approval = store.getToolApproval(approvalId);
      if (!approval || approval.status === "denied" || approval.status === "cancelled") return "denied";
      if (approval.status === "approved") {
        applyApprovedMediaRequest(toolCall, approval.request);
        return "approved";
      }
      await abortableDelay(pollIntervalMs, signal);
    }
    throw abortError();
  } catch (error) {
    if (signal.aborted) store.cancelToolApproval(approvalId, "Agent run cancelled");
    throw error;
  }
}

/** Pi executes the same mutable input object after its tool_call hook returns.
 * Apply the host-validated approval edits there so the approved form—not the
 * agent's stale draft—is what the media tool receives. */
function applyApprovedMediaRequest(toolCall: PiToolCall, approved: Readonly<Record<string, unknown>>): void {
  if (!MEDIA_TOOLS.has(toolCall.toolName) || !toolCall.input || typeof toolCall.input !== "object" || Array.isArray(toolCall.input)) return;
  const input = toolCall.input as Record<string, unknown>;
  for (const field of ["prompt", "size", "seed", "negative_prompt", "lyrics", "duration_seconds", "resolution", "fps", "refs"]) delete input[field];
  for (const [field, value] of Object.entries(approved)) {
    if (field !== "estimated_credit_cost_cents") input[field] = value;
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
