// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunController, type AgentRunActivity, type AgentRunControllerOptions, type AgentRunRequest } from "./agent-run-controller.js";

function activityMock() {
  const activity = document.createElement("div");
  const tool = document.createElement("div");
  const approval = document.createElement("div");
  const reasoning = document.createElement("div");
  const timeline: AgentRunActivity = {
    appendRun: vi.fn(() => activity),
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
  return { timeline, activity, tool, approval, reasoning };
}

function request(): AgentRunRequest {
  return { model: "default", max_tokens: 2048, temperature: 0.2, sessionId: "session-1", accessMode: "full", messages: [{ role: "user", content: "hello" }] };
}

function setup(api: AgentRunControllerOptions["api"]) {
  const messages = document.createElement("main");
  document.body.append(messages);
  const activity = activityMock();
  const assistant = document.createElement("div");
  const calls = {
    appendAssistant: vi.fn(() => assistant),
    appendAssistantDelta: vi.fn(),
    appendSystem: vi.fn(),
    addTokenEstimate: vi.fn(),
    setStatus: vi.fn(),
    setEngineState: vi.fn(),
    refreshControls: vi.fn(),
    refreshQueue: vi.fn(),
    showToast: vi.fn(),
  };
  const controller = new AgentRunController({
    messages,
    activity: activity.timeline,
    api,
    ...calls,
    queueVisible: () => true,
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    terminalReplayError: () => false,
  });
  return { controller, activity, assistant, calls };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("AgentRunController", () => {
  it("owns submission, streaming, status transitions, and completion", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-1" }, context: { compacted: true } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "assistant.delta", data: { text: "Hello" } },
        { sequence: 3, type: "run.completed", data: {} },
      ] });
    const { controller, activity, assistant, calls } = setup(api);

    await controller.start(request());

    expect(controller.active).toBe(false);
    expect(api).toHaveBeenNthCalledWith(1, "/api/v1/agent/runs", "POST", request());
    expect(api).toHaveBeenNthCalledWith(2, "/api/v1/agent/runs/run-1/events?after=0");
    expect(activity.timeline.appendContext).toHaveBeenCalled();
    expect(calls.appendAssistant).toHaveBeenCalledOnce();
    expect(calls.appendAssistantDelta).toHaveBeenCalledWith(assistant, "Hello");
    expect(calls.addTokenEstimate).toHaveBeenCalledWith("Hello");
    expect(calls.setStatus).toHaveBeenCalledWith("Ready", "idle");
    expect(calls.setEngineState).toHaveBeenLastCalledWith("READY");
    expect(activity.timeline.finishWork).toHaveBeenCalledOnce();
    expect(calls.refreshControls).toHaveBeenCalledTimes(2);
  });

  it("routes tool and approval events through the activity timeline", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-tools" } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "tool.started", data: { toolName: "bash", toolCallId: "tool-1", input: { command: "pwd" } } },
        { sequence: 3, type: "tool.completed", data: { toolCallId: "tool-1", result: "C:/code", isError: false } },
        { sequence: 4, type: "tool.approval.requested", data: { approvalId: "approval-1", toolName: "write", input: { path: "a.txt" } } },
        { sequence: 5, type: "tool.approval.resolved", data: { approvalId: "approval-1", decision: "approved" } },
        { sequence: 6, type: "assistant.delta", data: { text: "Done" } },
        { sequence: 7, type: "run.completed", data: {} },
      ] });
    const { controller, activity, calls } = setup(api);

    await controller.start(request());

    expect(activity.timeline.appendTool).toHaveBeenCalledWith("bash", { command: "pwd" }, "tool-1", true);
    expect(activity.timeline.completeTool).toHaveBeenCalledWith(activity.tool, "bash", { command: "pwd" }, "C:/code", false);
    expect(activity.timeline.appendApproval).toHaveBeenCalledWith(expect.objectContaining({ id: "approval-1", status: "pending" }));
    expect(activity.timeline.resolveApproval).toHaveBeenCalledWith(activity.approval, "approved");
    expect(calls.setStatus).toHaveBeenCalledWith("Waiting for approval", "active");
    expect(activity.timeline.finishWork).toHaveBeenCalledOnce();
  });

  it("warms once after the first character and can be reset for another model", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => ({ data: {} }));
    const { controller } = setup(api);

    controller.scheduleWarmup("h", "fast");
    controller.scheduleWarmup("he", "fast");
    await vi.advanceTimersByTimeAsync(120);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/api/v1/inference/warm", "POST", { model: "fast" });

    controller.resetWarmup();
    controller.scheduleWarmup("x", "smart");
    await vi.advanceTimersByTimeAsync(120);
    expect(api).toHaveBeenLastCalledWith("/api/v1/inference/warm", "POST", { model: "smart" });
  });

  it("remembers cancellation while run creation is still in flight", async () => {
    let resolveStart!: (value: Record<string, unknown>) => void;
    const start = new Promise<Record<string, unknown>>((resolve) => { resolveStart = resolve; });
    const api = vi.fn(async (path: string, method?: string) => {
      if (path === "/api/v1/agent/runs" && method === "POST") return start;
      if (method === "DELETE") return { data: {} };
      return { events: [{ sequence: 1, type: "run.cancelled", data: {} }] };
    });
    const { controller, calls } = setup(api);

    const running = controller.start(request());
    expect(controller.active).toBe(true);
    await controller.cancel();
    resolveStart({ data: { id: "run-late" } });
    await running;

    expect(api).toHaveBeenCalledWith("/api/v1/agent/runs/run-late", "DELETE");
    expect(calls.setStatus).toHaveBeenCalledWith("Stopping", "loading");
    expect(controller.active).toBe(false);
  });

  it("steers the active run through the host endpoint", async () => {
    let resolveEvents!: (value: Record<string, unknown>) => void;
    const events = new Promise<Record<string, unknown>>((resolve) => { resolveEvents = resolve; });
    const api = vi.fn(async (path: string, method?: string) => {
      if (path === "/api/v1/agent/runs" && method === "POST") return { data: { id: "run-1" } };
      if (path.includes("/events")) return events;
      return { data: {} };
    });
    const { controller } = setup(api);

    const starting = controller.start(request());
    await vi.waitFor(() => { expect(controller.runId).toBe("run-1"); });
    await controller.steer("focus on tests");

    expect(api).toHaveBeenCalledWith("/api/v1/agent/runs/run-1/steer", "POST", { text: "focus on tests" });
    resolveEvents({ events: [{ sequence: 1, type: "run.completed", data: {} }] });
    await starting;
    expect(controller.active).toBe(false);
  });

  it("starts a fresh assistant bubble when a steering message is delivered", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-1" } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "assistant.delta", data: { text: "first answer" } },
        { sequence: 3, type: "user.steer", data: { text: "focus on tests" } },
        { sequence: 4, type: "assistant.delta", data: { text: "second answer" } },
        { sequence: 5, type: "run.completed", data: {} },
      ] });
    const { controller, assistant, calls } = setup(api);

    await controller.start(request());

    expect(calls.appendAssistant).toHaveBeenCalledTimes(2);
    expect(calls.appendAssistantDelta).toHaveBeenNthCalledWith(1, assistant, "first answer");
    expect(calls.appendAssistantDelta).toHaveBeenNthCalledWith(2, assistant, "second answer");
  });

  it("streams reasoning into its own activity row and completes it before chat text", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-reason" } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "reasoning.delta", data: { text: "Let me " } },
        { sequence: 3, type: "reasoning.delta", data: { text: "think." } },
        { sequence: 4, type: "reasoning.completed", data: {} },
        { sequence: 5, type: "assistant.delta", data: { text: "Answer" } },
        { sequence: 6, type: "run.completed", data: {} },
      ] });
    const { controller, activity, assistant, calls } = setup(api);

    await controller.start(request());

    expect(activity.timeline.appendReasoning).toHaveBeenCalledWith(true);
    expect(activity.timeline.appendReasoningDelta).toHaveBeenNthCalledWith(1, activity.reasoning, "Let me ");
    expect(activity.timeline.appendReasoningDelta).toHaveBeenNthCalledWith(2, activity.reasoning, "think.");
    expect(activity.timeline.completeReasoning).toHaveBeenCalledWith(activity.reasoning);
    expect(calls.appendAssistant).toHaveBeenCalledTimes(1);
    expect(calls.appendAssistantDelta).toHaveBeenCalledWith(assistant, "Answer");
    expect(activity.timeline.finishWork).toHaveBeenCalledOnce();
  });

  it("completes an open reasoning row when a tool call interrupts it", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-interrupt" } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "reasoning.delta", data: { text: "planning" } },
        { sequence: 3, type: "tool.started", data: { toolName: "read", toolCallId: "tool-1", input: { path: "a.txt" } } },
        { sequence: 4, type: "tool.completed", data: { toolCallId: "tool-1", result: "ok", isError: false } },
        { sequence: 5, type: "run.completed", data: {} },
      ] });
    const { controller, activity } = setup(api);

    await controller.start(request());

    expect(activity.timeline.completeReasoning).toHaveBeenCalledWith(activity.reasoning);
  });
});
