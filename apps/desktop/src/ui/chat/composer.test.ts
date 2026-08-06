// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerOptions } from "./composer.js";
import { ComposerControls } from "./composer-controls.js";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function setup(overrides: Partial<ComposerOptions> = {}) {
  // ComposerControls falls back to globalThis.localStorage; happy-dom ships an empty stub here.
  globalThis.localStorage = memoryStorage() as unknown as Storage;
  const mount = document.createElement("div");
  document.body.append(mount);
  const calls = {
    getProjectRoot: () => "/repo",
    bridge: {
      gitBranches: vi.fn(async () => ({ current: "main", branches: ["main", "dev"] })),
      checkoutBranch: vi.fn(async () => ({ current: "dev", branches: ["main", "dev"] })),
      createBranch: vi.fn(async () => ({ current: "feature", branches: ["feature"] })),
      createWorktree: vi.fn(async () => ({ path: "/repo-wt", branch: "wt-branch" })),
    },
    closeAllPopovers: vi.fn(),
    onRouteChange: vi.fn(),
    onCompact: vi.fn(),
    onSubmit: vi.fn(),
    onInput: vi.fn(),
    onValueChange: vi.fn(),
    onAttach: vi.fn(),
    onDismissProject: vi.fn(),
    onPreviewPasted: vi.fn(),
    onWorktreeCreated: vi.fn(async () => {}),
    onError: vi.fn(),
    isRunning: () => false,
    ...overrides,
  };
  const composer = new Composer({ mount, ...calls });
  return { composer, calls, mount };
}

function promptOf(composer: Composer): HTMLTextAreaElement {
  return composer.root.querySelector<HTMLTextAreaElement>("#prompt")!;
}

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function type(target: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  target.value = text;
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function pasteFiles(composer: Composer, files: Array<{ bytes: BlobPart[]; name: string; mimeType: string }>): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(new File(file.bytes, file.name, { type: file.mimeType }));
  promptOf(composer).dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
}

beforeEach(() => document.body.replaceChildren());

describe("Composer", () => {
  it("renders the composer template into its mount and owns its controls", () => {
    const { composer, mount } = setup();
    expect(composer.root.className).toBe("composer-dock");
    expect(mount.contains(composer.root)).toBe(true);
    expect(composer.scrollButton.id).toBe("scroll-to-bottom");
    expect(composer.controls).toBeInstanceOf(ComposerControls);
    expect(promptOf(composer)).toBeTruthy();
    expect(composer.root.querySelector<HTMLFormElement>("#composer")).toBeTruthy();
    expect(composer.root.querySelector<HTMLElement>("#new-chat-context")!.hidden).toBe(true);
  });

  it("submits the prompt value through the form", () => {
    const { composer, calls } = setup();
    promptOf(composer).value = "  do the thing  ";
    composer.root.querySelector<HTMLFormElement>("#composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls.onSubmit).toHaveBeenCalledWith("  do the thing  ");
  });

  it("submits with the Enter key", () => {
    const { composer, calls } = setup();
    const prompt = promptOf(composer);
    prompt.value = "hello";
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(calls.onSubmit).toHaveBeenCalledWith("hello");
  });

  it("reports typed input and resizes the prompt", () => {
    const { composer, calls } = setup();
    type(promptOf(composer), "steer me");
    expect(calls.onInput).toHaveBeenCalledWith("steer me");
    expect(promptOf(composer).style.height).toMatch(/px$/);
  });

  it("sets and clears drafts through the public API", () => {
    const { composer, calls } = setup();
    composer.setDraft("Build a feature");
    expect(promptOf(composer).value).toBe("Build a feature");
    expect(calls.onInput).toHaveBeenCalledWith("Build a feature");
    composer.clearDraft();
    expect(promptOf(composer).value).toBe("");
  });

  it("recalls past prompts with up and down arrows, restoring the draft", () => {
    const { composer, calls } = setup();
    composer.rebuildHistory(["first idea", "second idea"]);
    const prompt = promptOf(composer);
    prompt.value = "draft text";
    prompt.selectionStart = 0;

    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(prompt.value).toBe("second idea");
    expect(calls.onValueChange).toHaveBeenCalledWith("second idea");

    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(prompt.value).toBe("first idea");

    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(prompt.value).toBe("second idea");

    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(prompt.value).toBe("draft text");
  });

  it("gates prompt, attach, and send controls from one state update", () => {
    const { composer } = setup();
    const prompt = promptOf(composer);
    const attach = composer.root.querySelector<HTMLButtonElement>("#attach")!;
    const send = composer.root.querySelector<HTMLButtonElement>("#send")!;
    const modelToggle = composer.root.querySelector<HTMLButtonElement>("#model-toggle")!;

    composer.setState({ ready: true, running: false, hasSession: true });
    expect(prompt.disabled).toBe(false);
    expect(attach.disabled).toBe(false);
    expect(send.disabled).toBe(true); // no text yet

    type(prompt, "hello");
    composer.controls.setRoutes([{ id: "default", label: "Default" }]);
    composer.setState({ ready: true, running: false, hasSession: true });
    expect(send.disabled).toBe(false);
    expect(send.title).toBe("Send message");
    expect(send.classList.contains("running")).toBe(false);
    expect(modelToggle.disabled).toBe(false);

    composer.setState({ ready: true, running: true, hasSession: true });
    expect(send.disabled).toBe(false);
    expect(send.title).toBe("Send to the running agent");
    expect(attach.disabled).toBe(true);
    expect(modelToggle.disabled).toBe(true);
    expect(prompt.disabled).toBe(false); // stays unlocked so the user can steer

    prompt.value = "";
    composer.setState({ ready: true, running: true, hasSession: false });
    expect(send.title).toBe("Stop task");
    expect(send.classList.contains("running")).toBe(true);
  });

  it("sets the run status label", () => {
    const { composer } = setup();
    composer.setStatus("Working", "running");
    const status = composer.root.querySelector<HTMLElement>("#status")!;
    expect(status.textContent).toBe("Working");
    expect(status.dataset.state).toBe("running");
  });

  it("routes the attach button to the renderer file picker", () => {
    const { composer, calls } = setup();
    composer.setState({ ready: true, running: false, hasSession: true });
    click(composer.root.querySelector<HTMLButtonElement>("#attach")!);
    expect(calls.onAttach).toHaveBeenCalled();
  });

  it("turns pasted images into previewable chips and consumes them on submit", async () => {
    const { composer, calls } = setup();
    pasteFiles(composer, [{ bytes: ["img-bytes"], name: "shot.png", mimeType: "image/png" }]);
    await vi.waitFor(() => expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(1));
    const chip = composer.root.querySelector(".attachment-chip")!;
    expect(chip.className).toContain("image-chip");
    expect(composer.root.querySelector<HTMLElement>("#composer-attachments")!.hidden).toBe(false);

    chip.querySelector(".attachment-preview")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls.onPreviewPasted).toHaveBeenCalledWith("image", expect.any(String), "image/png", expect.stringMatching(/^screenshot-\d+\.png$/));

    const attachments = composer.consumePastedAttachments();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.kind).toBe("image");
    expect(attachments[0]!.name).toMatch(/^screenshot-\d+\.png$/);
    expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(0);
    expect(composer.root.querySelector<HTMLElement>("#composer-attachments")!.hidden).toBe(true);
  });

  it("creates pdf chips for pasted PDFs with a stable name", async () => {
    const { composer, calls } = setup();
    pasteFiles(composer, [{ bytes: ["%PDF-1.4"], name: "report.pdf", mimeType: "application/pdf" }]);
    await vi.waitFor(() => expect(composer.root.querySelectorAll(".pdf-chip").length).toBe(1));
    composer.root.querySelector<HTMLElement>(".pdf-chip .pdf-name")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(calls.onPreviewPasted).toHaveBeenCalledWith("pdf", expect.any(String), "application/pdf", "report.pdf");
  });

  it("stages attach-button files as chips and consumes them on submit", async () => {
    const { composer } = setup();
    composer.attachFile(new File(["code"], "notes.txt", { type: "text/plain" }));
    await vi.waitFor(() => expect(composer.root.querySelectorAll(".file-chip").length).toBe(1));
    expect(composer.root.querySelector<HTMLElement>(".file-chip .file-name")!.textContent).toBe("notes.txt");

    composer.attachFile(new File(["%PDF-1.4"], "doc.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(composer.root.querySelectorAll(".pdf-chip").length).toBe(1));

    const attachments = composer.consumePastedAttachments();
    expect(attachments.map((item) => item.kind)).toEqual(["file", "pdf"]);
    expect(attachments[0]!.name).toBe("notes.txt");
    expect(attachments[1]!.name).toBe("doc.pdf");
    expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(0);
  });

  it("rejects attach-button files over 5 MB and ignores attach while running", () => {
    const { composer, calls } = setup();
    composer.attachFile(new File([new Uint8Array(5_000_001)], "big.png", { type: "image/png" }));
    expect(calls.onError).toHaveBeenCalledWith("Attached file is too large (max 5 MB)");
    expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(0);

    const running = setup({ isRunning: () => true });
    running.composer.attachFile(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(running.composer.root.querySelectorAll(".attachment-chip").length).toBe(0);
  });

  it("rejects pasted files over 5 MB and ignores pastes while running", () => {
    const { composer, calls } = setup();
    pasteFiles(composer, [{ bytes: [new Uint8Array(5_000_001)], name: "big.png", mimeType: "image/png" }]);
    expect(calls.onError).toHaveBeenCalledWith("Pasted file is too large (max 5 MB)");
    expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(0);

    const running = setup({ isRunning: () => true });
    pasteFiles(running.composer, [{ bytes: ["x"], name: "mid.png", mimeType: "image/png" }]);
    expect(running.composer.root.querySelectorAll(".attachment-chip").length).toBe(0);
  });

  it("adds artifact chips and clears them while preserving pasted chips", async () => {
    const { composer } = setup();
    const onPreview = vi.fn();
    const onRemove = vi.fn();
    composer.addArtifactChip("notes.md", "1.2 kB", onPreview, onRemove);
    composer.addArtifactChip("plan.pdf", "3 MB", onPreview, onRemove);
    pasteFiles(composer, [{ bytes: ["x"], name: "shot.png", mimeType: "image/png" }]);
    await vi.waitFor(() => expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(3));

    composer.clearArtifactChips();
    const chips = [...composer.root.querySelectorAll(".attachment-chip")];
    expect(chips).toHaveLength(1);
    expect(chips[0]!.className).toContain("image-chip");

    composer.consumePastedAttachments();
    expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(0);
  });

  it("opens the branch menu, lists branches from git, and checkouts a branch", async () => {
    const { composer, calls } = setup();
    const branchControl = composer.root.querySelector<HTMLButtonElement>("#new-chat-branch-control")!;
    click(branchControl);
    await vi.waitFor(() => expect(calls.bridge.gitBranches).toHaveBeenCalledWith("/repo"));
    const list = composer.root.querySelector<HTMLElement>("#branch-list")!;
    await vi.waitFor(() => expect(list.querySelectorAll("button").length).toBe(2));
    const labels = [...list.querySelectorAll("button span")].map((node) => node.textContent);
    expect(labels).toEqual(["main", "dev"]);
    const label = composer.root.querySelector<HTMLElement>("#new-chat-branch-label")!;
    expect(label.textContent).toBe("main");

    const devButton = [...list.querySelectorAll("button")].find((button) => button.textContent === "dev")!;
    click(devButton);
    await vi.waitFor(() => expect(calls.bridge.checkoutBranch).toHaveBeenCalledWith("/repo", "dev"));
    await vi.waitFor(() => expect(label.textContent).toBe("dev"));
    expect(composer.root.querySelector<HTMLElement>("#new-chat-branch-menu")!.hidden).toBe(true);
  });

  it("creates and checkouts a new branch from the branch menu", async () => {
    const { composer, calls } = setup();
    click(composer.root.querySelector<HTMLButtonElement>("#new-chat-branch-control")!);
    await vi.waitFor(() => expect(calls.bridge.gitBranches).toHaveBeenCalled());
    click(composer.root.querySelector<HTMLButtonElement>("#show-create-branch")!);
    type(composer.root.querySelector<HTMLInputElement>("#new-branch-name")!, "feature/foo");
    click(composer.root.querySelector<HTMLButtonElement>("#create-branch-submit")!);
    await vi.waitFor(() => expect(calls.bridge.createBranch).toHaveBeenCalledWith("/repo", "feature/foo"));
    expect(composer.root.querySelector<HTMLElement>("#new-chat-branch-label")!.textContent).toBe("feature");
    expect(composer.root.querySelector<HTMLElement>("#new-chat-branch-menu")!.hidden).toBe(true);
  });

  it("creates a worktree and reports the new root back to the renderer", async () => {
    const { composer, calls } = setup();
    composer.openWorktreeSetup();
    expect(composer.root.querySelector<HTMLElement>("#create-worktree-form")!.hidden).toBe(false);
    type(composer.root.querySelector<HTMLInputElement>("#new-worktree-branch")!, "wt/isolated");
    click(composer.root.querySelector<HTMLButtonElement>("#create-worktree-submit")!);
    await vi.waitFor(() => expect(calls.bridge.createWorktree).toHaveBeenCalledWith("/repo", "wt/isolated"));
    await vi.waitFor(() => expect(calls.onWorktreeCreated).toHaveBeenCalledWith("/repo-wt", "wt-branch"));
    expect(composer.root.querySelector<HTMLElement>("#new-chat-branch-label")!.textContent).toBe("wt-branch");
    expect(composer.root.querySelector<HTMLElement>("#new-chat-environment-menu")!.hidden).toBe(true);
  });

  it("reveals the worktree form from the environment menu", () => {
    const { composer } = setup();
    click(composer.root.querySelector<HTMLButtonElement>("#new-chat-environment-control")!);
    click(composer.root.querySelector<HTMLButtonElement>('[data-environment-choice="worktree"]')!);
    expect(composer.root.querySelector<HTMLElement>("#create-worktree-form")!.hidden).toBe(false);
  });

  it("shows and hides the new-chat context strip", () => {
    const { composer } = setup();
    const context = composer.root.querySelector<HTMLElement>("#new-chat-context")!;
    expect(context.hidden).toBe(true);
    composer.enterNewChat("Acme");
    expect(context.hidden).toBe(false);
    expect(composer.root.querySelector<HTMLElement>("#new-chat-project")!.textContent).toBe("Acme");
    expect(composer.root.querySelector<HTMLElement>("#new-chat-project-control")!.hidden).toBe(false);
    composer.exitNewChat();
    expect(context.hidden).toBe(true);
  });

  it("clears prompt, attachments, and history when entering a new chat", async () => {
    const { composer } = setup();
    type(promptOf(composer), "leftover");
    composer.pushHistory("previous prompt");
    composer.addArtifactChip("a.txt", "1 kB", vi.fn(), vi.fn());
    pasteFiles(composer, [{ bytes: ["x"], name: "shot.png", mimeType: "image/png" }]);
    await vi.waitFor(() => expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(2));

    composer.enterNewChat("Acme");
    expect(promptOf(composer).value).toBe("");
    expect(composer.root.querySelectorAll(".attachment-chip").length).toBe(0);
    expect(composer.consumePastedAttachments()).toHaveLength(0);

    promptOf(composer).selectionStart = 0;
    promptOf(composer).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(promptOf(composer).value).toBe("");
  });

  it("detaches the project chip and notifies the renderer", () => {
    const { composer, calls } = setup();
    composer.enterNewChat("Acme");
    click(composer.root.querySelector<HTMLButtonElement>("#new-chat-project-control")!);
    expect(calls.onDismissProject).toHaveBeenCalled();
    expect(composer.root.querySelector<HTMLButtonElement>("#new-chat-project-control")!.hidden).toBe(true);
  });

  it("closes every composer-owned popover", () => {
    const { composer } = setup();
    click(composer.root.querySelector<HTMLButtonElement>("#new-chat-environment-control")!);
    expect(composer.root.querySelector<HTMLElement>("#new-chat-environment-menu")!.hidden).toBe(false);
    click(composer.root.querySelector<HTMLButtonElement>("#new-chat-branch-control")!);
    expect(composer.root.querySelector<HTMLElement>("#new-chat-branch-menu")!.hidden).toBe(false);

    composer.closePopovers();
    expect(composer.root.querySelector<HTMLElement>("#new-chat-environment-menu")!.hidden).toBe(true);
    expect(composer.root.querySelector<HTMLElement>("#new-chat-branch-menu")!.hidden).toBe(true);
    expect(composer.root.querySelector<HTMLButtonElement>("#new-chat-environment-control")!.getAttribute("aria-expanded")).toBe("false");
    expect(composer.root.querySelector<HTMLButtonElement>("#new-chat-branch-control")!.getAttribute("aria-expanded")).toBe("false");
  });
});
