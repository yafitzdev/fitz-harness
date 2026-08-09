// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { isFollowingLatest, resumeFollowingLatest, scrollToLatestIfFollowing } from "./conversation-scroll.js";

function transcript() {
  const messages = document.createElement("main");
  let scrollHeight = 1_000;
  let clientHeight = 400;
  Object.defineProperties(messages, {
    scrollHeight: { get: () => scrollHeight },
    clientHeight: { get: () => clientHeight },
  });
  return {
    messages,
    setHeight: (value: number) => { scrollHeight = value; },
    setViewport: (value: number) => { clientHeight = value; },
  };
}

beforeEach(() => document.body.replaceChildren());

describe("conversation follow mode", () => {
  it("keeps new live output pinned while the reader is at the bottom", () => {
    const { messages, setHeight } = transcript();
    messages.scrollTop = 600;
    messages.dispatchEvent(new Event("scroll"));
    setHeight(1_240);
    scrollToLatestIfFollowing(messages);
    expect(messages.scrollTop).toBe(1_240);
  });

  it("does not steal the scroll position while the reader is reviewing older output", () => {
    const { messages, setHeight } = transcript();
    isFollowingLatest(messages);
    messages.scrollTop = 250;
    messages.dispatchEvent(new Event("scroll"));
    expect(isFollowingLatest(messages)).toBe(false);
    setHeight(1_240);
    scrollToLatestIfFollowing(messages);
    expect(messages.scrollTop).toBe(250);
  });

  it("resumes follow mode after explicit navigation to the latest message", () => {
    const { messages, setHeight } = transcript();
    messages.scrollTop = 100;
    messages.dispatchEvent(new Event("scroll"));
    resumeFollowingLatest(messages);
    setHeight(1_300);
    scrollToLatestIfFollowing(messages);
    expect(messages.scrollTop).toBe(1_300);
  });
});
