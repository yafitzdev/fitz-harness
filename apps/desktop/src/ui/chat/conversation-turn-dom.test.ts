// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { findDurableUserArticle } from "./conversation-turn-dom.js";

function article(role: "user" | "assistant", text: string, runId?: string): HTMLElement {
  const element = document.createElement("article");
  element.className = `message ${role}`;
  if (runId) element.dataset.runId = runId;
  const body = document.createElement("div"); body.className = "message-body"; body.textContent = text;
  element.append(body);
  return element;
}

describe("findDurableUserArticle", () => {
  it("keeps the original prompt when steering added newer user bubbles to the run", () => {
    const messages = document.createElement("main");
    const previousAnswer = article("assistant", "old answer", "old-run");
    const original = article("user", "same prompt");
    const firstAnswer = article("assistant", "partial", "current-run");
    const steer = article("user", "same prompt");
    const selected = article("assistant", "final", "current-run");
    messages.append(previousAnswer, original, firstAnswer, steer, selected);

    expect(findDurableUserArticle(messages, selected, "current-run", {
      messageId: "durable-original", sequence: 3, prompt: "same prompt",
    })).toBe(original);
  });

  it("prefers exact durable metadata over the text fallback", () => {
    const messages = document.createElement("main");
    const original = article("user", "rendered prompt"); original.dataset.transcriptId = "message-1";
    const duplicate = article("user", "rendered prompt");
    const selected = article("assistant", "answer", "run-1");
    messages.append(original, duplicate, selected);

    expect(findDurableUserArticle(messages, selected, "run-1", {
      messageId: "message-1", sequence: 1, prompt: "rendered prompt",
    })).toBe(original);
  });
});
