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
  return { model: "default", effort: "normal", max_tokens: 2048, temperature: 0.2, sessionId: "session-1", accessMode: "full", messages: [{ role: "user", content: "hello" }] };
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
    recalibrateEstimate: vi.fn(),
    setStatus: vi.fn(),
    setEngineState: vi.fn(),
    refreshControls: vi.fn(),
    refreshQueue: vi.fn(),
    showStatus: vi.fn(),
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
    expect(api).toHaveBeenNthCalledWith(1, "/api/v1/agent/runs", "POST", expect.objectContaining({ ...request(), clientRequestId: expect.any(String) }));
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

  it("shows the model loading phase while a cold chat start is waiting", async () => {
    let replays = 0;
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/agent/runs") return { data: { id: "run-loading" } };
      if (path === "/api/v1/management/status") return { engine: { state: "LOADING" } };
      replays += 1;
      return replays === 1
        ? { events: [{ sequence: 1, type: "run.started", data: {} }] }
        : { events: [{ sequence: 2, type: "run.completed", data: {} }] };
    });
    const { controller, activity, calls } = setup(api);

    await controller.start(request());

    expect(calls.setEngineState).toHaveBeenCalledWith("LOADING");
    expect(calls.setStatus).toHaveBeenCalledWith("Loading model", "loading");
    expect(activity.timeline.setRun).toHaveBeenCalledWith(activity.activity, "Loading model", expect.any(Number));
  });

  it("retries run creation with the same client request identity", async () => {
    vi.useFakeTimers();
    let creations = 0;
    const api = vi.fn(async (path: string) => {
      if (path === "/api/v1/agent/runs") {
        creations += 1;
        if (creations === 1) throw new Error("response lost");
        return { data: { id: "run-recovered" } };
      }
      return { events: [{ sequence: 1, type: "run.completed", data: {} }] };
    });
    const { controller } = setup(api);
    const started = controller.start(request());
    await vi.runAllTimersAsync();
    await started;
    const creationBodies = api.mock.calls.filter(([path]) => path === "/api/v1/agent/runs").map(([, , body]) => body as AgentRunRequest);
    expect(creationBodies).toHaveLength(2);
    expect(creationBodies[0]?.clientRequestId).toBe(creationBodies[1]?.clientRequestId);
  });

  it("reattaches to a live persisted run after the restored transcript sequence", async () => {
    const api = vi.fn(async () => ({ events: [
      { sequence: 8, type: "assistant.delta", data: { text: "continued" } },
      { sequence: 9, type: "run.completed", data: {} },
    ] }));
    const { controller, calls } = setup(api);
    await controller.attach({ id: "run-live", createdAt: new Date(0).toISOString() }, 7);
    expect(api).toHaveBeenCalledWith("/api/v1/agent/runs/run-live/events?after=7");
    expect(calls.appendAssistantDelta).toHaveBeenCalledWith(expect.any(HTMLElement), "continued");
    expect(calls.setStatus).toHaveBeenLastCalledWith("Ready", "idle");
  });

  it("continues a failed run through the durable resume endpoint", async () => {
    const api = vi.fn(async (path: string, method?: string) => path.endsWith("/resume") && method === "POST"
      ? { data: { id: "run-successor" } }
      : { events: [{ sequence: 1, type: "run.completed", data: {} }] });
    const { controller } = setup(api);
    await controller.resume("run-failed", true);
    expect(api).toHaveBeenNthCalledWith(1, "/api/v1/agent/runs/run-failed/resume", "POST", { confirmUnsafe: true });
    expect(api).toHaveBeenNthCalledWith(2, "/api/v1/agent/runs/run-successor/events?after=0");
  });

  it("keeps continuation retryable when the resume request fails", async () => {
    const api = vi.fn(async () => { throw new Error("offline"); });
    const { controller, calls } = setup(api);
    await expect(controller.resume("run-failed")).rejects.toThrow("offline");
    expect(calls.setStatus).toHaveBeenLastCalledWith("Resume failed", "error");
    expect(controller.active).toBe(false);
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

  it("hands asynchronous media jobs to the media lifecycle tracker", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-media" } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "tool.started", data: { toolName: "generate_image", toolCallId: "tool-media", input: { prompt: "dog" } } },
        { sequence: 3, type: "tool.completed", data: { toolCallId: "tool-media", result: { content: [], details: { mediaJobId: "job-image" } } } },
        { sequence: 4, type: "run.completed", data: {} },
      ] });
    const onMediaJobSubmitted = vi.fn();
    const appendSystem = vi.fn();
    const activity = activityMock();
    const replacement = new AgentRunController({
      messages: document.createElement("main"), activity: activity.timeline, api,
      appendAssistant: () => document.createElement("div"), appendAssistantDelta: vi.fn(), appendSystem, appendChangeSummary: vi.fn(),
      addTokenEstimate: vi.fn(), recalibrateEstimate: vi.fn(), setStatus: vi.fn(), setEngineState: vi.fn(), refreshControls: vi.fn(),
      queueVisible: () => false, refreshQueue: vi.fn(), showStatus: vi.fn(), errorMessage: String, terminalReplayError: () => false,
      onMediaJobSubmitted,
    });

    await replacement.start(request());

    expect(onMediaJobSubmitted).toHaveBeenCalledWith("job-image", "generate_image");
    expect(appendSystem).not.toHaveBeenCalled();
    expect(activity.timeline.finishWork).not.toHaveBeenCalled();
  });

  it("warms local Default once and never probes cloud Smart", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => ({ data: {} }));
    const { controller } = setup(api);

    controller.scheduleWarmup("h", "default");
    controller.scheduleWarmup("he", "default");
    await vi.advanceTimersByTimeAsync(120);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/api/v1/inference/warm", "POST", { model: "default" });

    controller.resetWarmup();
    controller.scheduleWarmup("x", "smart");
    await vi.advanceTimersByTimeAsync(120);
    expect(api).toHaveBeenCalledTimes(1);
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

  it("counts reasoning, tool input, and tool results toward the context estimate", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-tokens" } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "reasoning.delta", data: { text: "plan" } },
        { sequence: 3, type: "tool.started", data: { toolName: "read", toolCallId: "tool-1", input: { path: "a.txt" } } },
        { sequence: 4, type: "tool.completed", data: { toolCallId: "tool-1", result: "file contents here", isError: false } },
        { sequence: 5, type: "assistant.delta", data: { text: "done" } },
        { sequence: 6, type: "run.completed", data: {} },
      ] });
    const { controller, calls } = setup(api);

    await controller.start(request());

    expect(calls.addTokenEstimate).toHaveBeenCalledWith("plan");
    expect(calls.addTokenEstimate).toHaveBeenCalledWith('{"path":"a.txt"}');
    expect(calls.addTokenEstimate).toHaveBeenCalledWith("file contents here");
    expect(calls.addTokenEstimate).toHaveBeenCalledWith("done");
  });

  it("recalibrates the context estimate when the run starts compacted", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-compacted" }, context: { compacted: true, estimatedContextTokens: 512 } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "run.completed", data: {} },
      ] });
    const { controller, calls } = setup(api);

    await controller.start(request());

    expect(calls.recalibrateEstimate).toHaveBeenCalledWith(512);
  });

  it("does not recalibrate when a run starts without a compaction", async () => {
    const api = vi.fn(async (path: string) => path === "/api/v1/agent/runs"
      ? { data: { id: "run-plain" }, context: { compacted: false } }
      : { events: [
        { sequence: 1, type: "run.started", data: {} },
        { sequence: 2, type: "run.completed", data: {} },
      ] });
    const { controller, calls } = setup(api);

    await controller.start(request());

    expect(calls.recalibrateEstimate).not.toHaveBeenCalled();
  });
});
