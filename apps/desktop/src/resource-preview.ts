import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { maxPreviewBytes } from "@fitz/media";

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".json", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".xml", ".yaml", ".yml",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"]);

export type PreviewKind = "markdown" | "html" | "code" | "text" | "image" | "pdf" | "audio" | "video";
export interface ResourcePreview {
  kind: PreviewKind;
  name: string;
  path: string;
  /** UTF-8 text for text-like kinds; empty for binary kinds (see `base64`). */
  content: string;
  size: number;
  line?: number;
  /** MIME type for binary previews (image/pdf/audio/video). */
  mimeType?: string;
  /** Base64 payload for binary previews. */
  base64?: string;
}

export async function readProjectResource(projectRoot: string, reference: string, searchRoots: string[] = []): Promise<ResourcePreview> {
  if (!isAbsolute(projectRoot)) throw new Error("A valid absolute project path is required");
  const parsed = parseFileReference(reference);
  if (!parsed.path) throw new Error("A file path is required");
  const root = await realpath(projectRoot);
  const explicitAbsolutePath = isAbsolute(parsed.path);
  const filePath = explicitAbsolutePath
    ? await resolveExistingFile(parsed.path, reference)
    : await resolveRelativeReference(root, parsed.path, searchRoots);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error("Only regular files can be previewed");
  const kind = previewKind(filePath);
  const binaryKind = kind === "image" || kind === "pdf" || kind === "audio" || kind === "video";
  if (binaryKind) {
    const maxBytes = maxPreviewBytes(mimeTypeFor(filePath));
    if (metadata.size > maxBytes) throw new Error(`This file is too large to preview (${maxBytes / (1024 * 1024)} MB maximum)`);
    const bytes = await readFile(filePath);
    return { kind, name: basename(filePath), path: filePath, content: "", size: metadata.size, mimeType: mimeTypeFor(filePath), base64: bytes.toString("base64") };
  }
  if (metadata.size > MAX_TEXT_PREVIEW_BYTES) throw new Error("This file is too large to preview (2 MB maximum)");
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) throw new Error("Binary preview is not available yet");
  const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { kind, name: basename(filePath), path: filePath, content, size: metadata.size, ...(parsed.line ? { line: parsed.line } : {}) };
}

async function resolveRelativeReference(projectRoot: string, reference: string, searchRoots: string[]): Promise<string> {
  for (const suppliedRoot of [projectRoot, ...searchRoots.slice(0, 32)]) {
    if (!isAbsolute(suppliedRoot)) continue;
    let canonicalRoot: string;
    try { canonicalRoot = await realpath(suppliedRoot); } catch { continue; }
    let base = canonicalRoot;
    try { if ((await stat(canonicalRoot)).isFile()) base = dirname(canonicalRoot); } catch { continue; }
    const candidate = resolve(base, reference);
    const fromBase = relative(base, candidate);
    if (!fromBase || fromBase.startsWith("..") || isAbsolute(fromBase)) continue;
    try {
      const filePath = await realpath(candidate);
      const canonicalRelative = relative(base, filePath);
      if (!canonicalRelative || canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) continue;
      return filePath;
    } catch { /* Try the next directory disclosed by an agent tool. */ }
  }
  throw new Error(`File not found: ${reference}`);
}

async function resolveExistingFile(path: string, reference: string): Promise<string> {
  try { return await realpath(path); } catch { throw new Error(`File not found: ${reference}`); }
}

export function parseFileReference(reference: string): { path: string; line?: number } {
  let value = reference.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { value = value.replace(/^file:\/\//i, ""); }
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  }
  const hashLine = value.match(/#L(\d+)(?:C\d+)?$/i);
  if (hashLine) return { path: decodePath(value.slice(0, hashLine.index)), line: Number(hashLine[1]) };
  const colonLine = value.match(/:(\d+)(?::\d+)?$/);
  if (colonLine && !(colonLine.index === 1 && /^[A-Za-z]:/.test(value))) return { path: decodePath(value.slice(0, colonLine.index)), line: Number(colonLine[1]) };
  return { path: decodePath(value) };
}

export function previewKind(path: string): PreviewKind {
  const extension = extname(path).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (PDF_EXTENSIONS.has(extension)) return "pdf";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "text";
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
};

function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
