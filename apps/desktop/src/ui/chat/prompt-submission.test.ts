// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptSubmissionController, type PromptSubmissionOptions } from "./prompt-submission.js";

function setup(overrides: Partial<PromptSubmissionOptions> = {}) {
  const row = document.createElement("div");
  document.body.append(row);
  const options: PromptSubmissionOptions = {
    draft: () => ({ content: "build it" }), consumeAttachments: () => [], sessionId: () => "session-1",
    settings: () => ({ routeId: "smart", maxTokens: 8192, temperature: 0.4, accessMode: "full" }),
    ensureSession: vi.fn(async () => "session-1"), openNewChat: vi.fn(), clearDraft: vi.fn(), setDraft: vi.fn(), resetWarmup: vi.fn(),
    uploadAttachment: vi.fn(async () => ({ id: "artifact-1" })), clearLanding: vi.fn(), appendUser: vi.fn(), appendSteer: vi.fn(() => row),
    pushHistory: vi.fn(), addTokenEstimate: vi.fn(), refreshContext: vi.fn(), refreshControls: vi.fn(), runId: () => "run-1",
    startRun: vi.fn(async () => undefined), steerRun: vi.fn(async () => undefined), showError: vi.fn(), errorMessage: (error) => String(error),
    ...overrides,
  };
  return { controller: new PromptSubmissionController(options), options, row };
}

beforeEach(() => document.body.replaceChildren());

describe("PromptSubmissionController", () => {
  it("creates a session and submits pasted images as multimodal content", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "shot.png" };
    const { controller, options } = setup({ sessionId: () => undefined, consumeAttachments: () => [attachment] });
    await controller.submit("Build a dashboard\nwith charts");
    expect(options.ensureSession).toHaveBeenCalledWith("Build a dashboard", "smart");
    expect(options.uploadAttachment).toHaveBeenCalledWith("session-1", attachment);
    expect(options.startRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      messages: [{ role: "user", content: [{ type: "text", text: "Build a dashboard\nwith charts" }, { type: "image_url", image_url: { url: "/api/v1/artifacts/artifact-1" } }] }],
    }));
    expect(options.appendUser).toHaveBeenCalledWith("Build a dashboard\nwith charts");
  });

  it("restores a steering draft when the active run rejects it", async () => {
    const { controller, options, row } = setup({ steerRun: vi.fn(async () => { throw new Error("finished"); }) });
    await controller.steer("one more thing");
    expect(options.appendSteer).toHaveBeenCalledWith("one more thing");
    expect(row.isConnected).toBe(false);
    expect(options.setDraft).toHaveBeenCalledWith("one more thing");
  });

  it("preserves an explicit media command and forwards deterministic modality metadata", async () => {
    const { controller, options } = setup({ draft: () => ({ content: "a cat with a hat", mediaCommand: "video" }) });
    await controller.submit();
    expect(options.appendUser).toHaveBeenCalledWith("/video a cat with a hat");
    expect(options.pushHistory).toHaveBeenCalledWith("/video a cat with a hat");
    expect(options.startRun).toHaveBeenCalledWith(expect.objectContaining({
      mediaCommand: "video",
      messages: [{ role: "user", content: "/video a cat with a hat" }],
    }));
  });

  it("does nothing for empty submissions without attachments", async () => {
    const { controller, options } = setup({ draft: () => ({ content: "   " }) });
    await controller.submit();
    expect(options.startRun).not.toHaveBeenCalled();
  });
});
