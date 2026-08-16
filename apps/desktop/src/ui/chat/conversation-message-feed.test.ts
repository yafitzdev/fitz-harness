// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationMessageFeed } from "./conversation-message-feed.js";

function setup(active = false) {
  const messages = document.createElement("main");
  const activity = { finishWork: vi.fn(), appendCommentary: vi.fn((node: HTMLElement) => messages.append(node)) };
  const actions = { attach: vi.fn() };
  const openAttachment = vi.fn();
  const loadAttachmentPreview = vi.fn(async () => "data:image/png;base64,AAAA");
  const feed = new ConversationMessageFeed({ messages, activity, actions, runActive: () => active, projectRoot: () => "C:\\work", openAttachment, loadAttachmentPreview });
  return { feed, messages, activity, actions, openAttachment, loadAttachmentPreview };
}

beforeEach(() => document.body.replaceChildren());

describe("ConversationMessageFeed", () => {
  it("renders actionable user messages and clears landing content", () => {
    const { feed, messages, activity, actions } = setup();
    const landing = document.createElement("div");
    landing.className = "landing";
    messages.append(landing);
    feed.append("user", "hello", "now");
    expect(messages.querySelector(".landing")).toBeNull();
    expect(messages.textContent).toBe("hello");
    expect(actions.attach).toHaveBeenCalledOnce();
    expect(activity.finishWork).toHaveBeenCalledWith("now", "next-message");
  });

  it("renders sent attachments as clickable image and file tiles", async () => {
    const { feed, messages, openAttachment, loadAttachmentPreview } = setup();
    const image = { id: "image-1", name: "shot.png", mimeType: "image/png", kind: "image" };
    const file = { id: "file-1", name: "notes.txt", mimeType: "text/plain", kind: "text" };
    feed.append("user", "analyse this", undefined, [image, file]);
    await vi.waitFor(() => expect(messages.querySelector<HTMLImageElement>(".message-attachment img")?.src).toContain("data:image/png"));
    expect(messages.querySelectorAll(".message-attachment")).toHaveLength(2);
    expect(messages.textContent).toContain("shot.png");
    expect(messages.textContent).toContain("notes.txt");
    expect(loadAttachmentPreview).toHaveBeenCalledWith(image);
    (messages.querySelector(".message-attachment") as HTMLButtonElement).click();
    expect(openAttachment).toHaveBeenCalledWith(image);
  });

  it("does not count the idle gap before a later user message as agent work", () => {
    const { feed, activity } = setup();
    feed.append("user", "follow up", "2026-08-09T06:35:43.888Z");
    expect(activity.finishWork).toHaveBeenCalledWith("2026-08-09T06:35:43.888Z", "next-message");
  });

  it("uses a final assistant timestamp as the completed-work boundary", () => {
    const { feed, activity } = setup();
    feed.append("assistant", "done", "2026-08-09T06:35:47.809Z");
    expect(activity.finishWork).toHaveBeenCalledWith("2026-08-09T06:35:47.809Z", "completed");
  });

  it("appends asynchronous peer results without closing unrelated restored work", () => {
    const { feed, messages, activity, actions } = setup();
    feed.appendDetached("assistant", "media failed", "2026-08-09T06:36:07.922Z");
    expect(messages.textContent).toBe("media failed");
    expect(actions.attach).toHaveBeenCalledOnce();
    expect(activity.finishWork).not.toHaveBeenCalled();
  });

  it("routes commentary through the activity timeline", () => {
    const { feed, activity } = setup(true);
    const body = feed.appendCommentary("**Checking**", "then");
    expect(body.textContent).toBe("Checking");
    expect(activity.appendCommentary).toHaveBeenCalledWith(body.parentElement, "then");
  });

  it("summarizes created and edited files relative to the project", () => {
    const { feed, messages } = setup();
    feed.appendChangeSummary([{ path: "C:\\work\\new.ts", action: "created" }, { path: "C:\\work\\old.ts", action: "edited" }]);
    expect(messages.textContent).toContain("2 files: 1 created, 1 edited");
    expect(messages.textContent).toContain("new.ts");
    expect(messages.textContent).not.toContain("C:\\work");
  });

  it("renders long failures as accessible plain-text alerts", () => {
    const { feed, messages, actions } = setup();
    const failure = `Request failed: ${"unbroken".repeat(80)}`;
    const body = feed.append("system", failure);
    const article = body.closest("article");
    expect(article?.getAttribute("role")).toBe("alert");
    expect(article?.getAttribute("aria-live")).toBe("polite");
    expect(body.textContent).toBe(failure);
    expect(body.classList.contains("markdown")).toBe(false);
    expect(actions.attach).not.toHaveBeenCalled();
    expect(messages.textContent).toContain("Request failed");
  });
});
