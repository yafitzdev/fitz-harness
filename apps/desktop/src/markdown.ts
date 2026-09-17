import { applyPostGeneration } from "./post-generation.js";
import { highlightSource } from "./syntax-highlighting.js";
import { createCopyButton } from "./ui/primitives/copy-button.js";
import { chatContentBlockSource, isChatContentDocument, parseChatContent, type ChatContentBlock, type ChatContentDocument } from "@fitz/protocol";

interface ChatContentRuntime {
  openReference(reference: string): void;
  openArtifact?(artifactId: string): void;
  resolveMedia?(reference: string, kind: "image" | "audio" | "video"): Promise<string | undefined>;
}

interface RenderedBlock { element: HTMLElement; signature: string }
interface ChatContentState { source: string; display: string; rendered: Map<string, RenderedBlock> }

const markdownStates = new WeakMap<HTMLElement, ChatContentState>();
let contentRuntime: ChatContentRuntime = {
  openReference: (reference) => window.dispatchEvent(new CustomEvent("fitz:open-resource", { detail: { reference } })),
};
let diagramSequence = 0;

export function configureChatContentRuntime(runtime: ChatContentRuntime): void { contentRuntime = runtime; }

export function setMarkdown(target: HTMLElement, source: string, persistedDocument?: unknown): void {
  // Post-generation rules edit the raw output before it reaches the user.
  // The stored transcript and the context sent back to the model stay raw.
  // Structural Markdown remains available to the renderer, which consumes
  // delimiters without exposing them as transcript text.
  const display = applyPostGeneration(source.replace(/\r\n?/g, "\n"), {
    preserveInlineCode: true,
    preserveMarkdownStructure: true,
  });
  target.hidden = display.length === 0;
  target.classList.add("markdown");
  const prior = markdownStates.get(target);
  const state: ChatContentState = prior ?? { source, display, rendered: new Map() };
  state.source = source;
  state.display = display;
  markdownStates.set(target, state);
  const document = display === source && isChatContentDocument(persistedDocument, display.length)
    ? persistedDocument : parseChatContent(display);
  reconcileContentBlocks(target, state, document);
}

export function appendMarkdown(target: HTMLElement, delta: string): void {
  setMarkdown(target, `${markdownStates.get(target)?.source ?? ""}${delta}`);
}

function reconcileContentBlocks(target: HTMLElement, state: ChatContentState, document: ChatContentDocument): void {
  const active = new Set<string>();
  let position = 0;
  for (const block of document.blocks) {
    active.add(block.id);
    const source = chatContentBlockSource(state.display, block);
    // A completed special block gains its separating newline when the next
    // block starts streaming. That delimiter must not invalidate the node.
    const renderSource = block.type === "markdown" ? source : source.trimEnd();
    const signature = `${block.type}\0${renderSource}\0${blockSignatureMetadata(block)}`;
    let rendered = state.rendered.get(block.id);
    if (!rendered || rendered.signature !== signature) {
      const element = renderContentBlock(block, renderSource, signature);
      if (rendered?.element.parentNode === target) {
        delete rendered.element.dataset.renderSignature;
        target.replaceChild(element, rendered.element);
      }
      rendered = { element, signature };
      state.rendered.set(block.id, rendered);
    }
    const current = target.childNodes[position] ?? null;
    if (rendered.element !== current) target.insertBefore(rendered.element, current);
    position += 1;
  }
  for (const [id, rendered] of state.rendered) {
    if (active.has(id)) continue;
    delete rendered.element.dataset.renderSignature;
    rendered.element.remove();
    state.rendered.delete(id);
  }
}

function blockSignatureMetadata(block: ChatContentBlock): string {
  const metadata = { ...block } as Record<string, unknown>;
  delete metadata.id; delete metadata.start; delete metadata.end;
  return JSON.stringify(metadata);
}

function renderContentBlock(block: ChatContentBlock, source: string, signature: string): HTMLElement {
  if (block.type === "image") return mediaFigure("image", block.reference, block.alt, block.title);
  if (block.type === "media") return mediaFigure(block.mediaType, block.reference, block.label);
  if (block.type === "file" || block.type === "interactive") return artifactCard(block);
  if (block.type === "diagram") return fencedBlockClosed(source) ? diagramBlock(fencedBody(source), signature) : pendingRichBlock("Waiting for diagram…");
  if (block.type === "math") return mathBlockClosed(source) ? mathBlock(mathBody(source), signature) : pendingRichBlock("Waiting for equation…");
  const container = document.createElement("div");
  container.className = `chat-content-block chat-content-${block.type}`;
  renderBlocks(container, source.split("\n"));
  return container;
}

function fencedBlockClosed(source: string): boolean {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 1 && /^\s*```\s*$/.test(lines.at(-1) ?? "");
}

function mathBlockClosed(source: string): boolean {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 1 && lines.at(-1)?.trim() === "$$";
}

function pendingRichBlock(label: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "chat-content-block chat-rich-pending";
  container.append(contentPlaceholder(label));
  return container;
}

function artifactCard(block: Extract<ChatContentBlock, { type: "file" | "interactive" }>): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chat-artifact-card ${block.type}`;
  const icon = document.createElement("span"); icon.className = "chat-artifact-icon"; icon.textContent = block.type === "interactive" ? "VIEW" : fileBadge(block.reference);
  const copy = document.createElement("span"); copy.className = "chat-artifact-copy";
  const title = document.createElement("strong"); title.textContent = block.label;
  const detail = document.createElement("small"); detail.textContent = block.type === "interactive" ? "Interactive preview" : displayReference(block.reference);
  copy.append(title, detail); button.append(icon, copy);
  button.addEventListener("click", () => openContentReference(block.reference, block.artifactId));
  return button;
}

function mediaFigure(kind: "image" | "audio" | "video", reference: string, label: string, title?: string): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = `chat-content-block chat-media chat-${kind}`;
  figure.dataset.reference = reference;
  const resolved = directMediaUrl(reference, kind);
  const mount = (url: string) => {
    if (figure.dataset.reference !== reference) return;
    const node = document.createElement(kind === "image" ? "img" : kind) as HTMLImageElement | HTMLMediaElement;
    node.src = url;
    node.addEventListener("error", () => figure.replaceChildren(unavailableReference(reference, label || kind)));
    if (kind === "image") {
      (node as HTMLImageElement).alt = label;
      (node as HTMLImageElement).loading = "lazy";
      node.addEventListener("click", () => openContentReference(reference));
    }
    else (node as HTMLMediaElement).controls = true;
    if (title) node.title = title;
    figure.replaceChildren(node);
    if (label && kind !== "audio") { const caption = document.createElement("figcaption"); caption.textContent = label; figure.append(caption); }
  };
  if (resolved) mount(resolved);
  else {
    figure.append(contentPlaceholder(kind === "image" ? `Loading ${label || "image"}…` : `Loading ${kind}…`));
    const resolution = contentRuntime.resolveMedia?.(reference, kind);
    if (!resolution) {
      figure.replaceChildren(unavailableReference(reference, label || kind));
      return figure;
    }
    void resolution.then((url) => {
      if (url) mount(url); else figure.replaceChildren(unavailableReference(reference, label || kind));
    }).catch(() => figure.replaceChildren(unavailableReference(reference, label || kind)));
  }
  return figure;
}

function diagramBlock(source: string, signature: string): HTMLElement {
  const container = document.createElement("figure");
  container.className = "chat-content-block chat-diagram";
  container.dataset.renderSignature = signature;
  container.append(contentPlaceholder("Rendering diagram…"));
  void import("mermaid").then(async ({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", suppressErrorRendering: true });
    const rendered = await mermaid.render(`fitz-mermaid-${++diagramSequence}`, source);
    if (container.dataset.renderSignature !== signature) return;
    const body = document.createElement("div"); body.className = "chat-diagram-canvas"; body.innerHTML = sanitizeGeneratedSvg(rendered.svg);
    const caption = document.createElement("figcaption"); caption.textContent = "Diagram";
    container.replaceChildren(body, caption, sourceDisclosure("Mermaid source", source, "mermaid"));
  }).catch((error) => {
    if (container.dataset.renderSignature !== signature) return;
    container.replaceChildren(renderFailure("Diagram could not be rendered", source, error));
  });
  return container;
}

function fencedBody(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (/^\s*```/.test(lines[0] ?? "")) lines.shift();
  while (lines.at(-1) === "") lines.pop();
  if (/^\s*```\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.join("\n");
}

function mathBody(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() === "$$") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  if (lines.at(-1)?.trim() === "$$") lines.pop();
  return lines.join("\n");
}

function fileBadge(reference: string): string {
  const extension = reference.split(/[?#]/, 1)[0]?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  return extension?.toUpperCase() ?? "FILE";
}

function displayReference(reference: string): string {
  if (/^artifact:\/\//i.test(reference)) return "Stored artifact";
  const cleaned = normalizeResourceReference(reference).replaceAll("\\", "/");
  try { return decodeURIComponent(cleaned.split("/").at(-1) || cleaned); }
  catch { return cleaned.split("/").at(-1) || cleaned; }
}

function openContentReference(reference: string, artifactId?: string): void {
  if (artifactId && contentRuntime.openArtifact) contentRuntime.openArtifact(artifactId);
  else contentRuntime.openReference(normalizeResourceReference(reference));
}

function directMediaUrl(reference: string, kind: "image" | "audio" | "video"): string | undefined {
  const value = reference.trim();
  if (/^https?:\/\//i.test(value) || /^blob:/i.test(value)) return value;
  return new RegExp(`^data:${kind === "image" ? "image" : kind}/`, "i").test(value) ? value : undefined;
}

function contentPlaceholder(label: string): HTMLElement {
  const value = document.createElement("span");
  value.className = "chat-content-placeholder";
  value.textContent = label;
  return value;
}

function unavailableReference(reference: string, label: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-content-unavailable";
  button.textContent = `${label} — open source`;
  button.addEventListener("click", () => openContentReference(reference));
  return button;
}

function sourceDisclosure(label: string, source: string, language: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "chat-content-source";
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary, codeBlock(source, language));
  return details;
}

function renderFailure(label: string, source: string, _error: unknown): HTMLElement {
  const fallback = document.createElement("section");
  fallback.className = "chat-content-failure";
  const heading = document.createElement("strong");
  heading.textContent = label;
  fallback.append(heading, sourceDisclosure("Show source", source, ""));
  return fallback;
}

function sanitizeGeneratedSvg(svg: string): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  template.content.querySelectorAll("script").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ((attribute.name === "href" || attribute.name === "xlink:href") && /^\s*javascript:/i.test(attribute.value))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}

function mathBlock(source: string, signature: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "chat-content-block chat-math";
  container.dataset.renderSignature = signature;
  container.append(contentPlaceholder("Rendering equation…"));
  void import("katex").then(({ default: katex }) => {
    if (container.dataset.renderSignature !== signature) return;
    container.innerHTML = katex.renderToString(source, { displayMode: true, throwOnError: false, strict: "ignore", trust: false, output: "mathml" });
  }).catch((error) => container.replaceChildren(renderFailure("Equation could not be rendered", source, error)));
  return container;
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

    // Finished answers keep their hierarchy. The restrained chat type scale in
    // styles.css prevents headings from turning the transcript into a document
    // editor, while reasoning continues through its separate plain-text view.
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const title = document.createElement(`h${level}`);
      appendInline(title, heading[2]!.trim()); target.append(title); index += 1; continue;
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
    if (token.startsWith("`")) {
      const value = token.slice(1, -1);
      const code = document.createElement("code");
      code.textContent = value;
      const reference = resourceTarget(value);
      if (reference && isPlainResourceReference(source, start, reference)) {
        const link = resourceLink("", reference);
        link.classList.add("inline-code-resource");
        link.append(code);
        target.append(link);
      } else target.append(code);
    }
    else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      appendInline(strong, token.slice(2, -2));
      target.append(strong);
    }
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
    if (isPlainResourceReference(source, start, reference)) {
      target.append(resourceLink(reference, reference));
      if (punctuation) target.append(document.createTextNode(punctuation));
    } else {
      // Keep the original match intact when it is ordinary prose. In
      // particular, do not append trailing punctuation a second time.
      target.append(document.createTextNode(match[0]));
    }
    cursor = start + match[0].length;
  }
  if (cursor < source.length) target.append(document.createTextNode(source.slice(cursor)));
}

const PROJECT_REFERENCE_ROOTS = new Set([
  "apps", "brand", "data", "docs", "fixtures", "packages", "release", "sample-files", "scripts", "src", "test", "tests",
]);
const FILE_CONTEXT = /(?:file(?:\s+path)?|wrote|written|created|edited|updated|saved|generated|attached|opened|open|read|see|from|at|in)\s*[*_`]*\s*:?\s*[*_`]*\s*$/i;

/**
 * Plain prose is deliberately conservative. A phrase such as
 * `NInfer/llama.cpp` describes an engine family, not necessarily a file. A
 * file becomes a link when the surrounding sentence labels it as one, uses
 * an explicit relative/absolute marker, or starts in a known project root.
 */
function isPlainResourceReference(source: string, start: number, reference: string): boolean {
  if (/^https?:\/\//i.test(reference)) return true;
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])/.test(reference)) return true;
  if (FILE_CONTEXT.test(source.slice(Math.max(0, start - 96), start))) return true;
  const firstSegment = reference.split(/[\\/]/, 1)[0]?.replace(/^[([{]+/, "").toLowerCase();
  return Boolean(firstSegment && PROJECT_REFERENCE_ROOTS.has(firstSegment));
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
  // A link is only an Inspector affordance. Repository membership is owned by
  // explicit generated-file and user-upload flows, never by rendering or
  // opening arbitrary chat references.
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
