const markdownSources = new WeakMap<HTMLElement, string>();

export function setMarkdown(target: HTMLElement, source: string): void {
  markdownSources.set(target, source);
  target.classList.add("markdown");
  target.replaceChildren();
  renderBlocks(target, source.replace(/\r\n?/g, "\n").split("\n"));
}

export function appendMarkdown(target: HTMLElement, delta: string): void {
  setMarkdown(target, `${markdownSources.get(target) ?? ""}${delta}`);
}

function renderBlocks(target: HTMLElement, lines: string[]): void {
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = []; index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) code.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      target.append(codeBlock(code.join("\n"), fence[1]?.trim() ?? ""));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const value = document.createElement(`h${heading[1]!.length}`);
      appendInline(value, heading[2]!.trim()); target.append(value); index += 1; continue;
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
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (!item || Boolean(item[2]) !== ordered) break;
        const row = document.createElement("li"); const task = item[3]!.match(/^\[([ xX])\]\s+(.+)$/);
        if (task) { row.className = "task-list-item"; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.disabled = true; checkbox.checked = task[1]!.toLowerCase() === "x"; row.append(checkbox); appendInline(row, task[2]!); }
        else appendInline(row, item[3]!);
        value.append(row); index += 1;
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
  const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy"; copy.addEventListener("click", async () => { await window.fitz.copyText(source); copy.textContent = "Copied"; window.setTimeout(() => { copy.textContent = "Copy"; }, 1_200); });
  const pre = document.createElement("pre"); const code = document.createElement("code"); if (language) code.className = `language-${language.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`; code.textContent = source; pre.append(code); header.append(label, copy); container.append(header, pre); return container;
}

function appendInline(target: HTMLElement, source: string): void {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0; if (start > cursor) target.append(document.createTextNode(source.slice(cursor, start)));
    const token = match[0];
    if (token.startsWith("`")) { const code = document.createElement("code"); code.textContent = token.slice(1, -1); target.append(code); }
    else if (token.startsWith("**") || token.startsWith("__")) { const strong = document.createElement("strong"); appendInline(strong, token.slice(2, -2)); target.append(strong); }
    else if (token.startsWith("~~")) { const strike = document.createElement("del"); appendInline(strike, token.slice(2, -2)); target.append(strike); }
    else if (token.startsWith("[")) appendLink(target, token);
    else { const emphasis = document.createElement("em"); appendInline(emphasis, token.slice(1, -1)); target.append(emphasis); }
    cursor = start + token.length;
  }
  if (cursor < source.length) target.append(document.createTextNode(source.slice(cursor)));
}

function appendLink(target: HTMLElement, token: string): void {
  const match = token.match(/^\[([^\]]+)]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/); if (!match) { target.append(document.createTextNode(token)); return; }
  const href = safeExternalUrl(match[2]!); if (!href) { target.append(document.createTextNode(match[1]!)); return; }
  const link = document.createElement("a"); link.href = href; link.textContent = match[1]!; if (match[3]) link.title = match[3];
  link.addEventListener("click", (event) => { event.preventDefault(); void window.fitz.openExternal(href); }); target.append(link);
}

function safeExternalUrl(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined; }
  catch { return undefined; }
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*```/.test(line) || /^(#{1,6})\s+/.test(line) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line) || /^\s*>\s?/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) || looksLikeTable(lines, index);
}

function looksLikeTable(lines: string[], index: number): boolean {
  const heading = lines[index] ?? ""; const divider = lines[index + 1] ?? "";
  return heading.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider);
}

function tableCells(line: string): string[] { return line.trim().replace(/^\||\|$/g, "").split("|").map((value) => value.trim()); }
