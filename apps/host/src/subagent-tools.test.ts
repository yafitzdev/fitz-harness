import type { AgentRunRequest } from "@fitz/protocol";
import { SqliteStore } from "@fitz/storage";
import { describe, expect, it, vi } from "vitest";
import { createSubagentTool, isDelegatedToolContext, SUBAGENT_EFFORT_BUDGETS, subagentRouteBudget } from "./subagent-tools.js";

const NOW = new Date(0).toISOString();

describe("subagent tool", () => {
  it("defines effort-specific Fast and Smart parent budgets", () => {
    expect(SUBAGENT_EFFORT_BUDGETS).toEqual({
      light: {
        fast: { default: 0, fast: 0, smart: 0 },
        smart: { default: 0, fast: 0, smart: 0 },
      },
      normal: {
        fast: { default: 0, fast: 3, smart: 0 },
        smart: { default: 0, fast: 3, smart: 0 },
      },
      high: {
        fast: { default: 0, fast: 6, smart: 0 },
        smart: { default: 0, fast: 6, smart: 2 },
      },
    });
  });

  it("recognizes delegated runs when an older runtime context only carries runId", () => {
    const store = SqliteStore.memory();
    store.createAgentRun(
      { id: "child", routeId: "fast", status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 },
      { model: "fast", delegation: { role: roleSnapshot(store, "reviewer"), parentRunId: "parent" }, messages: [{ role: "user", content: "review" }] },
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
    createPlan(store, ["implement-parser"]);
    const launchSubagent = successfulLauncher("child");
    const tool = createSubagentTool({ agentRuns: { launchSubagent, cancel: vi.fn() } as never, store }, { runId: "parent" }, SUBAGENT_EFFORT_BUDGETS.normal.fast);

    const result = await tool.execute("call-1", { route: "fast", role: "implementer", plan_item_id: "implement-parser", relevant_paths: ["src/parser.ts"] }, undefined, undefined, {} as never);

    expect(launchSubagent).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "parent",
      planItemId: "implement-parser",
      role: expect.objectContaining({ id: "implementer", version: 1, systemInstructions: expect.any(String) }),
      ownerUserId: "owner",
      request: expect.objectContaining({
        model: "fast",
        effort: "normal",
        accessMode: "full",
        maxTokens: 10_000,
        messages: [
          expect.objectContaining({ role: "system", content: expect.stringMatching(/implementer@1[\s\S]*preserve unrelated work/) }),
          expect.objectContaining({ role: "user", content: expect.stringContaining("Task implement-parser") }),
        ],
      }),
    }));
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("worker launched") });
    expect(result.details).toEqual(expect.objectContaining({ subagentRunId: "child", roleId: "implementer", roleVersion: 1, routeId: "fast" }));
    expect(tool.executionMode).toBe("parallel");
    store.close();
  });

  it("allows a Medium Fast parent three Fast children and no Smart children", async () => {
    const store = SqliteStore.memory();
    createParent(store, "fast");
    createPlan(store, ["a", "b", "c", "d", "e"]);
    const launchSubagent = successfulLauncher();
    const tool = createSubagentTool({ agentRuns: { launchSubagent, cancel: vi.fn() } as never, store }, { runId: "parent" }, SUBAGENT_EFFORT_BUDGETS.normal.fast);

    await tool.execute("call-1", { route: "fast", role: "researcher", plan_item_id: "a" }, undefined, undefined, {} as never);
    await tool.execute("call-2", { route: "fast", role: "researcher", plan_item_id: "b" }, undefined, undefined, {} as never);
    await tool.execute("call-3", { route: "fast", role: "researcher", plan_item_id: "c" }, undefined, undefined, {} as never);
    const exhausted = await tool.execute("call-4", { route: "fast", role: "researcher", plan_item_id: "d" }, undefined, undefined, {} as never);
    const unavailable = await tool.execute("call-5", { route: "smart", role: "researcher", plan_item_id: "e", concurrent_parent_task: "Implement the parser" }, undefined, undefined, {} as never);

    expect(launchSubagent).toHaveBeenCalledTimes(3);
    expect(launchSubagent.mock.calls.map(([call]) => call.request.model)).toEqual(["fast", "fast", "fast"]);
    expect(exhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    expect(unavailable.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    store.close();
  });

  it("allows a High Smart parent two Smart peers and six Fast workers", async () => {
    const store = SqliteStore.memory();
    createParent(store, "smart");
    createPlan(store, ["smart0", "smart1", "smart2", "smart3", "fast1", "fast2", "fast3", "fast4", "fast5", "fast6", "fast7"]);
    const launchSubagent = successfulLauncher();
    const tool = createSubagentTool({ agentRuns: { launchSubagent, cancel: vi.fn() } as never, store }, { runId: "parent" }, SUBAGENT_EFFORT_BUDGETS.high.smart);

    const declined = await tool.execute("smart-missing-parent", { route: "smart", role: "researcher", plan_item_id: "smart0" }, undefined, undefined, {} as never);
    expect(declined.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "missing_concurrent_parent_task" }));
    await tool.execute("smart-1", { route: "smart", role: "researcher", plan_item_id: "smart1", concurrent_parent_task: "Inspect the runtime implementation and synthesize the final design" }, undefined, undefined, {} as never);
    await tool.execute("smart-2", { route: "smart", role: "reviewer", plan_item_id: "smart2", concurrent_parent_task: "Implement the main change" }, undefined, undefined, {} as never);
    for (let index = 1; index <= 6; index += 1) {
      await tool.execute(`fast-${index}`, { route: "fast", role: "researcher", plan_item_id: `fast${index}` }, undefined, undefined, {} as never);
    }
    const smartExhausted = await tool.execute("smart-3", { route: "smart", role: "reviewer", plan_item_id: "smart3", concurrent_parent_task: "Implement the main change" }, undefined, undefined, {} as never);
    const fastExhausted = await tool.execute("fast-7", { route: "fast", role: "reviewer", plan_item_id: "fast7" }, undefined, undefined, {} as never);

    expect(launchSubagent.mock.calls.map(([call]) => call.request.model)).toEqual(["smart", "smart", "fast", "fast", "fast", "fast", "fast", "fast"]);
    expect(launchSubagent.mock.calls[0]?.[0].request.messages[1]?.content).toContain("The Smart parent is concurrently handling this separate work");
    expect(smartExhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    expect(fastExhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    store.close();
  });

  it("resolves effort budgets independently from route bindings", () => {
    const store = SqliteStore.memory();
    for (const id of ["smart-model", "fast-model"]) {
      store.upsertRecipe({
        id,
        playbookId: "cloud",
        displayName: id,
        adapter: "openai-compatible",
        modelId: id,
        executionClass: "metered_cloud",
        contextTokens: 131_072,
        capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 8 },
        lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
        configuration: {},
      });
    }
    store.setSetting("consumerCloudRoutes", [
      { ownerUserId: "owner", role: "smart", recipeId: "smart-model", updatedAt: NOW },
    ]);

    expect(subagentRouteBudget(store, "owner", "default", "high")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "fast", "high")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "normal")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "high")).toEqual({ default: 0, fast: 0, smart: 2 });

    store.setSetting("consumerCloudRoutes", [
      { ownerUserId: "owner", role: "smart", recipeId: "smart-model", updatedAt: NOW },
      { ownerUserId: "owner", role: "fast", recipeId: "fast-model", updatedAt: NOW },
    ]);
    expect(subagentRouteBudget(store, "owner", "fast", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "fast", "normal")).toEqual({ default: 0, fast: 3, smart: 0 });
    expect(subagentRouteBudget(store, "owner", "smart", "normal")).toEqual({ default: 0, fast: 3, smart: 0 });
    expect(subagentRouteBudget(store, "owner", "fast", "high")).toEqual({ default: 0, fast: 6, smart: 0 });
    expect(subagentRouteBudget(store, "owner", "smart", "high")).toEqual({ default: 0, fast: 6, smart: 2 });
    store.close();
  });

  it("scales same-model local workers from zero to one to the configured maximum", async () => {
    const store = SqliteStore.memory();
    recipeWithLocalWorkers(store);
    createParent(store, "default");
    const launchSubagent = successfulLauncher();
    expect(subagentRouteBudget(store, "owner", "default", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "default", "normal")).toEqual({ default: 1, fast: 0, smart: 0 });
    const budget = subagentRouteBudget(store, "owner", "default", "high");
    expect(budget).toEqual({ default: 2, fast: 0, smart: 0 });
    createPlan(store, ["local1", "local2", "local3"]);
    const tool = createSubagentTool({ agentRuns: { launchSubagent, cancel: vi.fn() } as never, store }, { runId: "parent" }, budget!);

    await tool.execute("local-1", { route: "default", role: "implementer", plan_item_id: "local1" }, undefined, undefined, {} as never);
    await tool.execute("local-2", { route: "default", role: "researcher", plan_item_id: "local2" }, undefined, undefined, {} as never);
    const exhausted = await tool.execute("local-3", { route: "default", role: "reviewer", plan_item_id: "local3" }, undefined, undefined, {} as never);

    expect(launchSubagent.mock.calls.map(([call]) => call.request.model)).toEqual(["default", "default"]);
    expect((tool.parameters.properties as Record<string, { enum?: string[] }>).route?.enum).toEqual(["default"]);
    expect(exhausted.details).toEqual(expect.objectContaining({ status: "not_launched", reason: "budget_exhausted" }));
    store.close();
  });

  it("uses same-model worker policy for a remotely accessed self-hosted route", async () => {
    const store = SqliteStore.memory();
    store.upsertRecipe({
      id: "shared-gpu", playbookId: "remote", displayName: "Shared GPU", adapter: "openai-compatible", modelId: "shared-gpu",
      executionClass: "self_hosted", contextTokens: 196_000,
      capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
      lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 }, configuration: {},
      agentTopology: { sharedContextTokens: 192_000, workers: { count: 2, contextTokens: 48_000 } },
    });
    store.setSetting("consumerConnections", [{
      ownerUserId: "owner", id: "shared", displayName: "Shared", baseUrl: "https://shared.test/v1", authType: "bearer",
      credentialEnv: "FITZ_TEST", template: "openai-compatible", executionClass: "self_hosted", accessClass: "trusted_remote",
      models: [{ modelId: "shared-gpu", recipeId: "shared-gpu" }], mediaModels: [], updatedAt: NOW,
    }]);
    store.setSetting("consumerCloudRoutes", [{ ownerUserId: "owner", role: "smart", recipeId: "shared-gpu", updatedAt: NOW }]);

    expect(subagentRouteBudget(store, "owner", "smart", "light")).toBeUndefined();
    expect(subagentRouteBudget(store, "owner", "smart", "normal")).toEqual({ default: 0, fast: 0, smart: 1 });
    const budget = subagentRouteBudget(store, "owner", "smart", "high");
    expect(budget).toEqual({ default: 0, fast: 0, smart: 2 });
    createParent(store, "smart");
    createPlan(store, ["remote"]);
    const launchSubagent = successfulLauncher();
    const tool = createSubagentTool({ agentRuns: { launchSubagent, cancel: vi.fn() } as never, store, executionClass: "self_hosted" }, { runId: "parent" }, budget!);
    const result = await tool.execute("remote-worker", { route: "smart", role: "researcher", plan_item_id: "remote" }, undefined, undefined, {} as never);
    expect(result.details).toEqual(expect.objectContaining({ status: "running", routeId: "smart" }));
    expect(tool.description).toContain("same configured model");
    store.close();
  });
});

function createParent(store: SqliteStore, routeId: "default" | "fast" | "smart"): void {
  store.createAgentRun(
    { id: "parent", routeId, status: "running", createdAt: NOW, updatedAt: NOW, lastSequence: 0 },
    { model: routeId, messages: [{ role: "user", content: "Complete the requested work." }] },
  );
}

function recipeWithLocalWorkers(store: SqliteStore): void {
  store.upsertRecipe({
    id: "local-orchestrator",
    playbookId: "ninfer",
    displayName: "Local orchestrator",
    adapter: "ninfer",
    modelId: "qwen3.8-27b",
    contextTokens: 262_144,
    capabilities: { chatCompletions: true, streaming: true, toolCalls: true, responseFormat: false, minP: false, maxConcurrentGenerations: 3 },
    lifecycle: { loadPolicy: "onDemand", evictionPolicy: "never", idleTtlSeconds: 0, minimumResidencySeconds: 0 },
    configuration: {},
    agentTopology: { sharedContextTokens: 256_000, workers: { count: 2, contextTokens: 64_000 } },
  });
  store.upsertRoute({ id: "default", displayName: "Local", recipeId: "local-orchestrator", enabled: true, isDefault: true });
}

function roleSnapshot(store: SqliteStore, id: string) {
  const { enabled: _enabled, ...snapshot } = store.getSubagentRole(id)!;
  return snapshot;
}

function successfulLauncher(fixedId?: string) {
  return vi.fn((call: { request: { model: string } }) => {
    const run = { id: fixedId ?? `child-${call.request.model}-${Math.random()}`, routeId: call.request.model, status: "running" as const, createdAt: NOW, updatedAt: NOW, lastSequence: 1 };
    return { run, result: Promise.resolve({ run: { ...run, status: "completed" as const }, text: "Research complete." }) };
  });
}

function createPlan(store: SqliteStore, ids: string[]): void {
  store.saveAgentRunPlan({
    runId: "parent", revision: 1, status: "active", createdAt: NOW, updatedAt: NOW,
    items: [
      ...ids.map((id) => ({ id, task: `Task ${id}`, dependencies: [], owner: "main" as const, workerEligible: true, required: true, status: "pending" as const, attempts: 0 })),
      { id: "main-critical-path", task: "Parent-owned critical path", dependencies: [], owner: "main", workerEligible: false, required: true, status: "pending", attempts: 0 },
    ],
  });
}
