// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunRecoveryView } from "./run-recovery-view.js";

beforeEach(() => document.body.replaceChildren());

describe("RunRecoveryView", () => {
  it("removes the interruption boundary immediately when continuation starts", async () => {
    const messages = document.createElement("main");
    let complete!: () => void;
    const resume = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const view = new RunRecoveryView({ messages, resume });
    view.show({ id: "run-1", checkpoint: { resumeSafety: "safe" } });

    (messages.querySelector("button") as HTMLButtonElement).click();

    expect(resume).toHaveBeenCalledWith("run-1", false);
    expect(messages.querySelector(".run-recovery")).toBeNull();
    complete();
  });

  it("does not resurrect the stale interruption boundary when continuation fails", async () => {
    const messages = document.createElement("main");
    const view = new RunRecoveryView({ messages, resume: vi.fn(async () => { throw new Error("offline"); }) });
    view.show({ id: "run-1", checkpoint: { resumeSafety: "safe" } });

    (messages.querySelector("button") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(messages.querySelector(".run-recovery")).toBeNull());
  });
});
