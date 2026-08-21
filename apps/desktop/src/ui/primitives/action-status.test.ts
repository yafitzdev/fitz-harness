// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionStatusView } from "./action-status.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("ActionStatusView", () => {
  it("shows accessible action feedback and dismisses it", () => {
    vi.useFakeTimers();
    const workspace = document.createElement("main");
    document.body.append(workspace);
    const view = new ActionStatusView(document, { mount: workspace, dismissAfterMs: 100 });

    view.show("Approval failed", "error");

    expect(view.root.hidden).toBe(false);
    expect(view.root.textContent).toBe("Approval failed");
    expect(view.root.dataset.tone).toBe("error");
    expect(view.root.getAttribute("role")).toBe("alert");
    expect(view.root.parentElement).toBe(workspace);

    vi.advanceTimersByTime(100);
    expect(view.root.hidden).toBe(true);
  });

  it("replaces stale feedback and lets the user dismiss it", () => {
    const view = new ActionStatusView(document);
    view.show("Copied", "success");
    view.show("Cancel failed", "error");

    expect(view.root.textContent).toBe("Cancel failed");
    view.root.click();
    expect(view.root.hidden).toBe(true);
  });
});
