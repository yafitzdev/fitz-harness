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
    uploadAttachment: vi.fn(async () => ({ id: "artifact-1" })), discardUploadedAttachment: vi.fn(async () => undefined), clearLanding: vi.fn(), appendUser: vi.fn(),
    persistUserMessage: vi.fn(async () => undefined), appendSteer: vi.fn(() => row),
    pushHistory: vi.fn(), addTokenEstimate: vi.fn(), refreshContext: vi.fn(), refreshControls: vi.fn(), runId: () => "run-1",
    startRun: vi.fn(async (_request, onAccepted) => { onAccepted(); }), submitMedia: vi.fn(async () => ({ id: "job-1" })), onMediaJobSubmitted: vi.fn(),
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
    }), expect.any(Function));
    expect(options.appendUser).toHaveBeenCalledWith("Build a dashboard\nwith charts", [expect.objectContaining({
      id: "artifact-1", name: "shot.png", mimeType: "image/png", kind: "image", dataUrl: "data:image/png;base64,AAAA",
    })]);
    expect(options.consumeAttachments).toHaveBeenCalledWith([attachment]);
  });

  it("clears the landing before the run appends visible reasoning activity", async () => {
    const messages = document.createElement("main");
    const landing = document.createElement("div");
    landing.className = "landing";
    messages.append(landing);
    document.body.append(messages);
    let reasoning: HTMLElement | undefined;
    const { controller } = setup({
      clearLanding: vi.fn(() => { if (messages.querySelector(".landing")) messages.replaceChildren(); }),
      startRun: vi.fn(async (_request, onAccepted) => {
        reasoning = document.createElement("div");
        reasoning.textContent = "Thinking…";
        messages.append(reasoning);
        onAccepted();
      }),
    });

    await controller.submit("reason about this");

    expect(reasoning?.isConnected).toBe(true);
    expect(messages.textContent).toContain("Thinking…");
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
    }), expect.any(Function));
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

  it("restores a distinct submission made while the first chat is materializing", async () => {
    let resolveSession!: (value: string) => void;
    let currentDraft = "follow up";
    const ensureSession = vi.fn(() => new Promise<string>((resolve) => { resolveSession = resolve; }));
    const { controller, options } = setup({
      sessionId: () => undefined,
      ensureSession,
      draft: () => ({ content: currentDraft }),
      clearDraft: vi.fn(() => { currentDraft = ""; }),
    });

    const first = controller.submit("Build it");
    const second = controller.submit("follow up");
    resolveSession("session-created");
    await Promise.all([first, second]);

    expect(options.startRun).toHaveBeenCalledOnce();
    expect(options.appendUser).toHaveBeenCalledOnce();
    expect(options.setDraft).toHaveBeenCalledWith("follow up");
  });

  it("preserves both submissions when first-chat materialization fails", async () => {
    let rejectSession!: (reason: Error) => void;
    let currentDraft = "follow up";
    const ensureSession = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectSession = reject; }));
    const { controller, options } = setup({
      sessionId: () => undefined,
      ensureSession,
      draft: () => ({ content: currentDraft }),
      setDraft: vi.fn((value: string) => { currentDraft = value; }),
    });

    const first = controller.submit("Build it");
    const second = controller.submit("follow up");
    rejectSession(new Error("storage offline"));
    await Promise.all([first, second]);

    expect(options.startRun).not.toHaveBeenCalled();
    expect(options.setDraft).toHaveBeenLastCalledWith("Build it\n\nfollow up");
    expect(options.showError).toHaveBeenCalledWith("Error: storage offline");
  });

  it("accepts media commands after an admitted chat run while that run is still active", async () => {
    let finishRun!: () => void;
    const startRun: PromptSubmissionOptions["startRun"] = vi.fn((_request, onAccepted) => {
      onAccepted();
      return new Promise<void>((resolve) => { finishRun = resolve; });
    });
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
      clientRequestId: expect.any(String),
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

  it("discards earlier uploads when a later attachment upload fails", async () => {
    const first = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "first.txt" };
    const second = { kind: "file" as const, dataUrl: "data:text/plain;base64,Qg==", mimeType: "text/plain", name: "second.txt" };
    const uploadAttachment = vi.fn(async (_sessionId: string, attachment: typeof first) => {
      if (attachment === second) throw new Error("second upload failed");
      return { id: "artifact-first" };
    });
    const { controller, options } = setup({ peekAttachments: () => [first, second], uploadAttachment });

    await controller.submit("analyse both");

    expect(options.discardUploadedAttachment).toHaveBeenCalledWith("session-1", "artifact-first");
    expect(options.startRun).not.toHaveBeenCalled();
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
    expect(options.discardUploadedAttachment).toHaveBeenCalledWith("session-1", "artifact-old-chat");
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

  it("restores a regular prompt and retains attachments when run admission fails", async () => {
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "draft.txt" };
    const { controller, options } = setup({
      draft: () => ({ content: "" }),
      peekAttachments: () => [attachment],
      startRun: vi.fn(async () => undefined),
    });

    await controller.submit("analyse this");

    expect(options.clearDraft).toHaveBeenCalledOnce();
    expect(options.setDraft).toHaveBeenCalledWith("analyse this");
    expect(options.consumeAttachments).not.toHaveBeenCalled();
    expect(options.appendUser).not.toHaveBeenCalled();
    expect(options.pushHistory).not.toHaveBeenCalled();
  });

  it("reuses the request identity and uploaded attachments when the restored prompt is retried", async () => {
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "draft.txt" };
    let attempts = 0;
    const startRun: PromptSubmissionOptions["startRun"] = vi.fn(async (_request, onAccepted) => {
      attempts += 1;
      if (attempts === 2) onAccepted();
    });
    const { controller, options } = setup({
      draft: () => ({ content: "" }),
      peekAttachments: () => [attachment],
      startRun,
    });

    await controller.submit("analyse this");
    await controller.submit("analyse this");

    const requests = (startRun as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request as { clientRequestId: string; attachments: Array<{ artifactId: string }> });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.clientRequestId).toBe(requests[1]?.clientRequestId);
    expect(requests[0]?.attachments).toEqual([{ artifactId: "artifact-1" }]);
    expect(requests[1]?.attachments).toEqual([{ artifactId: "artifact-1" }]);
    expect(options.uploadAttachment).toHaveBeenCalledOnce();
    expect(options.consumeAttachments).toHaveBeenCalledOnce();
    expect(options.appendUser).toHaveBeenCalledOnce();
  });

  it("uses a new request identity when retry settings change", async () => {
    let routeId = "smart";
    const startRun: PromptSubmissionOptions["startRun"] = vi.fn(async () => undefined);
    const { controller } = setup({
      draft: () => ({ content: "" }),
      settings: () => ({ routeId, effort: "high", maxTokens: 8192, temperature: 0.4, accessMode: "full" }),
      startRun,
    });

    await controller.submit("analyse this");
    routeId = "default";
    await controller.submit("analyse this");

    const requests = (startRun as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request as { clientRequestId: string });
    expect(requests[0]?.clientRequestId).not.toBe(requests[1]?.clientRequestId);
  });

  it("preserves text typed while an earlier prompt is awaiting admission", async () => {
    const { controller, options } = setup({
      draft: () => ({ content: "new thought", mediaCommand: "video" }),
      startRun: vi.fn(async () => undefined),
    });

    await controller.submit("original prompt");

    expect(options.setDraft).toHaveBeenCalledWith("original prompt\n\n/video new thought");
  });

  it("restores a prompt when the run adapter rejects unexpectedly", async () => {
    const { controller, options } = setup({
      draft: () => ({ content: "" }),
      startRun: vi.fn(async () => { throw new Error("adapter stopped"); }),
    });

    await controller.submit("keep this");

    expect(options.setDraft).toHaveBeenCalledWith("keep this");
    expect(options.showError).toHaveBeenCalledWith("Error: adapter stopped");
  });

  it("does not duplicate a durable edited turn when its replacement run is rejected", async () => {
    const { controller, options, row } = setup({
      draft: () => ({ content: "" }),
      startRun: vi.fn(async () => undefined),
    });

    await controller.submit("edited prompt", row, "message-edited");

    expect(options.setDraft).not.toHaveBeenCalled();
  });

  it("commits captured attachments without drawing into a conversation selected during admission", async () => {
    let current = true;
    const attachment = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "draft.txt" };
    const startRun: PromptSubmissionOptions["startRun"] = vi.fn(async (_request, onAccepted) => {
      current = false;
      onAccepted();
    });
    const { controller, options } = setup({
      peekAttachments: () => [attachment],
      isSessionCurrent: () => current,
      startRun,
    });

    await controller.submit("old chat prompt");

    expect(options.consumeAttachments).toHaveBeenCalledWith([attachment]);
    expect(options.appendUser).not.toHaveBeenCalled();
    expect(options.clearLanding).toHaveBeenCalledOnce();
    expect(options.setDraft).not.toHaveBeenCalled();
  });

  it("does not render an unpersisted media command when durable storage fails", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "ref.png" };
    const { controller, options } = setup({
      draft: () => ({ content: "a fox", mediaCommand: "video" }),
      peekAttachments: () => [attachment],
      persistUserMessage: vi.fn(async () => { throw new Error("storage unavailable"); }),
    });
    await controller.submit();
    expect(options.appendUser).not.toHaveBeenCalled();
    expect(options.showMediaCreation).not.toHaveBeenCalled();
    expect(options.showError).toHaveBeenCalledWith("Error: storage unavailable");
    expect(options.discardUploadedAttachment).toHaveBeenCalledWith("session-1", "artifact-1");
  });

  it("reuses a media command identity after an ambiguous persistence failure", async () => {
    let attempts = 0;
    const persistUserMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("response lost");
    });
    const { controller, options } = setup({
      draft: () => ({ content: "a fox", mediaCommand: "video" }),
      persistUserMessage,
    });

    await controller.submit();
    await controller.submit();

    const messageIds = persistUserMessage.mock.calls.map(([, , clientMessageId]) => clientMessageId);
    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toBe(messageIds[1]);
    expect(options.appendUser).toHaveBeenCalledOnce();
    expect(options.showMediaCreation).toHaveBeenCalledOnce();
  });

  it("passes pasted reference images into the creation card and submits them as refs", async () => {
    const attachment = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "ref.png" };
    const { controller, options } = setup({ peekAttachments: () => [attachment], draft: () => ({ content: "make it match", mediaCommand: "image" }) });
    await controller.submit();
    const request = mediaCreationRequest(options);
    expect(options.uploadAttachment).toHaveBeenCalledWith("session-1", attachment);
    expect(options.consumeAttachments).toHaveBeenCalledWith([attachment]);
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
    expect(options.consumeAttachments).not.toHaveBeenCalled();
    expect(mediaCreationRequest(options).refs).toEqual([]);

    await mediaCreationRequest(options).submit({ prompt: "narrate this" });
    expect(options.submitMedia).toHaveBeenCalledWith(expect.objectContaining({ routeId: "audio", modality: "audio", prompt: "narrate this" }));
    expect(options.startRun).not.toHaveBeenCalled();
  });

  it("leaves unsupported media attachments staged while consuming an image ref", async () => {
    const image = { kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png", name: "ref.png" };
    const file = { kind: "file" as const, dataUrl: "data:text/plain;base64,QQ==", mimeType: "text/plain", name: "notes.txt" };
    const { controller, options } = setup({
      peekAttachments: () => [image, file],
      draft: () => ({ content: "animate this", mediaCommand: "video" }),
    });

    await controller.submit();

    expect(options.uploadAttachment).toHaveBeenCalledOnce();
    expect(options.uploadAttachment).toHaveBeenCalledWith("session-1", image);
    expect(options.consumeAttachments).toHaveBeenCalledWith([image]);
  });

  it("shows an error when the media submission fails and does not track a job", async () => {
    const { controller, options } = setup({
      draft: () => ({ content: "boom", mediaCommand: "video" }),
      submitMedia: vi.fn(async () => { throw new Error("route unavailable"); }),
    });
    await controller.submit();
    const request = mediaCreationRequest(options);
    await expect(request.submit({ prompt: "boom" })).rejects.toThrow("route unavailable");
    await expect(request.submit({ prompt: "boom" })).rejects.toThrow("route unavailable");
    const requestIds = (options.submitMedia as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input.clientRequestId);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(options.showError).toHaveBeenCalledWith("Error: route unavailable");
    expect(options.onMediaJobSubmitted).not.toHaveBeenCalled();
    expect(options.startRun).not.toHaveBeenCalled();
  });
});
