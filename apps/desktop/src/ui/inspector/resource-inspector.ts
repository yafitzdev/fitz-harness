import { setMarkdown } from "../../markdown.js";
import type { ResourcePreview } from "../../preload.js";
import { highlightSource } from "../../syntax-highlighting.js";
import { svgIcon, textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;
type InspectedResource = { kind: "file"; path: string } | { kind: "url"; url: string };

export interface ResourceInspectorOptions {
  preview: HTMLElement;
  title: HTMLElement;
  location: HTMLElement;
  icon: HTMLElement;
  openButton: HTMLButtonElement;
  renderToggle: HTMLButtonElement;
  openPanel: () => void;
  getProjectRoot: () => string;
  getSearchRoots: () => string[];
  showToast: (message: string) => void;
}

/** Owns local/remote resource resolution and every Inspector rendering mode. */
export class ResourceInspector {
  readonly #options: ResourceInspectorOptions;
  #resource: InspectedResource | undefined;
  #preview: ResourcePreview | undefined;
  #sourceMode = false;
  #version = 0;
  #activeObjectUrl: string | undefined;

  constructor(options: ResourceInspectorOptions) {
    this.#options = options;
    options.openButton.addEventListener("click", () => void this.openExternally());
    options.renderToggle.addEventListener("click", () => this.toggleSource());
  }

  empty(message: string): HTMLElement { return textBlock("inspector-empty", message); }
  cancelPending(): void { this.#version += 1; this.#revokeObjectUrl(); }

  /** Previews a locally pasted image (data URL) in the Inspector. */
  previewImage(dataUrl: string, mimeType: string, name: string): void {
    this.#revokeObjectUrl();
    this.#resource = undefined;
    this.#preview = undefined;
    this.#options.renderToggle.hidden = true;
    this.#options.openButton.hidden = true;
    this.#setHeading(name, `${mimeType} · ${this.#formatBytes(this.#dataUrlSize(dataUrl))} · Pasted image`, "file");
    this.#options.openPanel();
    this.#options.preview.replaceChildren();
    const img = document.createElement("img");
    img.className = "inspector-media";
    img.alt = name;
    img.src = dataUrl;
    this.#options.preview.append(img);
  }

  /** Previews a locally pasted PDF (data URL) in the Inspector. */
  previewPdf(dataUrl: string, mimeType: string, name: string): void {
    this.#resource = undefined;
    this.#preview = undefined;
    this.#options.renderToggle.hidden = true;
    this.#options.openButton.hidden = true;
    this.#setHeading(name, `${mimeType} · ${this.#formatBytes(this.#dataUrlSize(dataUrl))} · Pasted PDF`, "file");
    this.#options.openPanel();
    this.#options.preview.replaceChildren();
    const frame = document.createElement("iframe");
    frame.className = "inspector-frame";
    frame.title = name;
    // The PDF viewer will not initialize in a sandboxed frame without
    // allow-same-origin; the framed content is an inert blob of the user's own
    // file, so same-origin here carries no script execution risk. Chromium's
    // viewer also renders data: URL PDFs unreliably, so the content is served
    // as a same-process blob URL instead.
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.src = this.#objectUrl(this.#base64FromDataUrl(dataUrl), mimeType);
    this.#options.preview.append(frame);
  }

  async previewArtifact(artifact: Json, selected: HTMLButtonElement, artifactList: HTMLElement): Promise<void> {
    this.#revokeObjectUrl();
    for (const item of artifactList.querySelectorAll(".artifact-item")) item.classList.remove("active");
    selected.classList.add("active");
    this.#setHeading(String(artifact.name ?? "Artifact"), `${this.#formatBytes(Number(artifact.byteSize ?? 0))} · Attachment`, "file");
    this.#resource = undefined;
    this.#preview = undefined;
    this.#options.openButton.hidden = true;
    this.#options.renderToggle.hidden = true;
    this.#options.openPanel();
    this.#options.preview.replaceChildren(this.empty("Loading preview…"));
    try {
      const response = await window.fitz.request({ path: `/api/v1/artifacts/${artifact.id}/content`, responseType: "base64" });
      if (response.status >= 400) throw new Error("Artifact could not be loaded");
      this.#options.preview.replaceChildren();
      if (artifact.kind === "text" || artifact.kind === "code") {
        const source = new TextDecoder().decode(this.#base64Bytes(response.body));
        if (/\.(?:md|markdown)$/i.test(String(artifact.name ?? ""))) {
          const markdown = document.createElement("article");
          markdown.className = "inspector-markdown message-body";
          setMarkdown(markdown, source);
          this.#options.preview.append(markdown);
        } else if (/\.html?$/i.test(String(artifact.name ?? ""))) this.#options.preview.append(this.#htmlFrame(source, String(artifact.name ?? "HTML preview")));
        else this.#options.preview.append(this.#source(source, String(artifact.name ?? "source")));
        return;
      }
      if (["image", "audio", "video"].includes(artifact.kind)) {
        const node = document.createElement(artifact.kind === "image" ? "img" : artifact.kind) as HTMLImageElement | HTMLMediaElement;
        node.className = "inspector-media";
        node.setAttribute("src", `data:${artifact.mimeType};base64,${response.body}`);
        if (node instanceof HTMLMediaElement) node.controls = true;
        this.#options.preview.append(node);
        return;
      }
      if (artifact.kind === "pdf") {
        const frame = document.createElement("iframe");
        frame.className = "inspector-frame";
        // See previewPdf: the viewer needs allow-same-origin in a sandboxed
        // frame, and a blob URL renders more reliably than a data: URL.
        frame.setAttribute("sandbox", "allow-same-origin");
        frame.title = artifact.name;
        frame.src = this.#objectUrl(response.body, artifact.mimeType);
        this.#options.preview.append(frame);
        return;
      }
      this.#options.preview.append(this.empty("Preview unavailable for this file type"));
    } catch (error) {
      this.#options.preview.replaceChildren(this.#error(this.#errorMessage(error)));
    }
  }

  async inspect(reference: string): Promise<void> {
    const version = ++this.#version;
    this.#revokeObjectUrl();
    this.#preview = undefined;
    this.#options.renderToggle.hidden = true;
    this.#options.openPanel();
    this.#options.preview.replaceChildren(this.empty("Loading preview…"));
    if (/^https?:\/\//i.test(reference)) {
      try {
        const url = new URL(reference);
        this.#resource = { kind: "url", url: url.toString() };
        this.#setHeading(url.hostname, url.toString(), "url");
        this.#options.openButton.hidden = false;
        const frame = document.createElement("iframe");
        frame.className = "inspector-frame";
        frame.title = url.toString();
        frame.src = url.toString();
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups-to-escape-sandbox");
        frame.referrerPolicy = "no-referrer";
        this.#options.preview.replaceChildren(frame);
      } catch {
        this.#options.preview.replaceChildren(this.#error("This URL is not valid."));
      }
      return;
    }
    const projectRoot = this.#options.getProjectRoot();
    if (!projectRoot) {
      this.#setHeading("File unavailable", reference, "file");
      this.#options.preview.replaceChildren(this.#error("Select a project before opening a local file."));
      return;
    }
    this.#setHeading(reference.split(/[\\/]/).pop() ?? reference, reference, "file");
    this.#options.openButton.hidden = true;
    try {
      const preview = await window.fitz.previewResource({ projectRoot, reference, searchRoots: this.#options.getSearchRoots() });
      if (version !== this.#version) return;
      this.#resource = { kind: "file", path: preview.path };
      this.#preview = preview;
      this.#sourceMode = false;
      this.#syncRenderToggle();
      this.#options.renderToggle.hidden = preview.kind !== "markdown" && preview.kind !== "html";
      this.#setHeading(preview.name, `${preview.path}${preview.line ? ` · line ${preview.line}` : ""}`, preview.kind);
      this.#options.openButton.hidden = false;
      this.#render(preview);
    } catch (error) {
      if (version !== this.#version) return;
      this.#resource = undefined;
      this.#preview = undefined;
      this.#options.openButton.hidden = true;
      this.#options.renderToggle.hidden = true;
      this.#options.preview.replaceChildren(this.#error(this.#resourceError(error, reference)));
    }
  }

  toggleSource(): void {
    if (!this.#preview) return;
    this.#sourceMode = !this.#sourceMode;
    this.#syncRenderToggle();
    this.#render(this.#preview);
  }

  async openExternally(): Promise<void> {
    if (!this.#resource) return;
    try {
      if (this.#resource.kind === "url") await window.fitz.openExternal(this.#resource.url);
      else await window.fitz.openPath(this.#resource.path);
    } catch (error) {
      this.#options.showToast(this.#errorMessage(error));
    }
  }

  #render(preview: ResourcePreview): void {
    this.#options.preview.replaceChildren();
    if (preview.kind === "markdown" && !this.#sourceMode) {
      const markdown = document.createElement("article");
      markdown.className = "inspector-markdown message-body";
      setMarkdown(markdown, preview.content);
      this.#options.preview.append(markdown);
      return;
    }
    if (preview.kind === "html" && !this.#sourceMode) {
      this.#options.preview.append(this.#htmlFrame(preview.content, preview.name));
      return;
    }
    const pre = this.#source(preview.content, preview.name);
    this.#options.preview.append(pre);
    if (preview.line) requestAnimationFrame(() => {
      const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 19;
      this.#options.preview.scrollTop = Math.max(0, (preview.line! - 3) * lineHeight);
    });
  }

  #source(content: string, name: string): HTMLPreElement {
    const pre = document.createElement("pre");
    pre.className = "inspector-source";
    const code = document.createElement("code");
    const highlighted = highlightSource(content, name);
    code.className = `hljs${highlighted.language ? ` language-${highlighted.language}` : ""}`;
    code.innerHTML = highlighted.html;
    pre.append(code);
    return pre;
  }

  #htmlFrame(source: string, title: string): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    frame.className = "inspector-frame";
    frame.title = title;
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.addEventListener("load", () => this.#applyScrollbar(frame));
    frame.srcdoc = this.#withScrollbar(source);
    return frame;
  }

  #withScrollbar(source: string): string {
    const style = `<style id="fitz-preview-scrollbar">${PREVIEW_SCROLLBAR_CSS}</style>`;
    return /<\/body\s*>/i.test(source) ? source.replace(/<\/body\s*>/i, `${style}</body>`) : `${source}${style}`;
  }

  #applyScrollbar(frame: HTMLIFrameElement): void {
    const frameDocument = frame.contentDocument;
    if (!frameDocument?.documentElement) return;
    frameDocument.getElementById("fitz-preview-scrollbar-runtime")?.remove();
    const style = frameDocument.createElement("style");
    style.id = "fitz-preview-scrollbar-runtime";
    style.textContent = PREVIEW_SCROLLBAR_CSS;
    (frameDocument.head ?? frameDocument.documentElement).append(style);
  }

  #setHeading(title: string, location: string, kind: "file" | "url" | ResourcePreview["kind"]): void {
    this.#options.title.textContent = title;
    this.#options.location.textContent = location;
    this.#options.icon.replaceChildren(kind === "url"
      ? svgIcon('<circle cx="10" cy="10" r="7"></circle><path d="M3 10h14M10 3a11 11 0 0 1 0 14M10 3a11 11 0 0 0 0 14"></path>')
      : svgIcon('<path d="M5 2.8h6l4 4v10.4H5z"></path><path d="M11 2.8v4h4"></path>'));
  }

  #syncRenderToggle(): void {
    this.#options.renderToggle.setAttribute("aria-pressed", String(this.#sourceMode));
    this.#options.renderToggle.title = this.#sourceMode ? "View rendered" : "View source";
    this.#options.renderToggle.setAttribute("aria-label", this.#options.renderToggle.title);
  }

  #resourceError(error: unknown, reference: string): string {
    const detail = this.#errorMessage(error).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "");
    if (/\b(?:ENOENT|File not found:)\b/i.test(detail)) return `Could not find ${reference}. The file may have moved or the agent only mentioned its name.`;
    return detail;
  }

  #error(message: string): HTMLElement { return textBlock("inspector-error", message); }
  #errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  #base64Bytes(value: string): Uint8Array<ArrayBuffer> { const binary = atob(value); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return bytes; }
  #dataUrlSize(dataUrl: string): number { try { return atob(dataUrl.slice(dataUrl.indexOf(",") + 1)).length; } catch { return 0; } }
  #base64FromDataUrl(dataUrl: string): string { return dataUrl.slice(dataUrl.indexOf(",") + 1); }
  /** Creates (and tracks) a same-process blob URL for inert PDF content. */
  #objectUrl(base64: string, mimeType: string): string {
    this.#revokeObjectUrl();
    const blob = new Blob([this.#base64Bytes(base64)], { type: mimeType });
    this.#activeObjectUrl = URL.createObjectURL(blob);
    return this.#activeObjectUrl;
  }
  #revokeObjectUrl(): void {
    if (this.#activeObjectUrl) { URL.revokeObjectURL(this.#activeObjectUrl); this.#activeObjectUrl = undefined; }
  }
  #formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }
}

const PREVIEW_SCROLLBAR_CSS = 'html{color-scheme:dark!important}html,body,*{scrollbar-width:thin!important;scrollbar-color:rgba(255,255,255,.22) transparent!important}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{width:10px!important;height:10px!important}html::-webkit-scrollbar-track,body::-webkit-scrollbar-track,*::-webkit-scrollbar-track,html::-webkit-scrollbar-corner,body::-webkit-scrollbar-corner,*::-webkit-scrollbar-corner{background:transparent!important}html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb,*::-webkit-scrollbar-thumb{min-height:30px!important;border:2px solid transparent!important;border-radius:999px!important;background:rgba(255,255,255,.22)!important;background-clip:content-box!important}html::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:hover,*::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.34)!important}';
