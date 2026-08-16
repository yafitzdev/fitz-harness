import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent } from "@fitz/agent-core";
import { PiTurnOutputState, type PiTurnOutputPlan } from "./pi-turn-output-state.js";

function assistant(text: string): AgentRuntimeEvent { return { type: "assistant.delta", text }; }

function plan(initialPhase: ReturnType<PiTurnOutputPlan["phase"]>, required = true) {
  let phase = initialPhase;
  return {
    value: {
      required: () => required,
      phase: () => phase,
    } satisfies PiTurnOutputPlan,
    setPhase: (next: typeof phase) => { phase = next; },
  };
}

describe("PiTurnOutputState", () => {
  it("emits ordinary assistant output immediately and finalizes it", () => {
    const emit = vi.fn();
    const state = new PiTurnOutputState({ delegated: false, emit, discardAssistantDraft: vi.fn() });

    state.accept(assistant("answer"));

    expect(emit).toHaveBeenCalledWith(assistant("answer"));
    expect(state.sawAssistant).toBe(true);
    expect(state.finish()).toBeUndefined();
    expect(state.phase).toBe("finalized");
  });

  it("discards plan-gated drafts from both output and model context", () => {
    const activePlan = plan("active");
    const emit = vi.fn();
    const discardAssistantDraft = vi.fn();
    const state = new PiTurnOutputState({ plan: activePlan.value, delegated: false, emit, discardAssistantDraft });

    state.accept(assistant("premature"));
    state.settleAfterPrompt();

    expect(emit).not.toHaveBeenCalled();
    expect(discardAssistantDraft).toHaveBeenCalledOnce();
    expect(state.sawAssistant).toBe(false);
    expect(state.phase).toBe("working");
  });

  it("releases a buffered answer only after the plan becomes answerable", () => {
    const activePlan = plan("active");
    const emit = vi.fn();
    const state = new PiTurnOutputState({ plan: activePlan.value, delegated: false, emit, discardAssistantDraft: vi.fn() });
    state.accept(assistant("final"));
    activePlan.setPhase("ready_for_answer");

    state.settleAfterPrompt();

    expect(emit).toHaveBeenCalledWith(assistant("final"));
    expect(state.sawFinalAssistant).toBe(true);
    expect(state.phase).toBe("finalized");
  });

  it("holds an answer across the plan-ready tool and requests Pi abort after success", () => {
    const activePlan = plan("active");
    const emit = vi.fn();
    const state = new PiTurnOutputState({ plan: activePlan.value, delegated: false, emit, discardAssistantDraft: vi.fn() });
    state.accept(assistant("answer before ready call"));
    state.beforeToolStart("plan-1", true);
    activePlan.setPhase("ready_for_answer");

    expect(state.afterToolEnd("plan-1")).toBe(true);
    expect(emit).toHaveBeenCalledWith(assistant("answer before ready call"));
    expect(state.phase).toBe("finalized");
  });

  it("lets optional direct chats answer without creating a plan", () => {
    const optionalPlan = plan("missing", false);
    const emit = vi.fn();
    const state = new PiTurnOutputState({ plan: optionalPlan.value, delegated: false, emit, discardAssistantDraft: vi.fn() });
    state.accept(assistant("direct answer"));

    state.settleAfterPrompt();

    expect(emit).toHaveBeenCalledWith(assistant("direct answer"));
    expect(state.phase).toBe("finalized");
  });

  it("tracks internal prompt echoes and delegated report eligibility mechanically", () => {
    const state = new PiTurnOutputState({ delegated: true, emit: vi.fn(), discardAssistantDraft: vi.fn() });
    state.expectInternalPrompt("worker-report");
    expect(state.consumeInternalUserEcho()).toBe(true);
    expect(state.consumeInternalUserEcho()).toBe(false);

    state.accept(assistant("worker report"));
    expect(state.hasWorkerReportCandidate).toBe(true);
    state.beforeToolStart("tool-1", false);
    expect(state.hasWorkerReportCandidate).toBe(false);
  });

  it("clears an internal prompt marker when Pi omits its user-message echo", () => {
    const state = new PiTurnOutputState({ delegated: false, emit: vi.fn(), discardAssistantDraft: vi.fn() });
    state.expectInternalPrompt("plan");
    state.completeInternalPrompt("plan");

    expect(state.consumeInternalUserEcho()).toBe(false);
  });

  it("allows exactly one terminal owner", () => {
    const state = new PiTurnOutputState({ delegated: false, emit: vi.fn(), discardAssistantDraft: vi.fn() });
    expect(state.beginFailure()).toBe(true);
    expect(state.beginFailure()).toBe(false);
    state.beginMediaHandoff();
    expect(state.phase).toBe("failed");
  });
});
