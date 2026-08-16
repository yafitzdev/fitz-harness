// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { WorkspacePageController } from "./workspace-pages.js";

describe("WorkspacePageController", () => {
  it("switches page visibility, rail selection, and conversation interactivity together", () => {
    const playbooks = document.createElement("section");
    const connections = document.createElement("section");
    const conversationNav = document.createElement("button");
    const connectionsNav = document.createElement("button");
    const setConversationInert = vi.fn();
    const controller = new WorkspacePageController({
      pages: { playbooks, connections },
      navigation: { conversation: conversationNav, connections: connectionsNav },
      setConversationInert,
    });

    controller.show("connections");

    expect(playbooks.hidden).toBe(true);
    expect(connections.hidden).toBe(false);
    expect(conversationNav.classList.contains("active")).toBe(false);
    expect(connectionsNav.classList.contains("active")).toBe(true);
    expect(setConversationInert).toHaveBeenLastCalledWith(true);

    controller.show("conversation");
    expect(playbooks.hidden).toBe(true);
    expect(connections.hidden).toBe(true);
    expect(conversationNav.classList.contains("active")).toBe(true);
    expect(setConversationInert).toHaveBeenLastCalledWith(false);
  });
});
