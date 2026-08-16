// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { appendMarkdown, normalizeResourceReference, setMarkdown } from "./markdown.js";

describe("Streaming Markdown visibility", () => {
  it("reveals an assistant body that was hidden while it was empty", () => {
    const target = document.createElement("div");
    target.hidden = true;

    appendMarkdown(target, "Visible answer");

    expect(target.hidden).toBe(false);
    expect(target.textContent).toBe("Visible answer");
  });
});

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
  it("renders local resources as links without registering them in the repository", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      // Backtick file references remain clickable; remote URLs are left out
      // of the local Inspector repository contract entirely.
      setMarkdown(target, "See `src/app.ts` and https://example.com/x.");
      expect(target.querySelector("a.resource-link")?.dataset.resource).toBe("src/app.ts");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("fitz:resource-appeared", listener);
    }
  });

  it("keeps generated-looking plain-text paths clickable without treating mentions as artifacts", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      setMarkdown(target, "Wrote docs/guide.md with the full walkthrough.");
      expect(target.querySelector("a.resource-link")?.dataset.resource).toBe("docs/guide.md");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("fitz:resource-appeared", listener);
    }
  });

  it("does not turn engine names in ordinary prose into file links", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      setMarkdown(target, "Engine instances: NInfer/llama.cpp/vLLM processes in WSL/Linux.");
      setMarkdown(target, "Engine binary: `NInfer/llama.cpp`.");
      expect(target.querySelectorAll("a.resource-link")).toHaveLength(0);
      expect(listener).not.toHaveBeenCalled();
      expect(target.textContent).toContain("NInfer/llama.cpp");
    } finally {
      window.removeEventListener("fitz:resource-appeared", listener);
    }
  });

  it("keeps explicit inline file references clickable while hiding backticks", () => {
    const target = document.createElement("div");
    const listener = vi.fn();
    window.addEventListener("fitz:resource-appeared", listener);
    try {
      setMarkdown(target, "**File:** `storage/sqlite-store.ts`");
      const link = target.querySelector<HTMLAnchorElement>("a.resource-link");
      expect(link?.dataset.resource).toBe("storage/sqlite-store.ts");
      expect(link?.textContent).toBe("storage/sqlite-store.ts");
      expect(target.textContent).not.toContain("`");
      expect(listener).not.toHaveBeenCalled();
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
      expect(target.querySelector("a.resource-link")?.dataset.resource).toBe("llama.cpp/tests/test-unified-mixed-replay.cpp");
      expect(listener).not.toHaveBeenCalled();
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
