// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationLanding } from "./conversation-landing.js";

function setup(project?: { id?: string; name?: string }) {
  const messages = document.createElement("main");
  const calls = { clearActivity: vi.fn(), setDraft: vi.fn(), focusComposer: vi.fn(), createProject: vi.fn(), retryConnection: vi.fn(), updateTitles: vi.fn() };
  const landing = new ConversationLanding({ messages, project: () => project, projectDetached: () => false, ...calls });
  return { landing, messages, calls };
}

beforeEach(() => document.body.replaceChildren());

describe("ConversationLanding", () => {
  it("renders the project-aware new-chat view and wires starter prompts", () => {
    const { landing, messages, calls } = setup({ id: "project-1", name: "Fitz" });
    landing.showNewChat();
    expect(messages.textContent).toContain("What should we build in Fitz?");
    messages.querySelector<HTMLButtonElement>(".starter-card")!.click();
    expect(calls.setDraft).toHaveBeenCalledWith("Explore and understand code");
    expect(calls.focusComposer).toHaveBeenCalledOnce();
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
