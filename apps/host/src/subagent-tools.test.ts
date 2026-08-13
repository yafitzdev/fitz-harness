import type { AgentRunRequest } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { describe, expect, it, vi } from "vitest";
import { createSubagentTool, isDelegatedToolContext, SUBAGENT_EFFORT_BUDGETS, subagentRouteBudget } from "./subagent-tools.js";

const NOW = new Date(0).toISOString();

describe("subagent tool", () => {
  it("defines effort-specific Fast and Smart parent budgets", () => {
    expect(SUBAGENT_EFFORT_BUDGETS).toEqual({
      light: { fast: { fast: 0, smart: 0 }, smart: { fast: 0, smart: 0 } },
      normal: { fast: { fast: 2, smart: 0 }, smart: { fast: 3, smart: 0 } },
      high: { fast: { fast: 3, smart: 0 }, smart: { fast: 3, smart: 1 } },
    });
  });

  it("recognizes delegated runs when an older runtime context only carries runId", () => {
    const store = SqliteStore.memory();
    store.createAgentRun(
      { id: "child", routeId: "fast", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 },
      { model: "fast", delegation: { role: "reviewer", parentRunId: "parent", toolCallBudget: 16 }, messages: [{ role: "user", content: "review" }] },
    );

    expect(isDelegatedToolContext(store, { runId: "child" })).toBe(true);
    expect(isDelegatedToolContext(store, { runId: "missing" })).toBe(false);
    expect(isDelegatedToolContext(store, {})).toBe(false);
    store.close();
  });

  it("runs a worker on the requested Fast route with durable parent correlation", async () => {
    const store = SqliteStore.memory();
    const parentRequest: AgentRunRequest = { model: "fast", sessionId: "session-1", messages: [{ role: "user", content: "build it" }] };
    store.createSession({ id: "session-1", title: "Subagent test", status: "active", createdAt: NOW, updatedAt: NOW });
    store.createAgentRun({ id: "parent", routeId: "fast", ownerUserId: "owner", sessionId: "session-1", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 }, parentRequest);
    const runSubagent = vi.fn(async () => ({
      run: { id: "child", routeId: "fast", ownerUserId: "owner", status: "completed" as const, createdAt: NOW, updatedAt: NOW, lastSequence: 3 },
      text: "Implemented and tested.",
    }));
    const tool = createSubagentTool({ agentRuns: { runSubagent } as never, store }, { runId: "parent" }, SUBAGENT_EFFORT_BUDGETS.normal.fast);

    const result = await tool.execute("call-1", { route: "fast", role: "worker", task: "Implement the parser", relevant_paths: ["src/parser.ts"] }, undefined, undefined, {} as never);

    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "parent",
      role: "worker",
      ownerUserId: "owner",
      request: expect.objectContaining({ model: "fast", accessMode: "full", maxTokens: 10_000 }),
      toolCallBudget: 40,
    }));
    expect(result.content[0]).toMatchObject({ type: "text", text: "Implemented and tested." });
    expect(result.details).toEqual(expect.objectContaining({ subagentRunId: "child", role: "worker", routeId: "fast" }));
    expect(tool.executionMode).toBe("parallel");
    store.close();
  });

  it("allows a Fast parent two Fast children and no Smart children", async () => {
    const store = SqliteStore.memory();
    createParent(store, "fast");
    const runSubagent = successfulRunner();
    const tool = createSubagentTool({ agentRuns: { runSubagent } as never, store }, { runId: "parent" }, SUBAGENT_EFFORT_BUDGETS.normal.fast);

    await tool.execute("call-1", { route: "fast", role: "researcher", task: "Research A" }, undefined, undefined, {} as never);
    await tool.execute("call-2", { route: "fast", role: "researcher", task: "Research B" }, undefined, undefined, {} as never);
    const exhausted = await tool.execute("call-3", { route: "fast", role: "researcher", task: "Research C" }, undefined, undefined, {} as never);
    const unavailable = await tool.execute("call-4", { route: "smart", role: "researcher", task: "Research D", concurrent_parent_task: "Implement the parser" }, undefined, undefined, {} as never);

    expect(runSubagent).toHaveBeenCalledTimes(2);
    expect(runSubagent.mock.calls.map(([call]) => call.request.model)).toEqual(["fast", "fast"]);
    expect(exhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    expect(unavailable.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    store.close();
  });

  it("allows a Smart parent one Smart and three Fast children", async () => {
    const store = SqliteStore.memory();
    createParent(store, "smart");
    const runSubagent = successfulRunner();
    const tool = createSubagentTool({ agentRuns: { runSubagent } as never, store }, { runId: "parent" }, SUBAGENT_EFFORT_BUDGETS.high.smart);

    const declined = await tool.execute("smart-missing-parent", { route: "smart", role: "researcher", task: "Architecture" }, undefined, undefined, {} as never);
    expect(declined.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "missing_concurrent_parent_task" }));
    await tool.execute("smart-1", { route: "smart", role: "researcher", task: "Architecture", concurrent_parent_task: "Inspect the runtime implementation and synthesize the final design" }, undefined, undefined, {} as never);
    for (let index = 1; index <= 3; index += 1) {
      await tool.execute(`fast-${index}`, { route: "fast", role: "researcher", task: `Scope ${index}` }, undefined, undefined, {} as never);
    }
    const smartExhausted = await tool.execute("smart-2", { route: "smart", role: "reviewer", task: "Extra", concurrent_parent_task: "Implement the main change" }, undefined, undefined, {} as never);
    const fastExhausted = await tool.execute("fast-4", { route: "fast", role: "reviewer", task: "Extra" }, undefined, undefined, {} as never);

    expect(runSubagent.mock.calls.map(([call]) => call.request.model)).toEqual(["smart", "fast", "fast", "fast"]);
    expect(runSubagent.mock.calls[0]?.[0].request.messages[0]?.content).toContain("The Smart parent is concurrently handling this separate work");
    expect(smartExhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    expect(fastExhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    store.close();
  });

  it("resolves effort budgets independently from route bindings", () => {
    const store = SqliteStore.memory();
    store.setSetting("consumerCloudRoutes", [
      { ownerUserId: "owner", role: "smart", recipeId: "smart-model", updatedAt: NOW },
    ]);

    expect(subagentRouteBudget(store, "owner", "default", "high")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "fast", "high")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "normal")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "high")).toEqual({ fast: 0, smart: 1 });

    store.setSetting("consumerCloudRoutes", [
      { ownerUserId: "owner", role: "smart", recipeId: "smart-model", updatedAt: NOW },
      { ownerUserId: "owner", role: "fast", recipeId: "fast-model", updatedAt: NOW },
    ]);
    expect(subagentRouteBudget(store, "owner", "fast", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "fast", "normal")).toEqual({ fast: 2, smart: 0 });
    expect(subagentRouteBudget(store, "owner", "smart", "normal")).toEqual({ fast: 3, smart: 0 });
    expect(subagentRouteBudget(store, "owner", "fast", "high")).toEqual({ fast: 3, smart: 0 });
    expect(subagentRouteBudget(store, "owner", "smart", "high")).toEqual({ fast: 3, smart: 1 });
    store.close();
  });
});

function createParent(store: SqliteStore, routeId: "fast" | "smart"): void {
  store.createAgentRun(
    { id: "parent", routeId, status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 },
    { model: routeId, messages: [{ role: "user", content: "get familiar with the project" }] },
  );
}

function successfulRunner() {
  return vi.fn(async (call: { request: { model: string } }) => ({
    run: { id: `child-${call.request.model}-${Math.random()}`, routeId: call.request.model, status: "completed" as const, createdAt: NOW, updatedAt: NOW, lastSequence: 3 },
    text: "Research complete.",
  }));
}
