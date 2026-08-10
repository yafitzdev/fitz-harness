// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaJobFeed } from "./media-job-feed.js";

function setup() {
  const messages = document.createElement("main");
  document.body.append(messages);
  const calls = {
    appendWork: vi.fn((row: HTMLElement) => messages.append(row)),
    finishWork: vi.fn(),
    appendAssistant: vi.fn((text: string) => {
      const article = document.createElement("article");
      article.className = "message assistant";
      const content = document.createElement("div");
      content.className = "message-content";
      content.textContent = text;
      const actions = document.createElement("div");
      actions.className = "message-actions";
      article.append(content, actions);
      messages.append(article);
      return content;
    }),
    openArtifact: vi.fn(),
    retry: vi.fn(async () => ({ id: "job-2", modality: "video" as const, status: "queued" })),
    watch: vi.fn(),
    showStatus: vi.fn(),
    errorMessage: vi.fn((error: unknown) => String(error)),
  };
  return { feed: new MediaJobFeed({ messages, ...calls }), messages, calls };
}

beforeEach(() => document.body.replaceChildren());

describe("MediaJobFeed", () => {
  it("keeps progress in agent work and promotes completed media to a final answer", () => {
    const { feed, messages, calls } = setup();
    feed.render({ id: "job-1", modality: "video", status: "queued" });
    expect(calls.appendWork).toHaveBeenCalledWith(expect.any(HTMLElement), undefined);
    expect(messages.textContent).toContain("Video generation in progress");

    feed.render({ id: "job-1", modality: "video", status: "completed", completedAt: "now" }, undefined, { id: "artifact-1", name: "clip.mp4" });
    expect(calls.appendAssistant).toHaveBeenCalledWith("Here is your video!", "now");
    expect(messages.querySelector(".media-result-message .media-job-notice.completed")).not.toBeNull();
    expect(messages.textContent).toContain("Video ready");
    expect(messages.textContent).toContain("clip.mp4");
    expect(calls.finishWork).toHaveBeenCalledWith("now");
  });

  it("promotes restored terminal failures outside agent work", () => {
    const { feed, calls, messages } = setup();
    feed.render({
      id: "job-1",
      modality: "image",
      status: "failed",
      params: { prompt: "a fox", size: "1024x1024", seed: 42 },
      enqueuedAt: "2026-08-09T06:35:57.783Z",
      completedAt: "2026-08-09T06:36:07.922Z",
    }, "GPU unavailable");
    expect(calls.appendWork).not.toHaveBeenCalled();
    expect(calls.finishWork).not.toHaveBeenCalled();
    expect(calls.appendAssistant).toHaveBeenCalledWith("I couldn't generate your image.", "2026-08-09T06:36:07.922Z");
    const row = messages.querySelector<HTMLElement>(".media-result-message .media-job-notice.failed")!;
    expect(row).not.toBeNull();
    row.click();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toContain("a fox");
    expect(row.textContent).toContain("1024x1024");
    expect(row.textContent).toContain("42");
  });

  it("anchors restored terminal media after its originating work summary", () => {
    const { feed, messages } = setup();
    const work = document.createElement("section");
    work.className = "work-summary";
    const details = document.createElement("div");
    details.className = "work-summary-details";
    const tool = document.createElement("div");
    tool.dataset.mediaJobId = "job-1";
    details.append(tool); work.append(details); messages.append(work, document.createElement("hr"));
    feed.render({ id: "job-1", modality: "video", status: "failed", params: { prompt: "dog" } }, "GPU unavailable");
    expect(work.nextElementSibling?.classList.contains("media-result-message")).toBe(true);
  });

  it("retries terminal failures through the injected lifecycle", async () => {
    const { feed, messages, calls } = setup();
    feed.render({ id: "job-1", modality: "video", status: "failed" }, "GPU unavailable");
    const retry = messages.querySelector<HTMLButtonElement>(".media-job-open")!;
    retry.click();
    await vi.waitFor(() => expect(calls.retry).toHaveBeenCalledOnce());
    expect(calls.watch).toHaveBeenCalledWith("job-2");
    expect(messages.textContent).toContain("Video generation in progress");
  });

  it("does not unfold a terminal card when its action button is clicked", () => {
    const { feed, messages, calls } = setup();
    feed.render({ id: "job-1", modality: "video", status: "completed", params: { prompt: "dog" } }, undefined, { id: "artifact", name: "dog.mp4" });
    messages.querySelector<HTMLButtonElement>(".media-job-open")!.click();
    expect(calls.openArtifact).toHaveBeenCalledOnce();
    expect(messages.querySelector(".media-job-notice")?.getAttribute("aria-expanded")).toBe("false");
  });
});
