import type { ArtifactKind } from "@fitz/protocol";
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9_-]+)?$/i;
const CODE_MIMES = new Set(["application/json", "application/xml", "application/javascript", "application/typescript", "text/css", "text/csv", "text/markdown", "text/x-python", "text/x-rust"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/ogg"]);
export function normalizeMimeType(value: string): string { const mime = value.trim().toLowerCase(); if (!MIME_PATTERN.test(mime)) throw new TypeError("Invalid MIME type"); return mime; }
export function classifyArtifact(mimeType: string, name = ""): ArtifactKind { const mime = normalizeMimeType(mimeType).split(";", 1)[0]!; if (mime === "text/plain") return codeExtension(name) ? "code" : "text"; if (mime.startsWith("text/") || CODE_MIMES.has(mime)) return "code"; if (IMAGE_MIMES.has(mime)) return "image"; if (AUDIO_MIMES.has(mime)) return "audio"; if (VIDEO_MIMES.has(mime)) return "video"; if (mime === "application/pdf") return "pdf"; return "binary"; }
export function canPreview(kind: ArtifactKind): boolean { return kind !== "binary"; }
function codeExtension(name: string): boolean { return /\.(?:c|cc|cpp|cs|css|go|html|java|js|jsx|json|md|py|rb|rs|sh|sql|ts|tsx|xml|ya?ml)$/i.test(name); }
