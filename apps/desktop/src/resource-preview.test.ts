import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseFileReference, previewKind, readProjectResource } from "./resource-preview.js";

describe("desktop resource previews", () => {
  it("parses source locations without confusing Windows drive letters", () => {
    expect(parseFileReference("src/app.ts:42:7")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseFileReference("C:\\work\\app.ts#L19")).toEqual({ path: "C:\\work\\app.ts", line: 19 });
  });

  it("classifies rendered and source files", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("site.HTML")).toBe("html");
    expect(previewKind("app.ts")).toBe("code");
    expect(previewKind("notes.txt")).toBe("text");
  });

  it("reads project-relative and explicitly referenced absolute files while blocking relative traversal", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-"));
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(root, "README.md"), "# Hello\n");
    await writeFile(join(parent, "secret.txt"), "nope");
    await expect(readProjectResource(root, "README.md:1")).resolves.toMatchObject({ kind: "markdown", content: "# Hello\n", line: 1 });
    await expect(readProjectResource(root, join(parent, "secret.txt"))).resolves.toMatchObject({ kind: "text", content: "nope" });
    await expect(readProjectResource(root, "../secret.txt")).rejects.toThrow("limited to the active project");
  });
});
