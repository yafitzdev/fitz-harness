import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { ArtifactKind, ArtifactRecord } from "@fitz/protocol";
import { prepareAttachment } from "./attachment-content.js";

describe("chat attachment preparation", () => {
  it("extracts real PDF text for the model", async () => {
    const bytes = await readFile("sample-files/sample.pdf");
    const prepared = await prepareAttachment(artifact("sample.pdf", "application/pdf", "pdf", bytes.byteLength), bytes);
    expect(prepared.text).toContain("Sample PDF File");
    expect(prepared.text).toContain("Page Two");
  });

  it("extracts Office document text instead of sending compressed OOXML bytes", async () => {
    const bytes = minimalDocx("hidden Word document value");
    const prepared = await prepareAttachment(artifact("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "binary", bytes.byteLength), bytes);
    expect(prepared.text).toContain("hidden Word document value");
    expect(prepared.text).toContain("extracted DOCX content");
  });

  it("recognizes source and structured text even when the picker supplies an opaque MIME", async () => {
    const bytes = Buffer.from('{"hidden":"structured value"}');
    const prepared = await prepareAttachment(artifact("payload.json", "application/octet-stream", "binary", bytes.byteLength), bytes);
    expect(prepared.text).toContain('"hidden":"structured value"');
  });

  it("sends images as vision input", async () => {
    const prepared = await prepareAttachment(artifact("pixel.png", "image/png", "image", 3), Buffer.from("ABC"));
    expect(prepared).toEqual({ imageDataUrl: "data:image/png;base64,QUJD" });
  });

  it.each([
    ["voice.wav", "audio/wav", "audio"],
    ["clip.mp4", "video/mp4", "video"],
    ["archive.zip", "application/zip", "binary"],
  ] as const)("never silently drops %s", async (name, mimeType, kind) => {
    const prepared = await prepareAttachment(artifact(name, mimeType, kind, 4), new Uint8Array([0, 1, 2, 3]));
    expect(prepared.text).toContain(`[ATTACHMENT: ${name}`);
    expect(prepared.text).toMatch(/attached/i);
  });
});

function artifact(name: string, mimeType: string, kind: ArtifactKind, byteSize: number): ArtifactRecord {
  return { id: "artifact", sessionId: "session", name, mimeType, kind, byteSize, sha256: "hash", createdAt: new Date(0).toISOString(), metadata: {} };
}

function minimalDocx(text: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
  });
}
