// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { ReasoningView } from "./reasoning-view.js";

beforeEach(() => document.body.replaceChildren());

describe("ReasoningView", () => {
  it("shows clean text without Markdown markers or formatted elements", () => {
    const view = new ReasoningView(true);
    view.appendDelta("## Next steps\n\nI'll inspect `retrieve` and ``_governed_evidence`` with **care**, *briefly*, and __check__ _again_.\n\n> Read [the guide](https://example.com).\n- [x] Inspect ´´query_pipeline.py´´.\n1. Remove ~~stale~~ code.");
    const content = view.element.querySelector(".reasoning-content")!;
    expect(content.textContent).toBe("Next steps\n\nI'll inspect retrieve and _governed_evidence with care, briefly, and check again.\n\nRead the guide.\nInspect query_pipeline.py.\nRemove stale code.");
    expect(content.childElementCount).toBe(0);
  });

  it("cleans markers as they arrive across streaming chunks", () => {
    const view = new ReasoningView(true);
    const content = view.element.querySelector(".reasoning-content")!;
    const chunks = ["Inspect ", "`", "query_", "pipeline.py", "`", " with ", "*", "*care", "*", "*."];
    for (const chunk of chunks) {
      view.appendDelta(chunk);
      expect(content.textContent).not.toMatch(/[`*]/);
    }
    expect(content.textContent).toBe("Inspect query_pipeline.py with care.");
    view.complete();
    expect(content.textContent).toBe("Inspect query_pipeline.py with care.");
  });

  it("preserves literal code, filenames, operators, and ordinary punctuation", () => {
    const view = new ReasoningView(false);
    view.appendDelta("C# uses snake_case and _private_field. It's 2 * 3 and 2**3, or x*y.\n`a_b * c_d` and \\*literal\\* stay readable.\n\n```python\nresult = a_b * c_d\n# Keep this code comment\n```\n\n~~~js\nconst label = `value`;\n~~~");
    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("C# uses snake_case and _private_field. It's 2 * 3 and 2**3, or x*y.\na_b * c_d and *literal* stay readable.\n\nresult = a_b * c_d\n# Keep this code comment\n\nconst label = `value`;");
  });

  it("keeps code fence language hints out of the live stream", () => {
    const view = new ReasoningView(true);
    for (const chunk of ["Example:\n", "`", "`", "`py", "thon", "\nprint(1)", "\n```", "\nDone."]) view.appendDelta(chunk);
    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("Example:\nprint(1)\nDone.");
  });

  it("renders saved reasoning exactly like the completed stream", () => {
    const source = "### Review\r\n\r\nRead `src/main.ts` and **check** [the notes](https://example.com).\r\n\r\n\r\nContinue.";
    const live = new ReasoningView(true);
    for (const char of source) live.appendDelta(char);
    live.complete();
    const saved = new ReasoningView(false);
    saved.appendDelta(source);
    saved.complete();
    expect(live.element.textContent).toBe(saved.element.textContent);
    expect(saved.element.textContent).toBe("Review\n\nRead src/main.ts and check the notes.\n\nContinue.");
  });

  it("keeps HTML inert while flattening link text and tables", () => {
    const view = new ReasoningView(false);
    view.appendDelta("<img src=x onerror=alert(1)>\n![diagram](image.png)\n\n| File | State |\n| --- | --- |\n| `app.ts` | **ready** |");
    expect(view.element.querySelector(".reasoning-content")?.textContent).toBe("<img src=x onerror=alert(1)>\ndiagram\n\nFile  State\napp.ts  ready");
    expect(view.element.querySelector("img, a, table, code, em, strong")).toBeNull();
  });

  it("renders provider-native reasoning directly in the work feed", () => {
    const view = new ReasoningView(true);
    document.body.append(view.element);

    expect(view.element.className).toContain("reasoning-activity");
    expect(view.element).toBeInstanceOf(HTMLDivElement);
    expect(view.element.querySelector("summary")).toBeNull();
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
