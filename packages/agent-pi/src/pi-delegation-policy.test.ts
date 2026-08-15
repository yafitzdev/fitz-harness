import { describe, expect, it } from "vitest";
import { PiDelegationPolicy, delegatedCompaction } from "./pi-delegation-policy.js";

describe("PiDelegationPolicy", () => {
  it("does not infer mandatory fan-out from the subject of a request", () => {
    const policy = new PiDelegationPolicy(
      { model: "smart", messages: [{ role: "user", content: "Get familiar with this codebase." }] },
      { default: 0, fast: 3, smart: 1 },
    );

    expect(policy.initialRoutes).toEqual([]);
    expect(policy.initialPromptInstruction()).toBeUndefined();
    expect(policy.admissionReason(call("read", "read", { path: "README.md" }))).toBeUndefined();
  });

  it("enforces explicit Fast fan-out without consuming Smart peer capacity", () => {
    const policy = new PiDelegationPolicy(
      { model: "smart", messages: [{ role: "user", content: "Launch two fast researcher subagents." }] },
      { default: 0, fast: 3, smart: 1 },
    );
    expect(policy.initialRoutes).toEqual(["fast", "fast"]);
    expect(policy.admissionReason(call("wrong-route", "subagent", { route: "smart" }))).toContain("2 Fast subagents");
    expect(policy.remainingInitialRoutes()).toEqual(["fast", "fast"]);
    expect(policy.admissionReason(call("fast-1", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.admissionReason(call("fast-2", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.initialFanoutComplete).toBe(true);
    expect(policy.admissionReason(call("smart-early", "subagent", { route: "smart" }))).toContain("concurrent peer");
    const parentRead = call("read-parent", "read", { path: "README.md" });
    expect(policy.admissionReason(parentRead)).toBeUndefined();
    policy.recordAllowedTool(parentRead);
    expect(policy.admissionReason(call("smart-peer", "subagent", { route: "smart" }))).toBeUndefined();
  });

  it("does not make an explicitly requested Smart peer part of initial fan-out", () => {
    const policy = new PiDelegationPolicy(
      { model: "smart", messages: [{ role: "user", content: "Launch one smart subagent for a concurrent task." }] },
      { default: 0, fast: 3, smart: 1 },
    );
    expect(policy.requiresInitialFanout).toBe(false);
    expect(policy.initialRoutes).toEqual([]);
  });

  it("counts each admitted child tool call and blocks calls beyond the budget", () => {
    const policy = new PiDelegationPolicy({
      model: "fast",
      delegation: { role: role(2), parentRunId: "parent" },
      messages: [{ role: "user", content: "Research this area." }],
    }, undefined);

    expect(policy.admissionReason(call("read-1", "read", {}))).toBeUndefined();
    expect(policy.admissionReason(call("read-2", "read", {}))).toBeUndefined();
    expect(policy.admissionReason(call("read-3", "read", {}))).toContain("2-tool budget");
  });

  it("does not let duplicate tool-call ids satisfy initial fan-out twice", () => {
    const policy = new PiDelegationPolicy(
      { model: "fast", messages: [{ role: "user", content: "Launch two researcher subagents." }] },
      { default: 0, fast: 2, smart: 0 },
    );
    expect(policy.admissionReason(call("same", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.admissionReason(call("same", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.initialFanoutComplete).toBe(false);
    expect(policy.retryPrompt()).toContain("1 Fast subagent");
    expect(policy.admissionReason(call("other", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.initialFanoutComplete).toBe(true);
  });

  it("requires two local workers when a Default orchestrator explicitly asks for them", () => {
    const policy = new PiDelegationPolicy(
      { model: "default", messages: [{ role: "user", content: "Use two workers for independent parts of this task." }] },
      { default: 2, fast: 0, smart: 0 },
    );

    expect(policy.initialRoutes).toEqual(["default", "default"]);
    expect(policy.initialPromptInstruction()).toContain("2 local workers");
    expect(policy.admissionReason(call("read-early", "read", { path: "README.md" }))).toContain("Delegation must happen first");
    expect(policy.admissionReason(call("local-1", "subagent", { route: "default" }))).toBeUndefined();
    expect(policy.admissionReason(call("local-2", "subagent", { route: "default" }))).toBeUndefined();
    expect(policy.initialFanoutComplete).toBe(true);
  });

  it("keeps delegated-worker compaction headroom deterministic", () => {
    expect(delegatedCompaction(32_768, 4_096)).toEqual({ reserveTokens: 16_384, keepRecentTokens: 4_096 });
  });
});

function call(toolCallId: string, toolName: string, input: unknown) {
  return { toolCallId, toolName, input };
}

function role(toolCallBudget: number) {
  return {
    id: "researcher", version: 1, displayName: "Researcher", dispatchDescription: "Research",
    systemInstructions: "Investigate", accessMode: "read-only" as const, toolCallBudget,
    maxOutputTokens: 4096, outputContract: "Report findings",
  };
}
