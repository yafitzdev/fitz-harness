import { describe, expect, it } from "vitest";
import { PiDelegationPolicy, delegatedCompaction } from "./pi-delegation-policy.js";

describe("PiDelegationPolicy", () => {
  it("uses Fast children for repository familiarization and releases parent work after fan-out", () => {
    const policy = new PiDelegationPolicy(
      { model: "smart", messages: [{ role: "user", content: "Get familiar with this codebase." }] },
      { fast: 3, smart: 1 },
    );

    expect(policy.initialRoutes).toEqual(["fast", "fast", "fast"]);
    expect(policy.initialPromptInstruction()).toContain("3 Fast subagents");
    expect(policy.initialPromptInstruction()).not.toContain("Smart subagent");
    expect(policy.admissionReason(call("read-early", "read", { path: "README.md" }))).toContain("Delegation must happen first");
    for (let index = 0; index < 3; index += 1) {
      expect(policy.admissionReason(call(`fast-${index}`, "subagent", { route: "fast" }))).toBeUndefined();
    }
    expect(policy.initialFanoutComplete).toBe(true);
    expect(policy.shouldSuppressModelOutput).toBe(false);
    expect(policy.admissionReason(call("smart-early", "subagent", { route: "smart" }))).toContain("concurrent peer");

    const parentRead = call("read-parent", "read", { path: "README.md" });
    expect(policy.admissionReason(parentRead)).toBeUndefined();
    policy.recordAllowedTool(parentRead);
    expect(policy.admissionReason(call("smart-peer", "subagent", { route: "smart" }))).toBeUndefined();
  });

  it("enforces explicit Fast fan-out without consuming Smart peer capacity", () => {
    const policy = new PiDelegationPolicy(
      { model: "smart", messages: [{ role: "user", content: "Launch two fast researcher subagents." }] },
      { fast: 3, smart: 1 },
    );
    expect(policy.initialRoutes).toEqual(["fast", "fast"]);
    expect(policy.admissionReason(call("wrong-route", "subagent", { route: "smart" }))).toContain("2 Fast subagents");
    expect(policy.remainingInitialRoutes()).toEqual(["fast", "fast"]);
  });

  it("does not make an explicitly requested Smart peer part of initial fan-out", () => {
    const policy = new PiDelegationPolicy(
      { model: "smart", messages: [{ role: "user", content: "Launch one smart subagent for a concurrent task." }] },
      { fast: 3, smart: 1 },
    );
    expect(policy.requiresInitialFanout).toBe(false);
    expect(policy.initialRoutes).toEqual([]);
  });

  it("counts each admitted child tool call and emits one budget steering message", () => {
    const policy = new PiDelegationPolicy({
      model: "fast",
      delegation: { role: "researcher", parentRunId: "parent", toolCallBudget: 2 },
      messages: [{ role: "user", content: "Research this area." }],
    }, undefined);

    expect(policy.admissionReason(call("read-1", "read", {}))).toBeUndefined();
    expect(policy.claimBudgetSteer()).toBeUndefined();
    expect(policy.admissionReason(call("read-2", "read", {}))).toBeUndefined();
    expect(policy.claimBudgetSteer()).toContain("2-tool budget");
    expect(policy.claimBudgetSteer()).toBeUndefined();
    expect(policy.admissionReason(call("read-3", "read", {}))).toContain("2-tool budget");
  });

  it("does not let duplicate tool-call ids satisfy initial fan-out twice", () => {
    const policy = new PiDelegationPolicy(
      { model: "fast", messages: [{ role: "user", content: "Launch two researcher subagents." }] },
      { fast: 2, smart: 0 },
    );
    expect(policy.admissionReason(call("same", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.admissionReason(call("same", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.initialFanoutComplete).toBe(false);
    expect(policy.retryPrompt()).toContain("1 Fast subagent");
    expect(policy.admissionReason(call("other", "subagent", { route: "fast" }))).toBeUndefined();
    expect(policy.initialFanoutComplete).toBe(true);
  });

  it("keeps delegated-worker compaction headroom deterministic", () => {
    expect(delegatedCompaction(32_768, 4_096)).toEqual({ reserveTokens: 16_384, keepRecentTokens: 4_096 });
  });
});

function call(toolCallId: string, toolName: string, input: unknown) {
  return { toolCallId, toolName, input };
}
