import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { ArtifactKind, ArtifactRecord } from "@fitz/protocol";
import { prepareAttachment } from "./attachment-content.js";

describe("chat attachment preparation", () => {
  it("extracts real PDF text for the model", async () => {
    const bytes = minimalPdf(["Sample PDF File", "Page Two"]);
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

/** Builds a complete, byte-offset-correct PDF so this test owns its fixture. */
function minimalPdf(pages: string[]): Uint8Array {
  const pageObjectIds = pages.map((_, index) => 3 + index);
  const fontObjectId = 3 + pages.length;
  const contentObjectIds = pages.map((_, index) => fontObjectId + 1 + index);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pages.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`),
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    ...pages.map((text) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`;
    }),
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}
