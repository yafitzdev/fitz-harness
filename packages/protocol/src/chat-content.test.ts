import { describe, expect, it } from "vitest";
import { chatContentBlockSource, isChatContentDocument, parseChatContent, withChatContentDocument } from "./chat-content.js";

describe("chat content documents", () => {
  it("indexes rich blocks without duplicating their source", () => {
    const source = [
      "Intro with [source](https://example.com).",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "| Name | Value |",
      "| --- | ---: |",
      "| A | 1 |",
      "",
      "![Architecture](images/system.svg \"System diagram\")",
      "",
      "[Open report](reports/result.pdf)",
      "",
      "[Listen](audio/result.mp3)",
      "",
      "[Explore](visualization.html)",
    ].join("\n");
    const document = parseChatContent(source);

    expect(document.blocks.map((block) => block.type)).toEqual([
      "markdown", "diagram", "markdown", "table", "markdown", "image", "markdown", "file", "markdown", "media", "markdown", "interactive",
    ]);
    expect(document.blocks.map((block) => chatContentBlockSource(source, block)).join("")).toBe(source);
    expect(JSON.stringify(document)).not.toContain("flowchart LR");
    expect(isChatContentDocument(document, source.length)).toBe(true);
  });

  it("keeps code, diffs, and display math as distinct typed blocks", () => {
    const source = "```ts\nconst n = 1;\n```\n```diff\n-old\n+new\n```\n$$\nx^2 + y^2\n$$";
    const document = parseChatContent(source);
    expect(document.blocks.map((block) => block.type)).toEqual(["code", "diff", "math"]);
    expect(document.blocks[0]).toMatchObject({ type: "code", language: "ts" });
  });

  it("adds documents to durable text and parses legacy content on read", () => {
    const enriched = withChatContentDocument({ text: "```mermaid\ngraph TD\nA-->B\n```", runId: "run" });
    expect(enriched.document).toMatchObject({ version: 1, blocks: [expect.objectContaining({ type: "diagram" })] });
    expect(withChatContentDocument(enriched)).toBe(enriched);
    expect(parseChatContent("unfinished paragraph").blocks).toEqual([
      { id: "markdown:0", type: "markdown", start: 0, end: 20 },
    ]);
  });

  it("rejects persisted documents with gaps, unknown blocks, or invalid typed metadata", () => {
    expect(isChatContentDocument({ version: 1, blocks: [{ id: "markdown:1", type: "markdown", start: 1, end: 2 }] }, 2)).toBe(false);
    expect(isChatContentDocument({ version: 1, blocks: [{ id: "unknown:0", type: "unknown", start: 0, end: 2 }] }, 2)).toBe(false);
    expect(isChatContentDocument({ version: 1, blocks: [{ id: "image:0", type: "image", start: 0, end: 2, reference: 42, alt: "x" }] }, 2)).toBe(false);
  });
});
