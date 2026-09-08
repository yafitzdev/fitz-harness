/**
 * One provider-native model reasoning segment. It is rendered directly in the
 * work feed as plain text, with Markdown syntax removed for display. The
 * surrounding Worked-for section provides the collapse boundary for the feed.
 */
export class ReasoningView {
  readonly #element: HTMLElement;
  readonly #content: HTMLDivElement;
  #source = "";

  constructor(running: boolean) {
    const element = document.createElement("div");
    element.className = `message agent-activity reasoning-activity${running ? " running" : ""}`;
    const content = document.createElement("div");
    content.className = "reasoning-content";
    element.append(content);
    this.#element = element;
    this.#content = content;
  }

  get element(): HTMLElement { return this.#element; }

  /** Streams the next chunk of provider-native reasoning into the visible feed. */
  appendDelta(text: string): void {
    // Keep the source so markers split across deltas are parsed together.
    // The durable reasoning and the ordinary chat renderer remain independent.
    this.#source += text;
    this.#content.textContent = plainReasoningText(this.#source);
  }

  /** Marks the segment finished without replacing or summarizing its text. */
  complete(): void {
    this.#element.classList.remove("running");
  }
}

/** Flatten presentation syntax without creating Markdown elements or links. */
function plainReasoningText(source: string): string {
  let fence: { marker: string; length: number } | undefined;
  const lines: string[] = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const boundary = raw.match(/^\s*(`{3,}|~{3,}|´{3,})(.*)$/);
    if (fence) {
      if (boundary && boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim()) fence = undefined;
      else lines.push(raw);
      continue;
    }
    if (boundary) { fence = { marker: boundary[1]![0]!, length: boundary[1]!.length }; continue; }
    if (/^\s*(?:(?:\*\s*){3,}|(?:_\s*){3,}|(?:-\s*){3,}|\|?[\s|:-]*---[\s|:-]*\|?)$/.test(raw)) continue;
    let line = raw.replace(/^\s*(?:>\s+)+/, "");
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) line = line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+#+\s*$/, "");
    line = line.replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "");
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().slice(1, -1).split("|").map((cell) => cell.trim()).join("  ");
    lines.push(plainReasoningInline(line));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function plainReasoningInline(line: string): string {
  // Code and escaped punctuation are literal content, including underscores
  // in identifiers and operators. Protect them while removing prose markers.
  const literals: string[] = [];
  const protect = (value: string) => `\u0000${literals.push(value) - 1}\u0000`;
  return line
    .replace(/(`+|´+)(.*?)(?:\1|$)|\\([\\`*_{}\[\]()#+\-.!>~])/g, (_match, _ticks, code, escaped) => protect(code ?? escaped))
    .replace(/!?\[([^\]\n]+)\]\([^)]*(?:\)|$)/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])!?\[([^\]\n]*)(?:\](?:\([^)]*)?)?$/u, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_*~])(?:\*{1,3}|_{2,3}|~{2})(?=[^\s*_~])|(?<=[^\s*_~])(?:\*{1,3}|_{2,3}|~{2})(?![\p{L}\p{N}_*~])/gu, "")
    .replace(/(?<![\p{L}\p{N}_])[*_~]{1,3}$/u, "")
    .replace(/\u0000(\d+)\u0000/g, (_match, index) => literals[Number(index)]!);
}
