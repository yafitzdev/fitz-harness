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
    expect(calls.appendWork).toHaveBeenCalledOnce();
    expect(messages.textContent).toContain("Video generation in progress");

    feed.render({ id: "job-1", modality: "video", status: "completed", completedAt: "now" }, undefined, { id: "artifact-1", name: "clip.mp4" });
    expect(calls.appendAssistant).toHaveBeenCalledWith("Here is your video!", "now");
    expect(messages.querySelector(".media-result-message .media-job-notice.completed")).not.toBeNull();
    expect(messages.textContent).toContain("Video ready");
    expect(messages.textContent).toContain("clip.mp4");
    expect(calls.finishWork).toHaveBeenCalledWith("now");
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
});
