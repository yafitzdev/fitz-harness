// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunRecoveryView } from "./run-recovery-view.js";

beforeEach(() => document.body.replaceChildren());

describe("RunRecoveryView", () => {
  it("keeps the interruption boundary disabled until continuation succeeds", async () => {
    const messages = document.createElement("main");
    let accepted!: () => void;
    let complete!: () => void;
    const resume = vi.fn((_runId: string, _confirmUnsafe: boolean, onAccepted: () => void) => {
      accepted = onAccepted;
      return new Promise<void>((resolve) => { complete = resolve; });
    });
    const view = new RunRecoveryView({ messages, resume });
    view.show({ id: "run-1", checkpoint: { resumeSafety: "safe" } });

    (messages.querySelector("button") as HTMLButtonElement).click();

    expect(resume).toHaveBeenCalledWith("run-1", false, expect.any(Function));
    expect(messages.querySelector(".run-recovery")).not.toBeNull();
    expect(messages.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    accepted();
    expect(messages.querySelector(".run-recovery")).toBeNull();
    complete();
  });

  it("restores the retry control when continuation fails", async () => {
    const messages = document.createElement("main");
    const view = new RunRecoveryView({ messages, resume: vi.fn(async () => { throw new Error("offline"); }) });
    view.show({ id: "run-1", checkpoint: { resumeSafety: "safe" } });

    (messages.querySelector("button") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(messages.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false));
    expect(messages.querySelector(".run-recovery")).not.toBeNull();
    expect(messages.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Continue");
  });
});
