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

describe("Post-generation rules at render time", () => {
  it("hides backticks and bold markers from rendered assistant output", () => {
    const target = document.createElement("div");
    setMarkdown(target, "Done — created `docs/project-overview.html` with **no** backticks.");
    expect(target.textContent).toBe("Done — created docs/project-overview.html with no backticks.");
    expect(target.textContent).not.toContain("`");
  });

  it("flattens headings into plain prose", () => {
    const target = document.createElement("div");
    setMarkdown(target, "### Summary\n\nThe work is done.");
    expect([...target.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Summary", "The work is done."]);
    expect(target.querySelector("h1, h2, h3")).toBeNull();
  });

  it("keeps fenced code blocks literal while cleaning the surrounding prose", () => {
    const target = document.createElement("div");
    setMarkdown(target, "Run:\n```bash\necho `date`; # **not bold**\n```\nThen open `app.ts`.");
    expect(target.textContent).toContain("echo `date`; # **not bold**");
    expect(target.textContent).not.toContain("`app.ts`");
    expect(target.textContent).toContain("app.ts");
  });
});
