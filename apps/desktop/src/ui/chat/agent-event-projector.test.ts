// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { AgentEventProjector, type AgentEventProjectorOptions, type AgentRunActivity } from "./agent-event-projector.js";

function setup(overrides: Partial<AgentEventProjectorOptions> = {}) {
  const messages = document.createElement("main");
  const activityRoot = document.createElement("div");
  const assistant = document.createElement("article");
  const reasoning = document.createElement("div");
  const approval = document.createElement("section");
  const tool = document.createElement("div");
  tool.dataset.toolCallId = "restored-tool";
  tool.dataset.toolName = "read";
  const activity: AgentRunActivity = {
    appendRun: vi.fn(() => activityRoot),
    setRun: vi.fn(),
    appendContext: vi.fn(() => document.createElement("div")),
    markAssistantAsCommentary: vi.fn(),
    appendReasoning: vi.fn(() => reasoning),
    appendReasoningDelta: vi.fn(),
    completeReasoning: vi.fn(),
    appendApproval: vi.fn(() => approval),
    resolveApproval: vi.fn(),
    appendTool: vi.fn(() => tool),
    completeTool: vi.fn(),
    finishWork: vi.fn(),
  };
  const calls = {
    appendAssistant: vi.fn(() => assistant),
    appendAssistantDelta: vi.fn(),
    replaceAssistant: vi.fn(),
    appendSystem: vi.fn(),
    appendChangeSummary: vi.fn(),
    addTokenEstimate: vi.fn(),
    setStatus: vi.fn(),
    setEngineState: vi.fn(),
    updatePlan: vi.fn(),
    clearPlan: vi.fn(),
    findApproval: vi.fn(() => undefined),
    findTool: vi.fn(() => undefined),
    onMediaJobSubmitted: vi.fn(),
    yieldToPaint: vi.fn(async () => undefined),
  };
  const options: AgentEventProjectorOptions = {
    runId: "run-1",
    startedAt: 100,
    activityRoot,
    messages,
    activity,
    ...calls,
    ...overrides,
  };
  return { projector: new AgentEventProjector(options), activity, activityRoot, assistant, reasoning, approval, tool, calls, messages };
}

describe("AgentEventProjector", () => {
  it("projects queue, native reasoning, steering, and assistant output as one state machine", async () => {
    const { projector, activity, assistant, reasoning, calls } = setup();

    await projector.apply({ sequence: 1, type: "run.queue.updated", data: { status: "queued", position: 2 } });
    expect(projector.queued).toBe(true);
    await projector.apply({ sequence: 2, type: "run.started", data: {} });
    expect(projector.queued).toBe(false);
    await projector.apply({ sequence: 3, type: "reasoning.delta", data: { text: "Plan " } });
    await projector.apply({ sequence: 4, type: "reasoning.delta", data: { text: "first." } });
    await projector.apply({ sequence: 5, type: "reasoning.completed", data: {} });
    await projector.apply({ sequence: 6, type: "assistant.delta", data: { text: "Done" } });

    expect(activity.setRun).toHaveBeenCalledWith(expect.any(HTMLElement), "Queued · 1 ahead", 100);
    expect(activity.appendReasoningDelta).toHaveBeenNthCalledWith(1, reasoning, "Plan ");
    expect(activity.appendReasoningDelta).toHaveBeenNthCalledWith(2, reasoning, "first.");
    expect(activity.completeReasoning).toHaveBeenCalledWith(reasoning);
    expect(calls.appendAssistantDelta).toHaveBeenCalledWith(assistant, "Done");
    expect(projector.hasOpenOutput).toBe(true);
  });

  it("keeps plan calls out of the tool feed and tracks changed files for completion", async () => {
    const { projector, activity, calls } = setup();
    const plan = { details: { plan: { revision: 3, items: [] } } };

    await projector.apply({ sequence: 1, type: "tool.started", data: { toolName: "agent_plan", toolCallId: "plan-1", input: { action: "update" } } });
    await projector.apply({ sequence: 2, type: "tool.completed", data: { toolCallId: "plan-1", result: plan } });
    await projector.apply({ sequence: 3, type: "tool.started", data: { toolName: "write", toolCallId: "write-1", input: { path: "src/new.ts" } } });
    await projector.apply({ sequence: 4, type: "tool.completed", data: { toolCallId: "write-1", result: "ok", isError: false } });
    await projector.apply({ sequence: 5, type: "run.completed", data: {} });

    expect(activity.appendTool).toHaveBeenCalledWith("write", { path: "src/new.ts" }, "write-1", true);
    expect(calls.updatePlan).toHaveBeenCalledWith(plan);
    expect(calls.appendChangeSummary).toHaveBeenCalledWith([{ path: "src/new.ts", action: "created" }]);
    expect(activity.finishWork).toHaveBeenCalledOnce();
    expect(projector.done).toBe(true);
  });

  it("reconciles a durable final answer and ignores events after terminal state", async () => {
    const loadFinalAssistant = vi.fn(async () => ({ text: "Durable answer", createdAt: "now" }));
    const { projector, calls, assistant } = setup({ loadFinalAssistant });

    await projector.apply({ sequence: 1, type: "run.completed", data: {} });
    await projector.apply({ sequence: 2, type: "assistant.delta", data: { text: "late event" } });

    expect(loadFinalAssistant).toHaveBeenCalledWith("run-1");
    expect(calls.appendAssistant).toHaveBeenCalledWith("run-1", "now");
    expect(calls.appendAssistantDelta).toHaveBeenCalledWith(assistant, "Durable answer");
    expect(calls.clearPlan).toHaveBeenCalledOnce();
    expect(calls.appendAssistantDelta).toHaveBeenCalledTimes(1);
  });

  it("resolves restored approvals and tools, and hands media jobs to their lifecycle", async () => {
    const { projector, activity, calls, messages, tool } = setup();
    const restoredApproval = document.createElement("section");
    restoredApproval.dataset.approvalId = "approval-1";
    messages.append(restoredApproval);
    calls.findApproval.mockReturnValue(restoredApproval);
    calls.findTool.mockReturnValue({ row: tool, toolName: "read", input: { path: "README.md" } });

    await projector.apply({ sequence: 1, type: "tool.approval.resolved", data: { approvalId: "approval-1", decision: "approved" } });
    await projector.apply({ sequence: 2, type: "tool.completed", data: { toolCallId: "restored-tool", result: "contents", isError: false } });
    calls.findTool.mockReturnValue(undefined);
    await projector.apply({ sequence: 3, type: "tool.completed", data: { toolCallId: "media-1", toolName: "generate_image", result: { details: { mediaJobId: "job-1" } } } });

    expect(activity.resolveApproval).toHaveBeenCalledWith(restoredApproval, "approved");
    expect(activity.completeTool).toHaveBeenCalledWith(tool, "read", { path: "README.md" }, "contents", false);
    expect(calls.onMediaJobSubmitted).toHaveBeenCalledWith("job-1", "generate_image");
    expect(projector.mediaHandedOff).toBe(true);
  });
});
