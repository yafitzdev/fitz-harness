// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { setMarkdown } from "./markdown.js";

describe("Markdown lists", () => {
  it("keeps blank-separated ordered items in one list so numbering advances", () => {
    const target = document.createElement("div");
    setMarkdown(target, "1. First\n\n1. Second\n\n1. Third");

    const lists = target.querySelectorAll("ol");
    expect(lists).toHaveLength(1);
    expect([...lists[0]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["First", "Second", "Third"]);
  });

  it("preserves a non-default ordered-list start", () => {
    const target = document.createElement("div");
    setMarkdown(target, "4. Fourth\n5. Fifth");
    expect(target.querySelector("ol")?.getAttribute("start")).toBe("4");
  });
});
