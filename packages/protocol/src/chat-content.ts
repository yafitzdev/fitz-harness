/** Versioned, ordered content stored with a chat message. Offsets refer to the
 * message's canonical `content.text`, so persistence does not duplicate large
 * answers while renderers still receive typed, stable blocks. */
export const CHAT_CONTENT_VERSION = 1 as const;

export interface ChatContentBlockBase {
  id: string;
  start: number;
  end: number;
}

export type ChatContentBlock =
  | (ChatContentBlockBase & { type: "markdown" })
  | (ChatContentBlockBase & { type: "code"; language?: string })
  | (ChatContentBlockBase & { type: "diff" })
  | (ChatContentBlockBase & { type: "table" })
  | (ChatContentBlockBase & { type: "diagram"; format: "mermaid" })
  | (ChatContentBlockBase & { type: "math"; display: true })
  | (ChatContentBlockBase & { type: "image"; reference: string; alt: string; title?: string })
  | (ChatContentBlockBase & { type: "media"; mediaType: "audio" | "video"; reference: string; label: string })
  | (ChatContentBlockBase & { type: "file"; reference: string; label: string; artifactId?: string })
  | (ChatContentBlockBase & { type: "interactive"; reference: string; label: string; artifactId?: string });

export interface ChatContentDocument {
  version: typeof CHAT_CONTENT_VERSION;
  blocks: ChatContentBlock[];
}

interface SourceLine { start: number; end: number; text: string }

export function parseChatContent(source: string): ChatContentDocument {
  const lines = sourceLines(source);
  const blocks: ChatContentBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const special = specialBlock(source, lines, index);
    if (special) {
      blocks.push(special.block);
      index = special.next;
      continue;
    }
    const startIndex = index;
    index += 1;
    while (index < lines.length && !specialBlock(source, lines, index)) index += 1;
    const start = lines[startIndex]!.start;
    const end = lines[index - 1]!.end;
    blocks.push({ id: blockId("markdown", start), type: "markdown", start, end });
  }
  if (!blocks.length && source.length) blocks.push({ id: blockId("markdown", 0), type: "markdown", start: 0, end: source.length });
  return { version: CHAT_CONTENT_VERSION, blocks };
}

export function isChatContentDocument(value: unknown, sourceLength?: number): value is ChatContentDocument {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== CHAT_CONTENT_VERSION) return false;
  const blocks = (value as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return false;
  let previousEnd = 0;
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!block || typeof block !== "object") return false;
    const candidate = block as Record<string, unknown>;
    if (typeof candidate.id !== "string" || ids.has(candidate.id) || typeof candidate.type !== "string"
      || !Number.isInteger(candidate.start) || !Number.isInteger(candidate.end)) return false;
    const start = candidate.start as number; const end = candidate.end as number;
    if (start !== previousEnd || end < start || (sourceLength !== undefined && end > sourceLength) || !validBlockShape(candidate)) return false;
    ids.add(candidate.id);
    previousEnd = end;
  }
  return sourceLength === undefined || previousEnd === sourceLength;
}

export function chatContentDocument(content: Readonly<Record<string, unknown>>): ChatContentDocument | undefined {
  const text = typeof content.text === "string" ? content.text : undefined;
  if (text === undefined) return undefined;
  return isChatContentDocument(content.document, text.length) ? content.document : parseChatContent(text);
}

/** Adds the versioned block index to durable message content. Legacy readers
 * continue to use `text`; legacy rows are parsed by `chatContentDocument`. */
export function withChatContentDocument(content: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (typeof content.text !== "string" || isChatContentDocument(content.document, content.text.length)) return content;
  return { ...content, document: parseChatContent(content.text) };
}

export function chatContentBlockSource(source: string, block: ChatContentBlock): string {
  return source.slice(block.start, block.end);
}

function specialBlock(source: string, lines: SourceLine[], index: number): { block: ChatContentBlock; next: number } | undefined {
  const line = lines[index]!;
  const fence = line.text.match(/^\s*```\s*([^`]*)$/);
  if (fence) {
    let next = index + 1;
    while (next < lines.length && !/^\s*```\s*$/.test(lines[next]!.text)) next += 1;
    if (next < lines.length) next += 1;
    const hint = (fence[1] ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    const end = next < lines.length ? lines[next - 1]!.end : source.length;
    const base = { start: line.start, end };
    if (hint === "mermaid") return { block: { ...base, id: blockId("diagram", line.start), type: "diagram", format: "mermaid" }, next };
    if (hint === "diff" || hint === "patch") return { block: { ...base, id: blockId("diff", line.start), type: "diff" }, next };
    return { block: { ...base, id: blockId("code", line.start), type: "code", ...(hint ? { language: hint } : {}) }, next };
  }
  if (line.text.trim() === "$$") {
    let next = index + 1;
    while (next < lines.length && lines[next]!.text.trim() !== "$$") next += 1;
    if (next < lines.length) next += 1;
    const end = next < lines.length ? lines[next - 1]!.end : source.length;
    return { block: { id: blockId("math", line.start), type: "math", start: line.start, end, display: true }, next };
  }
  if (looksLikeTable(lines, index)) {
    let next = index + 2;
    while (next < lines.length && lines[next]!.text.trim() && lines[next]!.text.includes("|")) next += 1;
    return { block: { id: blockId("table", line.start), type: "table", start: line.start, end: lines[next - 1]!.end }, next };
  }
  const image = line.text.match(/^\s*!\[([^\]]*)]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/);
  if (image) return { block: { id: blockId("image", line.start), type: "image", start: line.start, end: line.end, reference: image[2]!, alt: image[1]!, ...(image[3] ? { title: image[3] } : {}) }, next: index + 1 };
  const link = line.text.match(/^\s*\[([^\]]+)]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/);
  if (!link) return undefined;
  const reference = link[2]!; const label = link[1]!;
  const artifactId = reference.match(/^artifact:\/\/([^/?#]+)/i)?.[1];
  const extension = reference.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"].includes(extension ?? "")) {
    return { block: { id: blockId("media", line.start), type: "media", mediaType: "audio", start: line.start, end: line.end, reference, label }, next: index + 1 };
  }
  if (["mp4", "webm", "mov", "m4v", "mkv", "ogv"].includes(extension ?? "")) {
    return { block: { id: blockId("media", line.start), type: "media", mediaType: "video", start: line.start, end: line.end, reference, label }, next: index + 1 };
  }
  if (["html", "htm"].includes(extension ?? "")) {
    return { block: { id: blockId("interactive", line.start), type: "interactive", start: line.start, end: line.end, reference, label, ...(artifactId ? { artifactId } : {}) }, next: index + 1 };
  }
  if (artifactId || isLocalFileReference(reference)) {
    return { block: { id: blockId("file", line.start), type: "file", start: line.start, end: line.end, reference, label, ...(artifactId ? { artifactId } : {}) }, next: index + 1 };
  }
  return undefined;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const raw = source.slice(start, newline < 0 ? source.length : newline);
    lines.push({ start, end, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
    start = end;
  }
  return lines;
}

function looksLikeTable(lines: SourceLine[], index: number): boolean {
  const heading = lines[index]?.text ?? ""; const divider = lines[index + 1]?.text ?? "";
  return heading.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function isLocalFileReference(value: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])/.test(value)) return true;
  if (/^https?:\/\//i.test(value)) return false;
  return /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9]{1,12}(?:(?::\d+)|(?:#L\d+))?$/.test(value);
}

function validBlockShape(block: Record<string, unknown>): boolean {
  switch (block.type) {
    case "markdown": case "diff": case "table": return true;
    case "code": return block.language === undefined || typeof block.language === "string";
    case "diagram": return block.format === "mermaid";
    case "math": return block.display === true;
    case "image": return typeof block.reference === "string" && typeof block.alt === "string" && (block.title === undefined || typeof block.title === "string");
    case "media": return (block.mediaType === "audio" || block.mediaType === "video") && typeof block.reference === "string" && typeof block.label === "string";
    case "file": case "interactive": return typeof block.reference === "string" && typeof block.label === "string" && (block.artifactId === undefined || typeof block.artifactId === "string");
    default: return false;
  }
}

function blockId(type: ChatContentBlock["type"], start: number): string { return `${type}:${start}`; }
