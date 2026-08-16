// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationLayout } from "./conversation-layout.js";

class ResizeObserverStub {
  observe = vi.fn();
}

class MutationObserverStub {
  observe = vi.fn();
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("MutationObserver", MutationObserverStub);
});

afterEach(() => vi.unstubAllGlobals());

function setup(inspectorOpen = false) {
  const workspace = document.createElement("main");
  const messages = document.createElement("section");
  const composer = document.createElement("div");
  const composerCard = document.createElement("div");
  const scrollButton = document.createElement("button");
  composerCard.className = "composer-card";
  composer.append(composerCard);
  workspace.append(messages, composer, scrollButton);
  if (inspectorOpen) workspace.classList.add("inspector-open");
  Object.defineProperties(workspace, { clientWidth: { value: 1_200, configurable: true } });
  Object.defineProperties(composer, { offsetHeight: { value: 180, configurable: true } });
  Object.defineProperties(composerCard, { offsetHeight: { value: 140, configurable: true } });
  Object.defineProperties(messages, {
    scrollHeight: { value: 1_000, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  messages.scrollTop = 400;
  messages.scrollTo = vi.fn();
  const layout = new ConversationLayout({ workspace, messages, composer, scrollButton, inspectorWidth: () => 320 });
  return { layout, workspace, messages, composer, scrollButton };
}

describe("ConversationLayout", () => {
  it("projects the conversation and composer onto one measured axis", () => {
    const { workspace } = setup();
    expect(workspace.style.getPropertyValue("--conversation-viewport")).toBe("1200px");
    expect(workspace.style.getPropertyValue("--conversation-width")).toBe("768px");
    expect(workspace.style.getPropertyValue("--conversation-gutter")).toBe("216px");
    expect(workspace.style.getPropertyValue("--composer-height")).toBe("180px");
    expect(workspace.style.getPropertyValue("--composer-card-height")).toBe("140px");
  });

  it("subtracts the inspector before calculating compact conversation geometry", () => {
    const { workspace } = setup(true);
    expect(workspace.style.getPropertyValue("--conversation-viewport")).toBe("880px");
    expect(workspace.style.getPropertyValue("--conversation-width")).toBe("768px");
    expect(workspace.style.getPropertyValue("--conversation-gutter")).toBe("56px");
  });

  it("shows the latest-message control only when the transcript is away from the bottom", () => {
    const { layout, messages, scrollButton } = setup();
    layout.updateScrollButton();
    expect(scrollButton.hidden).toBe(false);
    messages.scrollTop = 590;
    layout.updateScrollButton();
    expect(scrollButton.hidden).toBe(true);

    messages.scrollTop = 0;
    messages.append(Object.assign(document.createElement("div"), { className: "landing" }));
    layout.updateScrollButton();
    expect(scrollButton.hidden).toBe(true);
  });

  it("resumes follow mode and scrolls smoothly when requested", () => {
    const { layout, messages } = setup();
    layout.scrollToBottom();
    expect(messages.scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });
  });
});
