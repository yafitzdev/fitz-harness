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
  it("renders only the JEON lab Ripple mark for a new chat", () => {
    const { landing, messages, calls } = setup();
    landing.showNewChat();
    const mark = messages.querySelector<HTMLElement>('.new-chat-ripple[aria-label="JEON lab"]');
    expect(mark).toBeTruthy();
    expect(mark!.querySelectorAll("path")).toHaveLength(8);
    expect(messages.querySelector("h1, .starter-card")).toBeNull();
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
});
