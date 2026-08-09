// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactController } from "./artifact-controller.js";

function setup(overrides: { sessionId?: string; newChat?: boolean; artifacts?: Record<string, any>[] } = {}) {
  const list = document.createElement("div");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  const pickButton = document.createElement("button");
  const calls = {
    api: vi.fn(async () => ({ data: overrides.artifacts ?? [] })),
    setSessionArtifacts: vi.fn(),
    previewArtifact: vi.fn(),
    openInspector: vi.fn(),
    clearChips: vi.fn(),
    addChip: vi.fn(),
    stageFile: vi.fn(),
    showToast: vi.fn(),
    errorMessage: vi.fn((error: unknown) => String(error)),
  };
  const controller = new ArtifactController({
    list,
    fileInput,
    pickButton,
    getSessionId: () => overrides.sessionId,
    isNewChat: () => Boolean(overrides.newChat),
    ...calls,
  });
  return { controller, list, fileInput, pickButton, calls };
}

beforeEach(() => document.body.replaceChildren());

describe("ArtifactController", () => {
  it("renders task artifacts but keeps generated media out of composer chips", async () => {
    const upload = { id: "a1", name: "notes.md", byteSize: 2048 };
    const generated = { id: "a2", name: "clip.mp4", byteSize: 4096, metadata: { mediaJobId: "job-1" } };
    const { controller, list, calls } = setup({ sessionId: "session-1", artifacts: [upload, generated] });
    await controller.load();
    expect(list.textContent).toContain("notes.md2.0 KB");
    expect(list.textContent).toContain("clip.mp44.0 KB");
    expect(calls.addChip).toHaveBeenCalledOnce();
    expect(calls.addChip.mock.calls[0]?.[0]).toBe("notes.md");
    expect(calls.setSessionArtifacts).toHaveBeenCalledWith([upload, generated]);
  });

  it("stages a selected file when composing a new chat", async () => {
    const { controller, fileInput, calls } = setup({ newChat: true });
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await controller.uploadSelected();
    expect(calls.stageFile).toHaveBeenCalledWith(file);
    expect(calls.api).not.toHaveBeenCalled();
  });

  it("uploads into an existing task and refreshes the repository", async () => {
    const { controller, fileInput, calls } = setup({ sessionId: "session-1" });
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await controller.uploadSelected();
    expect(calls.api).toHaveBeenCalledWith("/api/v1/sessions/session-1/artifacts", "POST", expect.objectContaining({
      name: "hello.txt",
      mimeType: "text/plain",
      contentBase64: "aGVsbG8=",
    }));
    expect(calls.openInspector).toHaveBeenCalledOnce();
  });
});
