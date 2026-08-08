// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { normalizeResourceReference, setMarkdown } from "./markdown.js";

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

describe("Resource links in rendered output", () => {
  it("announces local resources as they render so they can join the artifact repository", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      // Backtick file references register; remote URLs are left out.
      setMarkdown(target, "See `src/app.ts` and https://example.com/x.");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { reference: "src/app.ts" } }));
    } finally {
      window.removeEventListener("fitz:resource-appeared", listener);
    }
  });

  it("announces plain-text file paths as they stream into the conversation", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      setMarkdown(target, "Wrote docs/guide.md with the full walkthrough.");
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { reference: "docs/guide.md" } }));
    } finally {
      window.removeEventListener("fitz:resource-appeared", listener);
    }
  });

  it("strips stray delimiters from streamed path fragments", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      // Mid-stream the agent wrote `(llama.cpp/...cpp` with no closing paren yet.
      setMarkdown(target, "See (llama.cpp/tests/test-unified-mixed-replay.cpp) next.");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { reference: "llama.cpp/tests/test-unified-mixed-replay.cpp" } }));
    } finally {
      window.removeEventListener("fitz:resource-appeared", listener);
    }
  });

  it("normalizes wrapped, backticked, and already-clean references", () => {
    expect(normalizeResourceReference("(llama.cpp/tests/test-unified-mixed-replay.cpp")).toBe("llama.cpp/tests/test-unified-mixed-replay.cpp");
    expect(normalizeResourceReference("(docs/guide.md)")).toBe("docs/guide.md");
    expect(normalizeResourceReference("`src/app.ts`")).toBe("src/app.ts");
    expect(normalizeResourceReference("src/app.ts")).toBe("src/app.ts");
    // Parens that are genuinely part of the name are left alone.
    expect(normalizeResourceReference("(draft) notes.md")).toBe("(draft) notes.md");
  });
});
