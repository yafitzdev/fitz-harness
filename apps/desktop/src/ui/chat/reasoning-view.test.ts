// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { ReasoningView } from "./reasoning-view.js";

beforeEach(() => document.body.replaceChildren());

describe("ReasoningView", () => {
  it("renders provider-native reasoning directly in the work feed", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);

    expect(view.element.className).toContain("reasoning-activity");
    expect(view.element).toBeInstanceOf(HTMLDetailsElement);
    expect((view.element as HTMLDetailsElement).open).toBe(false);
    expect(view.element.querySelector("summary")?.textContent).toBe("Reasoning");
    expect(view.element.classList.contains("running")).toBe(true);
    expect(view.element.querySelector(".agent-activity-summary")).toBeNull();
    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("");
  });

  it("streams reasoning deltas into the visible content without touching chat", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);
    view.appendDelta("Let me inspect ");
    view.appendDelta("the codebase.");

    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("Let me inspect the codebase.");
    expect(view.element.classList.contains("message")).toBe(true);
  });

  it("completes the segment without replacing the model's text", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);
    view.appendDelta("done thinking");

    view.complete();

    expect(view.element.classList.contains("running")).toBe(false);
    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("done thinking");
  });
});
