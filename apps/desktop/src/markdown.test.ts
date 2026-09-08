// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendMarkdown, configureChatContentRuntime, normalizeResourceReference, setMarkdown } from "./markdown.js";

beforeEach(() => {
  document.body.replaceChildren();
  configureChatContentRuntime({ openReference: (reference) => window.dispatchEvent(new CustomEvent("fitz:open-resource", { detail: { reference } })) });
});

describe("Streaming Markdown visibility", () => {
  it("reveals an assistant body that was hidden while it was empty", () => {
    const target = document.createElement("div");
    target.hidden = true;

    appendMarkdown(target, "Visible answer");

    expect(target.hidden).toBe(false);
    expect(target.textContent).toBe("Visible answer");
  });

  it("keeps completed block nodes stable while the final block streams", () => {
    const target = document.createElement("div");
    setMarkdown(target, "Intro\n\n```ts\nconst value = 1;\n```");
    const intro = target.firstElementChild;
    const code = target.children[1];

    appendMarkdown(target, "\n\nMore prose");

    expect(target.firstElementChild).toBe(intro);
    expect(target.children[1]).toBe(code);
    expect(target.textContent).toContain("More prose");
  });
});

describe("Typed rich content", () => {
  it("renders images, diffs, and standalone files as purpose-built blocks", () => {
    const target = document.createElement("div");
    setMarkdown(target, [
      "![Architecture](https://example.com/architecture.png)",
      "",
      "```diff",
      "+added",
      "-removed",
      "```",
      "",
      "[Open report](reports/result.pdf)",
    ].join("\n"));

    expect(target.querySelector<HTMLImageElement>(".chat-image img")?.src).toBe("https://example.com/architecture.png");
    expect(target.querySelector(".chat-content-diff code.language-diff")?.textContent).toContain("+added");
    expect(target.querySelector<HTMLButtonElement>(".chat-artifact-card.file")?.textContent).toContain("Open report");
  });

  it("falls back to an open-source action for unsafe or unresolved media", async () => {
    const target = document.createElement("div");
    const openReference = vi.fn();
    configureChatContentRuntime({ openReference, resolveMedia: async () => undefined });
    setMarkdown(target, "![Generated](javascript:unsafe)");
    await vi.waitFor(() => expect(target.querySelector(".chat-content-unavailable")).not.toBeNull());
    target.querySelector<HTMLButtonElement>(".chat-content-unavailable")?.click();
    expect(target.querySelector("img")).toBeNull();
    expect(openReference).toHaveBeenCalledWith("javascript:unsafe");
  });

  it("resolves local media and opens artifact cards through the configured runtime", async () => {
    const target = document.createElement("div");
    const openArtifact = vi.fn();
    const resolveMedia = vi.fn(async () => "data:audio/wav;base64,UklGRg==");
    configureChatContentRuntime({ openReference: vi.fn(), openArtifact, resolveMedia });
    setMarkdown(target, "[Listen](audio/result.mp3)\n\n[Open result](artifact://artifact-42/result.pdf)");

    await vi.waitFor(() => expect(target.querySelector<HTMLAudioElement>("audio")?.src).toContain("data:audio/wav"));
    expect(target.querySelector("audio")?.controls).toBe(true);
    expect(resolveMedia).toHaveBeenCalledWith("audio/result.mp3", "audio");
    target.querySelector<HTMLButtonElement>(".chat-artifact-card")?.click();
    expect(openArtifact).toHaveBeenCalledWith("artifact-42");
  });

  it("renders display math and gives diagrams a source fallback", async () => {
    const target = document.createElement("div");
    setMarkdown(target, "$$\nx^2 + y^2 = z^2\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```");

    await vi.waitFor(() => expect(target.querySelector(".chat-math math")).not.toBeNull());
    await vi.waitFor(() => expect(target.querySelector(".chat-diagram .chat-content-placeholder")).toBeNull());
    expect(target.querySelector(".chat-diagram-canvas, .chat-diagram .chat-content-failure")).not.toBeNull();
    expect(target.querySelector(".chat-diagram details")?.textContent).toContain("source");
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
