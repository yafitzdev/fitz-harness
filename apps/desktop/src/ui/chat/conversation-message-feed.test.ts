// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationMessageFeed } from "./conversation-message-feed.js";

function setup(active = false) {
  const messages = document.createElement("main");
  const activity = { finishWork: vi.fn(), appendCommentary: vi.fn((node: HTMLElement) => messages.append(node)) };
  const actions = { attach: vi.fn() };
  const feed = new ConversationMessageFeed({ messages, activity, actions, runActive: () => active, projectRoot: () => "C:\\work" });
  return { feed, messages, activity, actions };
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
    expect(activity.finishWork).toHaveBeenCalledWith("now");
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
});
