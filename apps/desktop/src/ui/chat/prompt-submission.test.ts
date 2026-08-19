// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptSubmissionController, type PromptSubmissionOptions } from "./prompt-submission.js";

function setup(overrides: Partial<PromptSubmissionOptions> = {}) {
  const row = document.createElement("div");
  document.body.append(row);
  const options: PromptSubmissionOptions = {
    draft: () => ({ content: "build it" }), peekAttachments: () => [], consumeAttachments: vi.fn(), sessionId: () => "session-1",
    settings: () => ({ routeId: "smart", effort: "high", maxTokens: 8192, temperature: 0.4, accessMode: "full" }),
    ensureSession: vi.fn(async () => "session-1"), openNewChat: vi.fn(), clearDraft: vi.fn(), setDraft: vi.fn(), resetWarmup: vi.fn(),
    uploadAttachment: vi.fn(async () => ({ id: "artifact-1" })), clearLanding: vi.fn(), appendUser: vi.fn(),
    persistUserMessage: vi.fn(async () => undefined), appendSteer: vi.fn(() => row),
    pushHistory: vi.fn(), addTokenEstimate: vi.fn(), refreshContext: vi.fn(), refreshControls: vi.fn(), runId: () => "run-1",
    startRun: vi.fn(async () => undefined), submitMedia: vi.fn(async () => ({ id: "job-1" })), onMediaJobSubmitted: vi.fn(),
    showMediaCreation: vi.fn(),
    steerRun: vi.fn(async () => undefined), showError: vi.fn(), errorMessage: (error) => String(error),
    ...overrides,
  };
  return { controller: new PromptSubmissionController(options), options, row };
}

/** Returns the request captured by the showMediaCreation option. */
function mediaCreationRequest(options: PromptSubmissionOptions) {
  return (options.showMediaCreation as ReturnType<typeof vi.fn>).mock.calls[0]![0];
}

beforeEach(() => document.body.replaceChildren());

describe("PromptSubmissionController", () => {
  it("creates a session and submits pasted images as multimodal content", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "shot.png" };
    const { controller, options } = setup({ sessionId: () => undefined, peekAttachments: () => [attachment] });
    await controller.submit("Build a dashboard\nwith charts");
    expect(options.ensureSession).toHaveBeenCalledWith("Build a dashboard", "smart");
    expect(options.uploadAttachment).toHaveBeenCalledWith("session-1", attachment);
    expect(options.startRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      effort: "high",
      max_tokens: 8192,
      attachments: [{ artifactId: "artifact-1" }],
      messages: [{ role: "user", content: "Build a dashboard\nwith charts" }],
    }));
    expect(options.appendUser).toHaveBeenCalledWith("Build a dashboard\nwith charts", [expect.objectContaining({
      id: "artifact-1", name: "shot.png", mimeType: "image/png", kind: "image", dataUrl: "data:image/png;base64,AAAA",
    })]);
    expect(options.consumeAttachments).toHaveBeenCalledWith([attachment]);
  });

  it("reuses a durable edited turn without consuming unrelated composer attachments", async () => {
    const peekAttachments = vi.fn(() => [{ kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "draft.txt" }]);
    const { controller, options, row } = setup({ peekAttachments });

    await controller.submit("Edited prompt", row, "message-edited");

    expect(peekAttachments).not.toHaveBeenCalled();
    expect(options.consumeAttachments).not.toHaveBeenCalled();
    expect(options.uploadAttachment).not.toHaveBeenCalled();
    expect(options.startRun).toHaveBeenCalledWith(expect.objectContaining({
      persistedMessageId: "message-edited",
      messages: [{ role: "user", content: "Edited prompt" }],
    }));
  });

  it("serializes duplicate submissions while the first chat is materializing", async () => {
    let resolveSession!: (value: string) => void;
    const ensureSession = vi.fn(() => new Promise<string>((resolve) => { resolveSession = resolve; }));
    const peekAttachments = vi.fn(() => []);
    const { controller, options } = setup({ sessionId: () => undefined, ensureSession, peekAttachments });

    const first = controller.submit("Build it");
    const second = controller.submit("Build it");
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(peekAttachments).toHaveBeenCalledOnce();
    resolveSession("session-created");
    await Promise.all([first, second]);

    expect(options.appendUser).toHaveBeenCalledOnce();
    expect(options.startRun).toHaveBeenCalledOnce();
  });

  it("accepts media commands after an admitted chat run while that run is still active", async () => {
    let finishRun!: () => void;
    const startRun = vi.fn(() => new Promise<void>((resolve) => { finishRun = resolve; }));
    const { controller, options } = setup({ startRun });

    const activeRun = controller.submit("Build it");
    expect(startRun).toHaveBeenCalledOnce();
    await controller.submit({ content: "a slow orbit", mediaCommand: "video" });

    expect(options.showMediaCreation).toHaveBeenCalledOnce();
    finishRun();
    await activeRun;
  });

  it("restores a steering draft when the active run rejects it", async () => {
    const { controller, options, row } = setup({ steerRun: vi.fn(async () => { throw new Error("finished"); }) });
    await controller.steer("one more thing");
    expect(options.appendSteer).toHaveBeenCalledWith("one more thing");
    expect(row.isConnected).toBe(false);
    expect(options.setDraft).toHaveBeenCalledWith("one more thing");
  });

  it("sends the media command as a chat message and shows the inline creation card", async () => {
    const { controller, options } = setup({ draft: () => ({ content: "a cat with a hat", mediaCommand: "video" }) });
    await controller.submit();
    const request = mediaCreationRequest(options);
    expect(request.modality).toBe("video");
    expect(request.prompt).toBe("a cat with a hat");
    expect(request.refs).toEqual([]);
    // The command appears in the chat immediately; only the job waits for the card.
    expect(options.clearDraft).toHaveBeenCalled();
    expect(options.appendUser).toHaveBeenCalledWith("/video a cat with a hat");
    expect(options.persistUserMessage).toHaveBeenCalledWith("session-1", "/video a cat with a hat", expect.any(String));
    expect(options.pushHistory).toHaveBeenCalledWith("/video a cat with a hat");
    expect(options.startRun).not.toHaveBeenCalled();
    expect(options.submitMedia).not.toHaveBeenCalled();

    // Confirming the card submits the job straight to the media pipeline.
    await request.submit({ prompt: "a cat with a hat", durationSeconds: 4, fps: 24 });
    expect(options.submitMedia).toHaveBeenCalledWith({
      routeId: "video",
      modality: "video",
      prompt: "a cat with a hat",
      sessionId: "session-1",
      durationSeconds: 4,
      fps: 24,
    });
    expect(options.onMediaJobSubmitted).toHaveBeenCalledWith("job-1", "video");
    expect(options.appendUser).toHaveBeenCalledTimes(1);
  });

  it("does nothing for empty submissions without attachments", async () => {
    const { controller, options } = setup({ draft: () => ({ content: "   " }) });
    await controller.submit();
    expect(options.startRun).not.toHaveBeenCalled();
    expect(options.submitMedia).not.toHaveBeenCalled();
  });

  it("does not silently run without an attachment whose upload failed", async () => {
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,SGVsbG8=", mimeType: "text/plain", name: "note.txt" };
    const { controller, options } = setup({
      peekAttachments: () => [attachment],
      uploadAttachment: vi.fn(async () => { throw new Error("upload failed"); }),
    });
    await controller.submit("analyse this");
    expect(options.showError).toHaveBeenCalledWith("Error: upload failed");
    expect(options.startRun).not.toHaveBeenCalled();
    expect(options.clearDraft).not.toHaveBeenCalled();
    expect(options.consumeAttachments).not.toHaveBeenCalled();
  });

  it("does not submit an uploaded prompt into a conversation selected during the upload", async () => {
    let current = true;
    let resolveUpload!: (value: { id: string }) => void;
    const uploadAttachment = vi.fn(() => new Promise<{ id: string }>((resolve) => { resolveUpload = resolve; }));
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,SGVsbG8=", mimeType: "text/plain", name: "note.txt" };
    const { controller, options } = setup({
      peekAttachments: () => [attachment], uploadAttachment,
      isSessionCurrent: () => current,
    });

    const pending = controller.submit("analyse this");
    current = false;
    resolveUpload({ id: "artifact-old-chat" });
    await pending;

    expect(options.appendUser).not.toHaveBeenCalled();
    expect(options.startRun).not.toHaveBeenCalled();
    expect(options.consumeAttachments).not.toHaveBeenCalled();
  });

  it("shows the inline creation card for a bare media command with a default prompt", async () => {
    const { controller, options } = setup({ draft: () => ({ content: "", mediaCommand: "video" }) });
    await controller.submit();
    const request = mediaCreationRequest(options);
    expect(request.prompt).toBe("a short video clip");
    expect(options.appendUser).toHaveBeenCalledWith("/video");

    await request.submit({ prompt: "a short video clip" });
    expect(options.submitMedia).toHaveBeenCalledWith(expect.objectContaining({ prompt: "a short video clip" }));
    expect(options.onMediaJobSubmitted).toHaveBeenCalledWith("job-1", "video");
    expect(options.startRun).not.toHaveBeenCalled();
  });

  it("submits an audio brief and explicit lyrics directly to the media pipeline", async () => {
    const { controller, options } = setup({ draft: () => ({ content: "dreamy synth-pop", mediaCommand: "audio" }) });
    await controller.submit();
    await mediaCreationRequest(options).submit({
      prompt: "dreamy synth-pop",
      durationSeconds: 90,
      lyrics: "[Verse]\nNeon rain\n[Chorus]\nCome alive",
    });
    expect(options.submitMedia).toHaveBeenCalledWith(expect.objectContaining({
      routeId: "audio",
      modality: "audio",
      prompt: "dreamy synth-pop",
      durationSeconds: 90,
      lyrics: "[Verse]\nNeon rain\n[Chorus]\nCome alive",
    }));
    expect(options.startRun).not.toHaveBeenCalled();
  });

  it("creates and persists a media-only session without a text route", async () => {
    const { controller, options } = setup({
      sessionId: () => undefined,
      settings: () => ({ routeId: "", effort: "normal", maxTokens: 8192, temperature: 0.4, accessMode: "full" }),
      draft: () => ({ content: "a quiet lake", mediaCommand: "image" }),
    });
    await controller.submit();
    expect(options.ensureSession).toHaveBeenCalledWith("a quiet lake", undefined);
    expect(options.persistUserMessage).toHaveBeenCalledWith("session-1", "/image a quiet lake", expect.any(String));
    expect(options.showMediaCreation).toHaveBeenCalled();
    expect(options.showError).not.toHaveBeenCalled();
  });

  it("does not create an empty chat when a regular prompt has no text route", async () => {
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "draft.txt" };
    const { controller, options } = setup({
      sessionId: () => undefined,
      settings: () => ({ routeId: "", effort: "normal", maxTokens: 8192, temperature: 0.4, accessMode: "full" }),
      peekAttachments: () => [attachment],
    });
    await controller.submit("hello");
    expect(options.ensureSession).not.toHaveBeenCalled();
    expect(options.showError).toHaveBeenCalledWith("No model route is available");
    expect(options.consumeAttachments).not.toHaveBeenCalled();
  });

  it("retains attachments when first-session creation fails", async () => {
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "draft.txt" };
    const { controller, options } = setup({
      sessionId: () => undefined,
      peekAttachments: () => [attachment],
      ensureSession: vi.fn(async () => { throw new Error("storage offline"); }),
    });

    await controller.submit("analyse this");

    expect(options.showError).toHaveBeenCalledWith("Error: storage offline");
    expect(options.consumeAttachments).not.toHaveBeenCalled();
    expect(options.uploadAttachment).not.toHaveBeenCalled();
  });

  it("does not render an unpersisted media command when durable storage fails", async () => {
    const { controller, options } = setup({
      draft: () => ({ content: "a fox", mediaCommand: "video" }),
      persistUserMessage: vi.fn(async () => { throw new Error("storage unavailable"); }),
    });
    await controller.submit();
    expect(options.appendUser).not.toHaveBeenCalled();
    expect(options.showMediaCreation).not.toHaveBeenCalled();
    expect(options.showError).toHaveBeenCalledWith("Error: storage unavailable");
  });

  it("passes pasted reference images into the creation card and submits them as refs", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "ref.png" };
    const { controller, options } = setup({ peekAttachments: () => [attachment], draft: () => ({ content: "make it match", mediaCommand: "image" }) });
    await controller.submit();
    const request = mediaCreationRequest(options);
    expect(options.uploadAttachment).toHaveBeenCalledWith("session-1", attachment);
    expect(request.refs).toEqual([{ artifactId: "artifact-1" }]);

    await request.submit({ prompt: "make it match" });
    expect(options.submitMedia).toHaveBeenCalledWith(expect.objectContaining({ operation: "edit", refs: [{ artifactId: "artifact-1" }] }));
    expect(options.startRun).not.toHaveBeenCalled();
  });

  it("submits an attached image to /video as an animation", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "ref.png" };
    const { controller, options } = setup({ peekAttachments: () => [attachment], draft: () => ({ content: "gentle camera orbit", mediaCommand: "video" }) });
    await controller.submit();
    const request = mediaCreationRequest(options);
    expect(request.refs).toEqual([{ artifactId: "artifact-1" }]);
    await request.submit({ prompt: "gentle camera orbit", durationSeconds: 4 });
    expect(options.submitMedia).toHaveBeenCalledWith(expect.objectContaining({
      operation: "animate", refs: [{ artifactId: "artifact-1" }], durationSeconds: 4,
    }));
  });

  it("does not upload refs for audio commands", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "ref.png" };
    const { controller, options } = setup({ peekAttachments: () => [attachment], draft: () => ({ content: "narrate this", mediaCommand: "audio" }) });
    await controller.submit();
    expect(options.uploadAttachment).not.toHaveBeenCalled();
    expect(mediaCreationRequest(options).refs).toEqual([]);

    await mediaCreationRequest(options).submit({ prompt: "narrate this" });
    expect(options.submitMedia).toHaveBeenCalledWith(expect.objectContaining({ routeId: "audio", modality: "audio", prompt: "narrate this" }));
    expect(options.startRun).not.toHaveBeenCalled();
  });

  it("shows an error when the media submission fails and does not track a job", async () => {
    const { controller, options } = setup({
      draft: () => ({ content: "boom", mediaCommand: "video" }),
      submitMedia: vi.fn(async () => { throw new Error("route unavailable"); }),
    });
    await controller.submit();
    const request = mediaCreationRequest(options);
    await expect(request.submit({ prompt: "boom" })).rejects.toThrow("route unavailable");
    expect(options.showError).toHaveBeenCalledWith("Error: route unavailable");
    expect(options.onMediaJobSubmitted).not.toHaveBeenCalled();
    expect(options.startRun).not.toHaveBeenCalled();
  });
});
