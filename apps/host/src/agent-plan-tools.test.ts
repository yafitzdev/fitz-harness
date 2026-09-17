import { SqliteStore } from "@fitz/storage";
import { describe, expect, it } from "vitest";
import { assignPlanItemToWorker, completePlanAfterAnswer, createAgentPlanTool, createAgentRunPlanPolicy, planAdmissionReason, planCompletionIssue, planPromptInstruction, reconcileAgentPlan } from "./agent-plan-tools.js";

const NOW = new Date(0).toISOString();

describe("durable agent plans", () => {
  it("delivers the completed worker report in model-visible plan text", async () => {
    const store = harness();
    try {
      const tool = createAgentPlanTool({ store }, { runId: "parent" });
      await execute(tool, { action: "set", items: [{ id: "research", task: "Inspect the core", worker_eligible: true }, { id: "main", task: "Inspect the interface" }] });
      store.createAgentRun({ id: "child", routeId: "default", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, { model: "default", messages: [] });
      assignPlanItemToWorker(store, "parent", "research", "child");
      store.appendAgentEvent({ protocolVersion: "1", runId: "child", sequence: 1, timestamp: NOW, type: "assistant.delta", data: { text: "Core finding: the compiler drops empty groups." } });
      store.updateAgentRun("child", "completed");
      const status = await execute(tool, { action: "status" });
      expect(status.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("Core finding: the compiler drops empty groups.") })]));
      const ready = await execute(tool, { action: "update", item_id: "main", status: "completed" });
      expect(ready.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("Core finding: the compiler drops empty groups.") }));
    } finally { store.close(); }
  });

  it("allows direct answers and activates planning only when tool work is attempted", () => {
    const store = harness();
    const direct = createAgentRunPlanPolicy(store, "parent");
    expect(planPromptInstruction()).toContain("answered directly without tools");
    expect(direct.required?.()).toBe(false);
    expect(direct.completionIssue()).toBeUndefined();
    expect(direct.admissionReason({ toolCallId: "read", toolName: "read", input: { path: "README.md" } })).toContain("plan");
    expect(direct.required?.()).toBe(true);
    expect(direct.completionIssue()).toContain("execution plan exists");
    store.close();
  });

  it("ships evidence-priority instructions for research workers", () => {
    const store = harness();
    expect(store.getSubagentRole("researcher")?.systemInstructions).toContain("executable source and package manifests outrank design documents");
    store.close();
  });

  it("creates a dependency-aware first-class plan and gates completion", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    await execute(tool, { action: "set", items: [
      { id: "inspect", task: "Inspect the runtime", worker_eligible: true },
      { id: "implement", task: "Implement the change", dependencies: ["inspect"] },
    ] });

    expect(store.getAgentRunPlan("parent")).toEqual(expect.objectContaining({
      status: "active",
      revision: 1,
      items: [expect.objectContaining({ id: "inspect", status: "pending", workerEligible: true }), expect.objectContaining({ id: "implement", dependencies: ["inspect"] })],
    }));
    expect(planCompletionIssue(store, "parent")).toContain("inspect, implement");
    const rejected = await execute(tool, { action: "update", item_id: "implement", status: "running" });
    expect(rejected.details).toEqual(expect.objectContaining({ status: "rejected" }));

    await execute(tool, { action: "update", item_id: "inspect", status: "completed", result: "Runtime inspected" });
    const completed = await execute(tool, { action: "update", item_id: "implement", status: "completed", result: "Implemented" });

    expect(completed.details).toEqual(expect.objectContaining({ status: "ready_for_answer" }));
    expect(store.getAgentRunPlan("parent")?.status).toBe("ready_for_answer");
    expect(planCompletionIssue(store, "parent")).toBeUndefined();
    const revision = store.getAgentRunPlan("parent")?.revision;
    const repeatedReady = await execute(tool, { action: "ready" });
    expect(repeatedReady.details).toEqual(expect.objectContaining({ status: "ready_for_answer" }));
    expect(store.getAgentRunPlan("parent")?.revision).toBe(revision);
    completePlanAfterAnswer(store, "parent");
    expect(store.getAgentRunPlan("parent")?.status).toBe("completed");
    store.close();
  });

  it("stops new substantive work once every required plan item is complete", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    await execute(tool, { action: "set", items: [{ id: "inspect", task: "Inspect the relevant evidence" }] });
    await execute(tool, { action: "update", item_id: "inspect", status: "completed", result: "Enough evidence" });

    expect(store.getAgentRunPlan("parent")?.status).toBe("ready_for_answer");
    expect(planAdmissionReason(store, "parent", { toolName: "read", input: { path: "another-file" } }))
      .toContain("Prerequisite work is complete");
    expect(planAdmissionReason(store, "parent", { toolName: "agent_plan", input: { action: "ready" } }))
      .toBeUndefined();
    store.close();
  });

  it("rejects cyclic plans", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    const result = await execute(tool, { action: "set", items: [
      { id: "a", task: "A", dependencies: ["b"] },
      { id: "b", task: "B", dependencies: ["a"] },
    ] });
    expect(result.details).toEqual(expect.objectContaining({ status: "rejected" }));
    expect(store.getAgentRunPlan("parent")).toBeUndefined();
    store.close();
  });

  it("reassigns failed worker work to the main agent instead of failing the plan", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    await execute(tool, { action: "set", items: [
      { id: "research", task: "Research", worker_eligible: true },
      { id: "main", task: "Inspect the critical path" },
    ] });
    store.createAgentRun({ id: "child", routeId: "fast", status: "failed", error: "worker crashed", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, { model: "fast", messages: [] });
    assignPlanItemToWorker(store, "parent", "research", "child");

    const plan = reconcileAgentPlan(store, "parent");

    expect(plan?.items[0]).toEqual(expect.objectContaining({ id: "research", owner: "main", status: "pending", attempts: 1, error: "worker crashed" }));
    expect(planCompletionIssue(store, "parent")).toContain("research");
    store.close();
  });

  it("opens the answer phase when reconciliation completes the last worker item", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    await execute(tool, { action: "set", items: [
      { id: "research", task: "Research", worker_eligible: true },
      { id: "main", task: "Inspect the critical path" },
    ] });
    store.createAgentRun({ id: "child", routeId: "fast", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, { model: "fast", messages: [] });
    assignPlanItemToWorker(store, "parent", "research", "child");
    await execute(tool, { action: "update", item_id: "main", status: "completed", result: "Critical path complete" });
    expect(store.getAgentRunPlan("parent")?.status).toBe("active");

    store.updateAgentRun("child", "completed");
    const reconciled = reconcileAgentPlan(store, "parent");

    expect(reconciled?.items.find((item) => item.id === "research")?.status).toBe("completed");
    expect(reconciled?.status).toBe("ready_for_answer");
    expect(planCompletionIssue(store, "parent")).toBeUndefined();
    store.close();
  });

  it("cannot complete an explicit-worker request without a durable worker assignment", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store, requiredWorkerRoutes: ["fast"] }, { runId: "parent" });
    await execute(tool, { action: "set", items: [
      { id: "research", task: "Research", worker_eligible: true },
      { id: "main", task: "Own the critical path" },
    ] });
    await execute(tool, { action: "update", item_id: "research", status: "completed", result: "Main did it" });
    const rejected = await execute(tool, { action: "ready" });
    expect(rejected.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("Required workers were not launched: fast") }));

    await execute(tool, { action: "update", item_id: "research", status: "pending" });
    store.createAgentRun({ id: "child", routeId: "fast", status: "completed", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, { model: "fast", messages: [] });
    assignPlanItemToWorker(store, "parent", "research", "child");
    reconcileAgentPlan(store, "parent");
    await execute(tool, { action: "update", item_id: "main", status: "completed", result: "Critical path complete" });
    expect(store.getAgentRunPlan("parent")?.status).toBe("ready_for_answer");
    const repeatedReady = await execute(tool, { action: "ready" });
    expect(repeatedReady.details).toEqual(expect.objectContaining({ status: "ready_for_answer" }));
    store.close();
  });

  it("mechanically rejects waiting while ready main-agent work remains", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    await execute(tool, { action: "set", items: [{ id: "main", task: "Inspect the implementation" }] });
    expect(planAdmissionReason(store, "parent", { toolName: "agent_plan", input: { action: "status", wait_seconds: 30 } }))
      .toContain("main");
    expect(planAdmissionReason(store, "parent", { toolName: "agent_plan", input: { action: "status", wait_seconds: 0 } }))
      .toBeUndefined();
    store.close();
  });

  it("requires observable parent tool work after a worker launch before waiting", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    await execute(tool, { action: "set", items: [
      { id: "research", task: "Research", worker_eligible: true },
      { id: "main", task: "Use the research", dependencies: ["research"] },
    ] });
    store.createAgentRun({ id: "child", routeId: "fast", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, { model: "fast", messages: [] });
    assignPlanItemToWorker(store, "parent", "research", "child");
    store.appendAgentEvent({ protocolVersion: "1", runId: "parent", sequence: 1, timestamp: NOW, type: "tool.started", data: { toolName: "subagent" } });

    expect(planAdmissionReason(store, "parent", { toolName: "agent_plan", input: { action: "status", wait_seconds: 30 } }))
      .toContain("accelerators");
    store.appendAgentEvent({ protocolVersion: "1", runId: "parent", sequence: 2, timestamp: NOW, type: "tool.started", data: { toolName: "read" } });
    expect(planAdmissionReason(store, "parent", { toolName: "agent_plan", input: { action: "status", wait_seconds: 30 } }))
      .toBeUndefined();
    store.close();
  });

  it("requires forced worker plans to retain a main-only critical-path item", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store, requiredWorkerRoutes: ["fast"] }, { runId: "parent" });
    const rejected = await execute(tool, { action: "set", items: [{ id: "research", task: "Research", worker_eligible: true }] });
    expect(rejected.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("main-only") }));
    expect(store.getAgentRunPlan("parent")).toBeUndefined();
    store.close();
  });

  it("rejects explicit final-synthesis items because finalization is runtime-owned", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    const rejected = await execute(tool, { action: "set", items: [
      { id: "research", task: "Inspect the implementation" },
      { id: "synthesis", task: "Synthesize findings into a final answer" },
    ] });
    expect(rejected.details).toEqual(expect.objectContaining({ status: "rejected" }));
    expect(store.getAgentRunPlan("parent")).toBeUndefined();
    store.close();
  });

  it("rejects the summary plan shape that previously trapped the model in final-answer retries", async () => {
    const store = harness();
    const tool = createAgentPlanTool({ store }, { runId: "parent" });
    const rejected = await execute(tool, { action: "set", items: [
      { id: "explore", task: "Inspect the project structure" },
      { id: "summarize", task: "Synthesize a concise orientation of the project" },
    ] });
    expect(rejected.details).toEqual(expect.objectContaining({ status: "rejected" }));
    expect(rejected.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("implicit final-answer phase") }));
    expect(store.getAgentRunPlan("parent")).toBeUndefined();
    store.close();
  });
});

function harness(): SqliteStore {
  const store = SqliteStore.memory();
  store.createAgentRun({ id: "parent", routeId: "default", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, { model: "default", messages: [{ role: "user", content: "work" }] });
  return store;
}

function execute(tool: ReturnType<typeof createAgentPlanTool>, input: Record<string, unknown>) {
  return tool.execute(`call-${Math.random()}`, input as never, undefined, undefined, {} as never);
}
