// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTimeline } from "./activity-timeline.js";

function setup() {
  const messages = document.createElement("main");
  document.body.append(messages);
  const timeline = new ActivityTimeline({
    messages,
    inspectResource: vi.fn(),
    decideApproval: vi.fn(async () => "approved" as const),
    showStatus: vi.fn(),
  });
  return { messages, timeline };
}

function commentary(text: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "message commentary";
  article.textContent = text;
  return article;
}

beforeEach(() => document.body.replaceChildren());

describe("ActivityTimeline", () => {
  it("renders media approvals as editable typed fields and submits a safe request", async () => {
    const messages = document.createElement("main");
    const decideApproval = vi.fn(async () => "approved" as const);
    const timeline = new ActivityTimeline({ messages, inspectResource: vi.fn(), decideApproval, showStatus: vi.fn() });
    const row = timeline.appendApproval({ id: "approval-video", toolName: "generate_video", request: { prompt: "agent draft", duration_seconds: 8, resolution: "1344x768", fps: 24 }, status: "pending" });
    expect(row.parentElement?.classList.contains("work-summary-details")).toBe(true);
    expect(row.querySelector("pre.tool-approval-request")).toBeNull();
    const prompt = row.querySelector<HTMLTextAreaElement>('[data-approval-field="prompt"]')!;
    const duration = row.querySelector<HTMLInputElement>('[data-approval-field="duration_seconds"]')!;
    prompt.value = "user revision";
    duration.value = "4";
    row.querySelector<HTMLButtonElement>(".approve-tool")!.click();
    await vi.waitFor(() => expect(decideApproval).toHaveBeenCalledWith("approval-video", "approved", {
      prompt: "user revision", duration_seconds: 4, resolution: "1344x768", fps: 24,
    }));
  });

  it("removes hover metadata when a streamed assistant message becomes reasoning", () => {
    const { messages, timeline } = setup();
    const article = document.createElement("article");
    article.className = "message assistant";
    const content = document.createElement("div");
    content.className = "message-body";
    content.textContent = "Reasoning";
    const actions = document.createElement("div");
    actions.className = "message-actions";
    article.append(content, actions);
    messages.append(article);

    timeline.markAssistantAsCommentary(content);

    expect(article.classList.contains("commentary")).toBe(true);
    expect(article.querySelector(".message-actions")).toBeNull();
    expect(messages.querySelector(".work-summary-details > .commentary")).toBe(article);
  });

  it("groups each consecutive command and edit burst between narration blocks", () => {
    const { messages, timeline } = setup();
    timeline.appendCommentary(commentary("First reasoning block"), "2026-08-03T08:00:00.000Z");

    const first = timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:01.000Z");
    timeline.completeTool(first, "bash", { command: "pnpm test" }, "passed", false);
    const second = timeline.appendTool("grep", { pattern: "TODO" }, "tool-2", true, "2026-08-03T08:00:02.000Z");
    timeline.completeTool(second, "grep", { pattern: "TODO" }, "match", false);
    const edit = timeline.appendTool("edit", { path: "src/app.ts" }, "tool-3", true, "2026-08-03T08:00:03.000Z");
    timeline.completeTool(edit, "edit", { path: "src/app.ts" }, "done", false);

    timeline.appendCommentary(commentary("Second reasoning block"), "2026-08-03T08:00:04.000Z");
    const third = timeline.appendTool("bash", { command: "pnpm build" }, "tool-4", true, "2026-08-03T08:00:05.000Z");
    timeline.completeTool(third, "bash", { command: "pnpm build" }, "passed", false);

    const bursts = [...messages.querySelectorAll<HTMLElement>(".activity-burst")];
    expect(bursts).toHaveLength(2);
    expect(bursts[0]!.querySelector(".activity-burst-label")?.textContent).toBe("Edited file, ran command");
    expect(bursts[0]!.querySelectorAll(".agent-activity")).toHaveLength(3);
    expect(bursts[1]!.querySelector(".activity-burst-label")?.textContent).toBe("Ran command");
    expect(bursts[1]!.querySelectorAll(".agent-activity")).toHaveLength(1);
    expect([...messages.querySelectorAll(".work-summary-details > *")].map((node) => node.textContent)).toEqual([
      "First reasoning block",
      expect.stringContaining("Edited file, ran command"),
      "Second reasoning block",
      expect.stringContaining("Ran command"),
    ]);
  });

  it("shows a steering message inside the work feed and starts a new burst after it", () => {
    const { messages, timeline } = setup();
    timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:00.000Z");

    const steer = timeline.appendSteer("focus on the tests", "2026-08-03T08:00:01.000Z");
    const after = timeline.appendTool("read", { path: "src/app.ts" }, "tool-2", true, "2026-08-03T08:00:02.000Z");

    expect(steer.classList.contains("steer-activity")).toBe(true);
    expect(steer.querySelector(".agent-activity-label")?.textContent).toBe("focus on the tests");
    const bursts = [...messages.querySelectorAll<HTMLElement>(".activity-burst")];
    expect(bursts).toHaveLength(2);
    expect([...messages.querySelectorAll(".work-summary-details > *")].map((node) => node.textContent)).toEqual([
      expect.stringContaining("Running command"),
      "focus on the tests",
      expect.stringContaining("Reading src/app.ts"),
    ]);
    expect(after.closest(".activity-burst")).toBe(bursts[1]);
  });

  it("renders model reasoning inline in the work feed, separate from chat", () => {
    const { messages, timeline } = setup();
    const row = timeline.appendReasoning(true);
    timeline.appendReasoningDelta(row, "Let me inspect the codebase.");
    timeline.completeReasoning(row);

    expect(row.classList.contains("reasoning-activity")).toBe(true);
    expect(row.classList.contains("running")).toBe(false);
    expect(messages.querySelector(".reasoning-content")?.textContent).toBe("Let me inspect the codebase.");
    expect(messages.querySelector(".work-summary-details > .reasoning-activity")).toBe(row);
    expect(messages.querySelector(".reasoning-activity .agent-activity-summary")).toBeNull();
  });

  it("ends the previous tool burst when a reasoning segment starts", () => {
    const { messages, timeline } = setup();
    timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:00.000Z");
    timeline.appendReasoning(true);
    const after = timeline.appendTool("read", { path: "src/app.ts" }, "tool-2", true, "2026-08-03T08:00:02.000Z");
    const bursts = [...messages.querySelectorAll<HTMLElement>(".activity-burst")];
    expect(bursts).toHaveLength(2);
    expect(after.closest(".activity-burst")).toBe(bursts[1]);
  });

  it("keeps commands hidden behind the burst summary until it is opened", () => {
    const { messages, timeline } = setup();
    const row = timeline.appendTool("bash", { command: "git status --short" }, "tool-1", true);
    timeline.completeTool(row, "bash", { command: "git status --short" }, "clean", false);

    const toggle = messages.querySelector<HTMLButtonElement>(".activity-burst-toggle")!;
    const details = messages.querySelector<HTMLElement>(".activity-burst-details")!;
    expect(details.hidden).toBe(true);
    expect(toggle.textContent).toContain("Ran command");
    expect(details.textContent).toContain("Ran git status --short");

    toggle.click();
    expect(details.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("names the active project instead of rendering a meaningless list dot", () => {
    const messages = document.createElement("main");
    const timeline = new ActivityTimeline({
      messages,
      projectRoot: () => "C:\\work\\fitz-codex",
      inspectResource: vi.fn(),
      decideApproval: vi.fn(async () => "approved" as const),
      showStatus: vi.fn(),
    });
    const row = timeline.appendTool("ls", { path: "." }, "list-1", true);
    timeline.completeTool(row, "ls", { path: "." }, [], false);
    expect(row.querySelector(".agent-activity-label")?.textContent).toBe("Listed fitz-codex");
  });

  it("uses project-relative paths in tool labels and expanded details", () => {
    const messages = document.createElement("main");
    const timeline = new ActivityTimeline({
      messages,
      projectRoot: () => "C:\\work\\fitz-codex",
      inspectResource: vi.fn(),
      decideApproval: vi.fn(async () => "approved" as const),
      showStatus: vi.fn(),
    });
    const list = timeline.appendTool("ls", { path: "C:/work/fitz-codex/docs" }, "list-absolute", true);
    timeline.completeTool(list, "ls", { path: "C:/work/fitz-codex/docs" }, [], false);
    const shell = timeline.appendTool("bash", { command: "cd C:/work/fitz-codex && pnpm test" }, "shell-absolute", true);

    expect(list.querySelector(".agent-activity-label")?.textContent).toBe("Listed docs");
    expect(list.querySelector(".tool-activity-input")?.textContent).toContain("./docs");
    expect(list.textContent).not.toContain("C:/work/fitz-codex");
    expect(shell.querySelector(".shell-command")?.textContent).toBe("cd . && pnpm test");
    timeline.completeTool(shell, "bash", { command: "cd C:/work/fitz-codex && pnpm test" }, { content: [{ type: "text", text: "C:/work/fitz-codex/apps" }] }, false);
    expect(shell.querySelector(".shell-output")?.textContent).toBe("./apps");
    expect(shell.textContent).not.toContain("C:/work/fitz-codex");
  });

  it("uses running labels until every tool in a burst completes and one durable work summary", () => {
    const { messages, timeline } = setup();
    const command = timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:00.000Z");
    const edit = timeline.appendTool("write", { path: "README.md" }, "tool-2", true, "2026-08-03T08:00:02.000Z");
    const label = messages.querySelector<HTMLElement>(".activity-burst-label")!;
    expect(label.textContent).toBe("Editing file, running command");

    timeline.completeTool(command, "bash", { command: "pnpm test" }, "passed", false, "2026-08-03T08:00:03.000Z");
    expect(label.textContent).toBe("Editing file, running command");
    timeline.completeTool(edit, "write", { path: "README.md" }, "done", false, "2026-08-03T08:00:04.000Z");
    expect(label.textContent).toBe("Edited file, ran command");

    timeline.finishWork("2026-08-03T08:00:05.000Z");
    expect(messages.querySelectorAll(".work-summary")).toHaveLength(1);
    expect(messages.querySelector(".work-summary-label")?.textContent).toBe("Worked for 5s");
    expect(messages.querySelector<HTMLElement>(".work-summary-details")?.hidden).toBe(true);
    const summary = messages.querySelector<HTMLElement>(".work-summary")!;
    expect(summary.classList.contains("completed")).toBe(true);
    summary.querySelector<HTMLButtonElement>(".work-summary-toggle")!.click();
    expect(summary.classList.contains("open")).toBe(true);
    expect(summary.querySelector<HTMLElement>(".work-summary-details")?.hidden).toBe(false);
  });

  it("formats sessions of an hour or more as hours and minutes without seconds", () => {
    const { messages, timeline } = setup();
    timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:00.000Z");
    timeline.finishWork("2026-08-03T09:53:42.000Z");
    expect(messages.querySelector(".work-summary-label")?.textContent).toBe("Worked for 1h 53m");
  });

  it("closes restored work at its last activity instead of a later user-message boundary", () => {
    const { messages, timeline } = setup();
    const row = timeline.appendTool("generate_video", { prompt: "dog" }, "tool-1", true, "2026-08-08T23:36:30.428Z");
    timeline.completeTool(row, "generate_video", { prompt: "dog" }, "submitted", false, "2026-08-08T23:36:53.203Z");
    timeline.finishWork("2026-08-09T06:35:43.888Z", "next-message");
    expect(messages.querySelector(".work-summary-label")?.textContent).toBe("Worked for 22s");
    expect(messages.querySelector(".work-summary")?.classList.contains("completed")).toBe(false);
  });

  it("marks restored media tools with their durable job id for result anchoring", () => {
    const { timeline } = setup();
    const row = timeline.appendTool("generate_video", { prompt: "dog" }, "tool-1", true);
    timeline.completeTool(row, "generate_video", { prompt: "dog" }, { details: { mediaJobId: "job-video" } }, false);
    expect(row.dataset.mediaJobId).toBe("job-video");
  });

  it("switches to hours at the 60-minute boundary", () => {
    const { messages, timeline } = setup();
    timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:00.000Z");
    timeline.finishWork("2026-08-03T09:00:00.000Z");
    expect(messages.querySelector(".work-summary-label")?.textContent).toBe("Worked for 1h 0m");
  });

  it("keeps minutes and seconds for sub-hour sessions", () => {
    const { messages, timeline } = setup();
    timeline.appendTool("bash", { command: "pnpm test" }, "tool-1", true, "2026-08-03T08:00:00.000Z");
    timeline.finishWork("2026-08-03T08:59:59.000Z");
    expect(messages.querySelector(".work-summary-label")?.textContent).toBe("Worked for 59m 59s");
  });
});
