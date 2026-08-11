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

  it("renders a thin progress bar while a job is generating", () => {
    const { feed, messages } = setup();
    feed.render({ id: "job-1", modality: "video", status: "progressing", progress: 0.42 });
    const bar = messages.querySelector<HTMLElement>(".media-job-progress")!;
    expect(bar).not.toBeNull();
    expect(bar.style.getPropertyValue("--progress")).toBe("42%");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(messages.textContent).toContain("Generating… 42%");

    // The bar disappears once the job reaches a terminal state.
    feed.render({ id: "job-1", modality: "video", status: "completed", progress: 1 });
    expect(messages.querySelector(".media-job-progress")).toBeNull();
  });

  it("shows an empty track while a job is queued before progress arrives", () => {
    const { feed, messages } = setup();
    feed.render({ id: "job-1", modality: "video", status: "queued" });
    const bar = messages.querySelector<HTMLElement>(".media-job-progress")!;
    expect(bar).not.toBeNull();
    expect(bar.style.getPropertyValue("--progress")).toBe("");
    expect(messages.textContent).not.toContain("Generating…");
  });

  it("scrolls a bottom card into view when it is expanded", () => {
    const { feed, messages } = setup();
    feed.render({ id: "job-1", modality: "video", status: "completed", params: { prompt: "dog", size: "1280x720" } }, undefined, { id: "artifact", name: "dog.mp4" });
    const row = messages.querySelector<HTMLElement>(".media-job-notice")!;
    Object.defineProperties(messages, { scrollHeight: { get: () => 1_000 }, clientHeight: { get: () => 400 } });
    // The card sits at the bottom of the chat; expanding it pushes its bottom
    // edge 300px past the visible viewport bottom (600).
    row.getBoundingClientRect = () => ({ top: 300, bottom: 900, height: 600, left: 0, right: 600, x: 0, y: 300, width: 600, toJSON: () => ({}) }) as DOMRect;
    messages.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 800, x: 0, y: 0, width: 800, toJSON: () => ({}) }) as DOMRect;

    row.click();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(messages.scrollTop).toBe(300); // 900 - 600
  });

  it("does not scroll when the expanded card is already fully visible", () => {
    const { feed, messages } = setup();
    feed.render({ id: "job-1", modality: "video", status: "completed", params: { prompt: "dog" } }, undefined, { id: "artifact", name: "dog.mp4" });
    const row = messages.querySelector<HTMLElement>(".media-job-notice")!;
    Object.defineProperties(messages, { scrollHeight: { get: () => 1_000 }, clientHeight: { get: () => 400 } });
    messages.scrollTop = 120; // reviewing mid-chat, not at the bottom
    row.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400, left: 0, right: 600, x: 0, y: 100, width: 600, toJSON: () => ({}) }) as DOMRect;
    messages.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600, left: 0, right: 800, x: 0, y: 0, width: 800, toJSON: () => ({}) }) as DOMRect;

    row.click();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(messages.scrollTop).toBe(120); // left untouched
  });
});
