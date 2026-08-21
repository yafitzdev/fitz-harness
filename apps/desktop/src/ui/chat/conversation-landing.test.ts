// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationLanding } from "./conversation-landing.js";

function setup() {
  const messages = document.createElement("main");
  const calls = { clearActivity: vi.fn(), createProject: vi.fn(), retryConnection: vi.fn(), updateTitles: vi.fn() };
  const landing = new ConversationLanding({ messages, ...calls });
  return { landing, messages, calls };
}

beforeEach(() => document.body.replaceChildren());

describe("ConversationLanding", () => {
  it("renders an empty new-chat sentinel without a logo or animation", () => {
    const { landing, messages, calls } = setup();
    landing.showNewChat();
    expect(messages.querySelector(".new-chat-landing")).toBeTruthy();
    expect(messages.querySelector("svg, .new-chat-ripple, h1, .starter-card")).toBeNull();
    expect(messages.textContent.trim()).toBe("");
    expect(calls.clearActivity).toHaveBeenCalledOnce();
  });

  it("renders home and retry actions without leaking previous content", () => {
    const { landing, messages, calls } = setup();
    messages.textContent = "old";
    landing.showHome();
    expect(messages.textContent).toContain("Bring your code. Build with Fitz.");
    messages.querySelector<HTMLButtonElement>(".primary-button")!.click();
    expect(calls.createProject).toHaveBeenCalledOnce();
    landing.showConnectionFailure("Connection refused");
    expect(messages.textContent).not.toContain("Bring your code");
    expect(messages.textContent).toContain("Connection refused");
    messages.querySelector<HTMLButtonElement>(".primary-button")!.click();
    expect(calls.retryConnection).toHaveBeenCalledOnce();
  });

  it("renders distinct connecting and offline recovery states", () => {
    const { landing, messages } = setup();
    landing.showConnectionPending();
    expect(messages.querySelector('[role="status"]')?.textContent).toContain("Starting Fitz host");
    expect(messages.querySelector("button")).toBeNull();
    landing.showConnectionPending(true);
    expect(messages.textContent).toContain("Restarting Fitz host");
    landing.showConnectionFailure("Timed out");
    expect(messages.querySelector('[role="alert"]')?.textContent).toContain("Timed out");
    expect(messages.querySelector("button")?.textContent).toBe("Try again");
  });
});
