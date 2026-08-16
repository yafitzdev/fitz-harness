// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactController } from "./artifact-controller.js";

function setup(overrides: { sessionId?: string; newChat?: boolean; artifacts?: Record<string, any>[]; api?: (path: string, method?: string, body?: unknown) => Promise<Record<string, any>> } = {}) {
  const list = document.createElement("div");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  const pickButton = document.createElement("button");
  const calls = {
    api: vi.fn(overrides.api ?? (async () => ({ data: overrides.artifacts ?? [] }))),
    setSessionArtifacts: vi.fn(),
    previewArtifact: vi.fn(),
    openInspector: vi.fn(),
    clearChips: vi.fn(),
    addChip: vi.fn(),
    stageFile: vi.fn(),
    showStatus: vi.fn(),
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
  it("renders task artifacts without reattaching old uploads to the composer", async () => {
    const upload = { id: "a1", name: "notes.md", byteSize: 2048 };
    const generated = { id: "a2", name: "clip.mp4", byteSize: 4096, metadata: { mediaJobId: "job-1" } };
    const { controller, list, calls } = setup({ sessionId: "session-1", artifacts: [upload, generated] });
    await controller.load();
    expect(list.textContent).toContain("notes.md2.0 KB");
    expect(list.textContent).toContain("clip.mp44.0 KB");
    expect(calls.addChip).not.toHaveBeenCalled();
    expect(calls.setSessionArtifacts).toHaveBeenCalledWith([upload, generated]);
  });

  it("does not let a stale task response replace the current artifact list", async () => {
    let resolveOld: ((value: Record<string, any>) => void) | undefined;
    const oldResponse = new Promise<Record<string, any>>((resolve) => { resolveOld = resolve; });
    const overrides: Parameters<typeof setup>[0] = {
      sessionId: "session-old",
      api: async (path) => path.includes("session-old")
        ? oldResponse
        : { data: [{ id: "new", name: "current.md", byteSize: 10 }] },
    };
    const { controller, list, calls } = setup(overrides);
    const staleLoad = controller.load();
    await Promise.resolve();
    overrides.sessionId = "session-new";

    await controller.load();
    resolveOld?.({ data: [{ id: "old", name: "stale.md", byteSize: 10 }] });
    await staleLoad;

    expect(list.textContent).toContain("current.md");
    expect(list.textContent).not.toContain("stale.md");
    expect(calls.setSessionArtifacts).toHaveBeenLastCalledWith([{ id: "new", name: "current.md", byteSize: 10 }]);
  });

  it("stages a selected file when composing a new chat", async () => {
    const { controller, fileInput, calls } = setup({ newChat: true });
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await controller.uploadSelected();
    expect(calls.stageFile).toHaveBeenCalledWith(file);
    expect(calls.api).not.toHaveBeenCalled();
  });

  it("stages a selected file for the next message in an existing task", async () => {
    const { controller, fileInput, calls } = setup({ sessionId: "session-1" });
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await controller.uploadSelected();
    expect(calls.stageFile).toHaveBeenCalledWith(file);
    expect(calls.api).not.toHaveBeenCalled();
    expect(calls.openInspector).not.toHaveBeenCalled();
  });

  it("stages every file selected in one picker operation", async () => {
    const { controller, fileInput, calls } = setup({ sessionId: "session-1" });
    const files = [new File(["one"], "one.txt"), new File(["two"], "two.pdf", { type: "application/pdf" })];
    Object.defineProperty(fileInput, "files", { configurable: true, value: files });
    await controller.uploadSelected();
    expect(calls.stageFile.mock.calls.map(([file]) => file.name)).toEqual(["one.txt", "two.pdf"]);
  });

  it("adds a newly uploaded user file to the Inspector repository immediately", async () => {
    const artifact = { id: "new", name: "dropped.txt", sha256: "abc", byteSize: 5, kind: "text" };
    const { controller, calls } = setup({ sessionId: "session-1", api: async () => ({ data: artifact }) });

    await controller.uploadData("session-1", { name: "dropped.txt", mimeType: "text/plain", contentBase64: "aGVsbG8=" });

    expect(calls.setSessionArtifacts).toHaveBeenLastCalledWith([artifact]);
  });
});
