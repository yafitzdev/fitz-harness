import { applyPostGeneration } from "./post-generation.js";
import { highlightSource } from "./syntax-highlighting.js";
import { createCopyButton } from "./ui/primitives/copy-button.js";

const markdownSources = new WeakMap<HTMLElement, string>();

export function setMarkdown(target: HTMLElement, source: string): void {
  // Post-generation rules edit the raw output before it reaches the user.
  // The stored transcript and the context sent back to the model stay raw.
  const display = applyPostGeneration(source.replace(/\r\n?/g, "\n"));
  markdownSources.set(target, display);
  target.classList.add("markdown");
  target.replaceChildren();
  renderBlocks(target, display.split("\n"));
}

export function appendMarkdown(target: HTMLElement, delta: string): void {
  setMarkdown(target, `${markdownSources.get(target) ?? ""}${delta}`);
}

function renderBlocks(target: HTMLElement, lines: string[]): void {
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }

    // Raw HTML in Markdown is intentionally not executed in the desktop renderer.
    // Skip the block instead of exposing its tags as document text; users can still
    // inspect the exact source with the Inspector's source toggle.
    if (/^\s*</.test(line)) {
      while (index < lines.length && (lines[index] ?? "").trim()) index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = []; index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) code.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      target.append(codeBlock(code.join("\n"), fence[1]?.trim() ?? ""));
      continue;
    }

    // Headings are flattened to plain text — we prefer readable prose over big headers.
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const paragraph = document.createElement("p");
      appendInline(paragraph, heading[2]!.trim()); target.append(paragraph); index += 1; continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { target.append(document.createElement("hr")); index += 1; continue; }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote"); const values: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) values.push((lines[index++] ?? "").replace(/^\s*>\s?/, ""));
      appendInline(quote, values.join(" ")); target.append(quote); continue;
    }

    const list = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (list) {
      const ordered = Boolean(list[2]); const value = document.createElement(ordered ? "ol" : "ul");
      if (ordered && list[2] !== "1") value.setAttribute("start", list[2]!);
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        const row = document.createElement("li"); const task = item[3]!.match(/^\[([ xX])\]\s+(.+)$/);
        if (task) { row.className = "task-list-item"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.disabled = true; checkbox.checked = task[1]!.toLowerCase() === "x"; row.append(checkbox); appendInline(row, task[2]!); }
        else appendInline(row, item[3]!);
        value.append(row); index += 1;
        let nextItemIndex = index;
        while (nextItemIndex < lines.length && !(lines[nextItemIndex] ?? "").trim()) nextItemIndex += 1;
        const nextItem = (lines[nextItemIndex] ?? "").match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (nextItem && Boolean(nextItem[2]) === ordered) index = nextItemIndex;
      }
      target.append(value); continue;
    }

    if (looksLikeTable(lines, index)) {
      const headers = tableCells(lines[index] ?? ""); index += 2; const table = document.createElement("table");
      const head = document.createElement("thead"); const headingRow = document.createElement("tr");
      for (const cell of headers) { const value = document.createElement("th"); appendInline(value, cell); headingRow.append(value); }
      head.append(headingRow); table.append(head); const body = document.createElement("tbody");
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        const row = document.createElement("tr"); for (const cell of tableCells(lines[index++] ?? "")) { const value = document.createElement("td"); appendInline(value, cell); row.append(value); } body.append(row);
      }
      table.append(body); const scroller = document.createElement("div"); scroller.className = "markdown-table"; scroller.append(table); target.append(scroller); continue;
    }

    const paragraphLines: string[] = [line]; index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines, index)) paragraphLines.push(lines[index++] ?? "");
    const paragraph = document.createElement("p");
    paragraphLines.forEach((value, lineIndex) => { appendInline(paragraph, value.trimEnd()); if (lineIndex < paragraphLines.length - 1) paragraph.append(value.endsWith("  ") ? document.createElement("br") : document.createTextNode(" ")); });
    target.append(paragraph);
  }
}

function codeBlock(source: string, language: string): HTMLElement {
  const container = document.createElement("section"); container.className = "markdown-code";
  const header = document.createElement("header"); const label = document.createElement("span"); label.textContent = language || "Code";
  const copy = createCopyButton({ copyText: (text) => window.fitz.copyText(text), value: () => source, title: "Copy code", className: "markdown-copy", text: true });
  const pre = document.createElement("pre"); const code = document.createElement("code"); const highlighted = highlightSource(source, language); code.className = `hljs${highlighted.language ? ` language-${highlighted.language}` : ""}`; code.innerHTML = highlighted.html; pre.append(code); header.append(label, copy); container.append(header, pre); return container;
}

function appendInline(target: HTMLElement, source: string): void {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0; if (start > cursor) appendPlainText(target, source.slice(cursor, start));
    const token = match[0];
    if (token.startsWith("`")) { const value = token.slice(1, -1); const code = document.createElement("code"); code.textContent = value; const reference = resourceTarget(value); if (reference) { const link = resourceLink("", reference); link.classList.add("inline-code-resource"); link.append(code); target.append(link); } else target.append(code); }
    else if (token.startsWith("**") || token.startsWith("__")) { appendPlainText(target, token.slice(2, -2)); }
    else if (token.startsWith("~~")) { const strike = document.createElement("del"); appendInline(strike, token.slice(2, -2)); target.append(strike); }
    else if (token.startsWith("[")) appendLink(target, token);
    else { const emphasis = document.createElement("em"); appendInline(emphasis, token.slice(1, -1)); target.append(emphasis); }
    cursor = start + token.length;
  }
  if (cursor < source.length) appendPlainText(target, source.slice(cursor));
}

function appendLink(target: HTMLElement, token: string): void {
  const match = token.match(/^\[([^\]]+)]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/); if (!match) { target.append(document.createTextNode(token)); return; }
  const reference = resourceTarget(match[2]!); if (!reference) { target.append(document.createTextNode(match[1]!)); return; }
  const link = resourceLink(match[1]!, reference); if (match[3]) link.title = match[3]; target.append(link);
}

function appendPlainText(target: HTMLElement, source: string): void {
  const pattern = /(https?:\/\/[^\s<]+|[A-Za-z]:[\\/](?:[^<>:"|?*\r\n]+[\\/])*[^<>:"|?*\r\n]+\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?|(?:\.{0,2}[\\/])?(?:[\w@().-]+[\\/])+[\w@().-]+\.[A-Za-z0-9]{1,12}(?:(?::\d+(?::\d+)?)|(?:#L\d+(?:C\d+)?))?)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) target.append(document.createTextNode(source.slice(cursor, start)));
    let reference = match[0];
    const punctuation = reference.match(/[),.;!?]+$/)?.[0] ?? "";
    if (punctuation && reference.startsWith("http")) reference = reference.slice(0, -punctuation.length);
    target.append(resourceLink(reference, reference));
    if (punctuation) target.append(document.createTextNode(punctuation));
    cursor = start + match[0].length;
  }
  if (cursor < source.length) target.append(document.createTextNode(source.slice(cursor)));
}

function resourceTarget(value: string): string | undefined {
  if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) return value;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}(?:(?::\d+)|(?:#L\d+))?$/i.test(value) ? value : undefined;
}

/**
 * Cleans a path reference extracted from the rendered conversation. Streaming
 * fragments can arrive wrapped in stray delimiters (e.g. `(src/app.t` while
 * the agent is mid-sentence): matching outer brackets/quotes are stripped,
 * and a lone leading opener is dropped when the remainder still looks like a
 * path. Returns the input unchanged when nothing needs cleaning.
 */
export function normalizeResourceReference(reference: string): string {
  let candidate = reference.trim();
  const openers: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
  for (;;) {
    const opener = candidate[0];
    const closer = opener ? openers[opener] : undefined;
    if (!closer) break;
    if (candidate.length > 2 && candidate.endsWith(closer)) {
      candidate = candidate.slice(1, -1).trim();
      continue;
    }
    // A lone opener with no closer is a mid-stream fragment; drop it when the
    // remainder still looks like a path (has a directory separator).
    if (/[\\/]/.test(candidate.slice(1))) {
      candidate = candidate.slice(1).trim();
      continue;
    }
    break;
  }
  return candidate;
}

function resourceLink(label: string, reference: string): HTMLAnchorElement {
  const cleaned = normalizeResourceReference(reference);
  const link = document.createElement("a"); link.href = "#"; link.className = "resource-link"; link.textContent = label; link.dataset.resource = cleaned;
  link.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new CustomEvent("fitz:open-resource", { detail: { reference: cleaned } })); });
  // Files register in the artifact repository as soon as they render, so the
  // repo grows with every artifact the agent produces — no click required.
  // Remote URLs are left out; only local artifacts belong in the repository.
  if (!/^(?:https?|file):\/\//i.test(cleaned)) {
    window.dispatchEvent(new CustomEvent("fitz:resource-appeared", { detail: { reference: cleaned } }));
  }
  return link;
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*</.test(line) || /^\s*```/.test(line) || /^(#{1,6})\s+/.test(line) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line) || /^\s*>\s?/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) || looksLikeTable(lines, index);
}

function looksLikeTable(lines: string[], index: number): boolean {
  const heading = lines[index] ?? ""; const divider = lines[index + 1] ?? "";
  return heading.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function tableCells(line: string): string[] { return line.trim().replace(/^\||\|$/g, "").split("|").map((value) => value.trim()); }
