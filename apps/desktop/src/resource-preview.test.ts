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

  it("classifies rendered, source, and binary files", () => {
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("site.HTML")).toBe("html");
    expect(previewKind("app.ts")).toBe("code");
    expect(previewKind("notes.txt")).toBe("text");
    expect(previewKind("photo.PNG")).toBe("image");
    expect(previewKind("logo.svg")).toBe("image");
    expect(previewKind("manual.pdf")).toBe("pdf");
    expect(previewKind("song.mp3")).toBe("audio");
    expect(previewKind("clip.mp4")).toBe("video");
  });

  it("reads project-relative and explicitly referenced absolute files while blocking relative traversal", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-"));
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(root, "README.md"), "# Hello\n");
    await writeFile(join(parent, "secret.txt"), "nope");
    await expect(readProjectResource(root, "README.md:1")).resolves.toMatchObject({ kind: "markdown", content: "# Hello\n", line: 1 });
    await expect(readProjectResource(root, join(parent, "secret.txt"))).resolves.toMatchObject({ kind: "text", content: "nope" });
    await expect(readProjectResource(root, "../secret.txt")).rejects.toThrow("File not found");
  });

  it("resolves a bare filename from directories disclosed by agent tools", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-hints-"));
    const root = join(parent, "project");
    const listedDirectory = join(parent, "agent-output");
    await mkdir(root);
    await mkdir(listedDirectory);
    await writeFile(join(listedDirectory, "tic-tac-toe.ts"), "export const game = true;\n");
    await expect(readProjectResource(root, "tic-tac-toe.ts", [listedDirectory])).resolves.toMatchObject({ kind: "code", name: "tic-tac-toe.ts" });
    await expect(readProjectResource(root, "missing.ts", [listedDirectory])).rejects.toThrow("File not found: missing.ts");
  });

  it("resolves shortened package paths from an absolute file disclosed by an agent tool", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-suffix-"));
    const root = join(parent, "project");
    const actual = join(root, "packages", "storage", "src", "sqlite-store.ts");
    await mkdir(join(root, "packages", "storage", "src"), { recursive: true });
    await writeFile(actual, "export const store = true;\n");

    await expect(readProjectResource(root, "storage/src/sqlite-store.ts", [actual]))
      .resolves.toMatchObject({ kind: "code", path: actual, name: "sqlite-store.ts" });
  });

  it("previews images as base64 with their MIME type instead of failing on NUL bytes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-image-"));
    const root = join(parent, "project");
    await mkdir(root);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    await writeFile(join(root, "photo.png"), png);
    const preview = await readProjectResource(root, "photo.png");
    expect(preview.kind).toBe("image");
    expect(preview.mimeType).toBe("image/png");
    expect(preview.base64).toBe(png.toString("base64"));
    expect(preview.content).toBe("");
    expect(preview.size).toBe(png.length);
  });

  it("previews PDFs as base64 with the PDF MIME type", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-pdf-"));
    const root = join(parent, "project");
    await mkdir(root);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    await writeFile(join(root, "manual.pdf"), pdf);
    const preview = await readProjectResource(root, "manual.pdf");
    expect(preview.kind).toBe("pdf");
    expect(preview.mimeType).toBe("application/pdf");
    expect(preview.base64).toBe(pdf.toString("base64"));
  });

  it("allows binary previews above the 2 MB text cap and applies MIME-aware bounds", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-bin-"));
    const root = join(parent, "project");
    await mkdir(root);
    // A 3 MB image would previously fail the shared 2 MB cap; binary previews get MIME-aware caps.
    await writeFile(join(root, "large.png"), Buffer.alloc(3 * 1024 * 1024, 7));
    await expect(readProjectResource(root, "large.png")).resolves.toMatchObject({ kind: "image", mimeType: "image/png" });
    // Video/audio get the raised media caps (~150–250 MiB, design doc §5.11):
    // an 11 MiB clip that used to hit the flat 10 MB binary cap now previews.
    await writeFile(join(root, "clip.mp4"), Buffer.alloc(11 * 1024 * 1024, 7));
    await expect(readProjectResource(root, "clip.mp4")).resolves.toMatchObject({ kind: "video", mimeType: "video/mp4" });
    await writeFile(join(root, "song.wav"), Buffer.alloc(11 * 1024 * 1024, 7));
    await expect(readProjectResource(root, "song.wav")).resolves.toMatchObject({ kind: "audio", mimeType: "audio/wav" });
    // Images cap at 25 MiB (aligned with the host image artifact cap).
    await writeFile(join(root, "huge.png"), Buffer.alloc(25 * 1024 * 1024 + 1, 7));
    await expect(readProjectResource(root, "huge.png")).rejects.toThrow("25 MB maximum");
  });

  it("still rejects unknown binary files and oversized text files gracefully", async () => {
    const parent = await mkdtemp(join(tmpdir(), "fitz-preview-unknown-"));
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await expect(readProjectResource(root, "blob.bin")).rejects.toThrow("Binary preview is not available yet");
    await writeFile(join(root, "big.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await expect(readProjectResource(root, "big.txt")).rejects.toThrow("2 MB maximum");
  });
});
