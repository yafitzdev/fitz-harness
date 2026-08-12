import type { AgentRunRequest } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { describe, expect, it, vi } from "vitest";
import { createSubagentTool, isDelegatedToolContext, SUBAGENT_ROUTES } from "./subagent-tools.js";

describe("subagent tool", () => {
  it("pins every role to the configurable internal route", () => {
    expect(SUBAGENT_ROUTES).toEqual({ worker: "subagent", reviewer: "subagent", researcher: "subagent" });
  });

  it("recognizes delegated runs when an older runtime context only carries runId", () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createAgentRun(
      { id: "child", routeId: "default", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 },
      { model: "default", delegation: { role: "reviewer", parentRunId: "parent", toolCallBudget: 16 }, messages: [{ role: "user", content: "review" }] },
    );

    expect(isDelegatedToolContext(store, { runId: "child" })).toBe(true);
    expect(isDelegatedToolContext(store, { runId: "missing" })).toBe(false);
    expect(isDelegatedToolContext(store, {})).toBe(false);
    store.close();
  });

  it("runs a worker on the subagent route with a durable parent correlation", async () => {
    const store = SqliteStore.memory();
    const parentRequest: AgentRunRequest = { model: "default", sessionId: "session-1", messages: [{ role: "user", content: "build it" }] };
    store.createSession({ id: "session-1", title: "Subagent test", status: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    store.createAgentRun({ id: "parent", routeId: "default", ownerUserId: "owner", sessionId: "session-1", status: "running", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastSequence: 0 }, parentRequest);
    const runSubagent = vi.fn(async () => ({
      run: { id: "child", routeId: "subagent", ownerUserId: "owner", status: "completed" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lastSequence: 3 },
      text: "Implemented and tested.",
    }));
    const tool = createSubagentTool({ agentRuns: { runSubagent } as never, store }, { runId: "parent" });

    const result = await tool.execute("call-1", { role: "worker", task: "Implement the parser", relevant_paths: ["src/parser.ts"] }, undefined, undefined, {} as never);

    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "parent",
      role: "worker",
      ownerUserId: "owner",
      request: expect.objectContaining({ model: "subagent", accessMode: "full", maxTokens: 10_000 }),
      toolCallBudget: 40,
    }));
    expect(result.content[0]).toMatchObject({ type: "text", text: "Implemented and tested." });
    expect(result.details).toEqual(expect.objectContaining({ subagentRunId: "child", role: "worker", routeId: "subagent" }));
    expect(tool.executionMode).toBe("parallel");
    store.close();
  });

  it("allows only one researcher in a normal parent turn and applies the compact budget", async () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createAgentRun(
      { id: "parent", routeId: "default", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 },
      { model: "default", messages: [{ role: "user", content: "get familiar with the project. use subagents" }] },
    );
    const runSubagent = vi.fn(async () => ({
      run: { id: `child-${runSubagent.mock.calls.length}`, routeId: "subagent", status: "completed" as const, createdAt: now, updatedAt: now, lastSequence: 3 },
      text: "Research complete.",
    }));
    const tool = createSubagentTool({ agentRuns: { runSubagent } as never, store }, { runId: "parent" });

    await tool.execute("call-1", { role: "researcher", task: "Read the key project sources" }, undefined, undefined, {} as never);
    await expect(tool.execute("call-2", { role: "researcher", task: "Now scan the implementation" }, undefined, undefined, {} as never)).rejects.toThrow("already used its researcher");

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      toolCallBudget: 20,
      request: expect.objectContaining({ model: "subagent", accessMode: "read-only", maxTokens: 4_096 }),
    }));
    store.close();
  });

  it("allows multiple researchers only when the user explicitly requests exhaustive research", async () => {
    const store = SqliteStore.memory();
    const now = new Date(0).toISOString();
    store.createAgentRun(
      { id: "parent", routeId: "default", status: "running", createdAt: now, updatedAt: now, lastSequence: 0 },
      { model: "default", messages: [{ role: "user", content: "Do an exhaustive investigation with multiple researchers" }] },
    );
    const runSubagent = vi.fn(async () => ({ run: { id: "child", routeId: "default", status: "completed" as const, createdAt: now, updatedAt: now, lastSequence: 3 }, text: "done" }));
    const tool = createSubagentTool({ agentRuns: { runSubagent } as never, store }, { runId: "parent" });

    await tool.execute("call-1", { role: "researcher", task: "Research A" }, undefined, undefined, {} as never);
    await tool.execute("call-2", { role: "researcher", task: "Research B" }, undefined, undefined, {} as never);

    expect(runSubagent).toHaveBeenCalledTimes(2);
    store.close();
  });
});
