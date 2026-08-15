import { extname } from "node:path";
import { OfficeParser, type SupportedFileType } from "officeparser";
import type { ArtifactRecord } from "@fitz/protocol";

export interface PreparedAttachment {
  text?: string;
  imageDataUrl?: string;
}

const OFFICE_TYPES: Readonly<Record<string, SupportedFileType>> = {
  ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx",
  ".odt": "odt", ".ods": "ods", ".odp": "odp",
  ".pdf": "pdf", ".rtf": "rtf", ".epub": "epub",
};

const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".mdx", ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less",
  ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".php", ".java", ".kt", ".kts", ".swift",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".go", ".rs", ".scala", ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".psm1", ".bat", ".cmd", ".sql", ".graphql", ".gql", ".proto", ".tex", ".log", ".diff", ".patch",
  ".svg", ".srt", ".vtt", ".ics", ".vcf", ".properties", ".env", ".gitignore", ".dockerfile",
]);

/** Converts every accepted artifact into a model-visible representation.
 * Rich documents are extracted to text, images use the model's vision input,
 * and opaque media/binaries remain explicit in the prompt instead of being
 * silently dropped or causing the whole message to lose its attachments. */
export async function prepareAttachment(artifact: ArtifactRecord, bytes: Uint8Array): Promise<PreparedAttachment> {
  const extension = extname(artifact.name).toLowerCase();
  if (artifact.kind === "image" && artifact.mimeType.startsWith("image/")) {
    return { imageDataUrl: `data:${artifact.mimeType};base64,${Buffer.from(bytes).toString("base64")}` };
  }

  const officeType = OFFICE_TYPES[extension] ?? (artifact.mimeType === "application/pdf" ? "pdf" : undefined);
  if (officeType) {
    const ast = await OfficeParser.parseOffice(Buffer.from(bytes), {
      fileType: officeType,
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
    });
    const extracted = ast.toText().trim();
    if (!extracted) return { text: attachmentNotice(artifact, "The document contained no extractable text. Scanned pages may require OCR or a vision-capable image export.") };
    return { text: attachmentBlock(artifact, extracted, `extracted ${officeType.toUpperCase()} content`) };
  }

  if (artifact.mimeType.startsWith("text/") || TEXT_EXTENSIONS.has(extension) || looksLikeText(bytes)) {
    return { text: attachmentBlock(artifact, new TextDecoder("utf-8", { fatal: false }).decode(bytes), "decoded text content") };
  }

  if (artifact.kind === "audio") return { text: attachmentNotice(artifact, "The audio file is attached, but this chat model accepts text and images rather than audio samples. No transcript was available.") };
  if (artifact.kind === "video") return { text: attachmentNotice(artifact, "The video file is attached, but this chat model accepts text and images rather than video streams. No transcript or frame extraction was available.") };
  return { text: attachmentNotice(artifact, "The binary file is attached, but its format has no safe text or image representation for this chat model.") };
}

function attachmentBlock(artifact: ArtifactRecord, content: string, representation: string): string {
  return `[BEGIN ATTACHMENT: ${artifact.name} | ${artifact.mimeType} | ${representation}]\n${content}\n[END ATTACHMENT: ${artifact.name}]`;
}

function attachmentNotice(artifact: ArtifactRecord, notice: string): string {
  return `[ATTACHMENT: ${artifact.name} | ${artifact.mimeType} | ${artifact.byteSize} bytes]\n${notice}`;
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.some((byte) => byte === 0)) return false;
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  const replacements = [...decoded].filter((character) => character === "\uFFFD").length;
  const controls = [...decoded].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\n" && character !== "\r" && character !== "\t";
  }).length;
  return replacements / Math.max(1, decoded.length) < 0.01 && controls / Math.max(1, decoded.length) < 0.01;
}
