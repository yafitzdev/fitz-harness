import type { ArtifactKind } from "@fitz/protocol";
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9_-]+)?$/i;
const CODE_MIMES = new Set(["application/json", "application/xml", "application/javascript", "application/typescript", "text/css", "text/csv", "text/markdown", "text/x-python", "text/x-rust"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/ogg"]);
const FILE_EXTENSION_MIME: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", ogv: "video/ogg",
  wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
  pdf: "application/pdf",
};
export function normalizeMimeType(value: string): string { const mime = value.trim().toLowerCase(); if (!MIME_PATTERN.test(mime)) throw new TypeError("Invalid MIME type"); return mime; }
export function inferMimeTypeFromFilename(name: string, fallback = "application/octet-stream"): string { const extension = name.split(".").pop()?.toLowerCase() ?? ""; return FILE_EXTENSION_MIME[extension] ?? fallback; }
export function extensionForMimeType(mimeType: string): string | undefined { const normalized = normalizeMimeType(mimeType).split(";", 1)[0]; return Object.entries(FILE_EXTENSION_MIME).find(([, candidate]) => candidate === normalized)?.[0]; }
export function classifyArtifact(mimeType: string, name = ""): ArtifactKind { const mime = normalizeMimeType(mimeType).split(";", 1)[0]!; if (mime === "text/plain") return codeExtension(name) ? "code" : "text"; if (mime.startsWith("text/") || CODE_MIMES.has(mime)) return "code"; if (IMAGE_MIMES.has(mime)) return "image"; if (AUDIO_MIMES.has(mime)) return "audio"; if (VIDEO_MIMES.has(mime)) return "video"; if (mime === "application/pdf") return "pdf"; return "binary"; }
export function canPreview(kind: ArtifactKind): boolean { return kind !== "binary"; }
/** Preview size bounds (design doc §5.11) shared by the desktop base64 bridge
 *  and host tooling: text stays tight, image/audio align with the coordinator's
 *  artifact write caps (25 MiB / 200 MiB), video is capped below the 1 GiB
 *  write cap because whole-file base64 over IPC is impractical at that size,
 *  and unknown binaries keep the legacy 10 MB bound. */
export const MAX_PREVIEW_BYTES = { text: 2 * 1024 * 1024, image: 25 * 1024 * 1024, audio: 200 * 1024 * 1024, video: 250 * 1024 * 1024, binary: 10 * 1024 * 1024 };
/** Maximum bytes a preview bridge may carry for a MIME type. Prefix-based for
 *  image/audio/video (unlike the stricter `classifyArtifact` allowlist) so
 *  desktop extension maps like `.mov`/`.m4a`/`.svg` pick the right cap even
 *  though previewability stays an explicit-kind decision. */
export function maxPreviewBytes(mimeType: string): number { const mime = normalizeMimeType(mimeType).split(";", 1)[0]!; if (mime.startsWith("text/") || CODE_MIMES.has(mime)) return MAX_PREVIEW_BYTES.text; if (mime.startsWith("image/")) return MAX_PREVIEW_BYTES.image; if (mime.startsWith("audio/")) return MAX_PREVIEW_BYTES.audio; if (mime.startsWith("video/")) return MAX_PREVIEW_BYTES.video; return MAX_PREVIEW_BYTES.binary; }
function codeExtension(name: string): boolean { return /\.(?:c|cc|cpp|cs|css|go|html|java|js|jsx|json|md|py|rb|rs|sh|sql|ts|tsx|xml|ya?ml)$/i.test(name); }
