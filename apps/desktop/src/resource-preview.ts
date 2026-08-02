import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".json", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".xml", ".yaml", ".yml",
]);

export type PreviewKind = "markdown" | "html" | "code" | "text";
export interface ResourcePreview { kind: PreviewKind; name: string; path: string; content: string; size: number; line?: number }

export async function readProjectResource(projectRoot: string, reference: string): Promise<ResourcePreview> {
  if (!isAbsolute(projectRoot)) throw new Error("A valid absolute project path is required");
  const parsed = parseFileReference(reference);
  if (!parsed.path) throw new Error("A file path is required");
  const root = await realpath(projectRoot);
  const explicitAbsolutePath = isAbsolute(parsed.path);
  const candidate = explicitAbsolutePath ? parsed.path : resolve(root, parsed.path);
  const filePath = await realpath(candidate);
  if (!explicitAbsolutePath) {
    const fromRoot = relative(root, filePath);
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Relative file previews are limited to the active project");
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error("Only regular files can be previewed");
  if (metadata.size > MAX_PREVIEW_BYTES) throw new Error("This file is too large to preview (2 MB maximum)");
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) throw new Error("Binary preview is not available yet");
  const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { kind: previewKind(filePath), name: basename(filePath), path: filePath, content, size: metadata.size, ...(parsed.line ? { line: parsed.line } : {}) };
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
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "text";
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
