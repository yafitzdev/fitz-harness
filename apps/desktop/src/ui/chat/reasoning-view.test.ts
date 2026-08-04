// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { ReasoningView } from "./reasoning-view.js";

beforeEach(() => document.body.replaceChildren());

describe("ReasoningView", () => {
  it("renders a collapsible reasoning row that starts collapsed", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);

    expect(view.element.className).toContain("reasoning-activity");
    expect(view.element.classList.contains("running")).toBe(true);
    const summary = view.element.querySelector<HTMLButtonElement>(".agent-activity-summary")!;
    expect(summary.textContent).toContain("Thinking…");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    const details = view.element.querySelector<HTMLElement>(".reasoning-details")!;
    expect(details.hidden).toBe(true);
    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("");
  });

  it("streams reasoning deltas into the content body without touching chat", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);
    view.appendDelta("Let me inspect ");
    view.appendDelta("the codebase.");

    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("Let me inspect the codebase.");
    expect(view.element.classList.contains("message")).toBe(true);
  });

  it("completes the segment: stops running and settles the label", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);
    view.appendDelta("done thinking");

    view.complete();

    expect(view.element.classList.contains("running")).toBe(false);
    const summary = view.element.querySelector<HTMLButtonElement>(".agent-activity-summary")!;
    expect(summary.textContent).toContain("Thought through the approach");
  });

  it("toggles the details panel on click with aria-expanded kept in sync", () => {
    const view = new ReasoningView(false);
    document.body.append(view.element);
    const summary = view.element.querySelector<HTMLButtonElement>(".agent-activity-summary")!;
    const details = view.element.querySelector<HTMLElement>(".reasoning-details")!;

    summary.click();
    expect(details.hidden).toBe(false);
    expect(view.element.classList.contains("open")).toBe(true);
    expect(summary.getAttribute("aria-expanded")).toBe("true");

    summary.click();
    expect(details.hidden).toBe(true);
    expect(view.element.classList.contains("open")).toBe(false);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
  });
});
