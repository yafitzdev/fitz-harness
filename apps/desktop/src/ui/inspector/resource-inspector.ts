import { setMarkdown } from "../../markdown.js";
import type { ResourcePreview } from "../../preload.js";
import { highlightSource } from "../../syntax-highlighting.js";
import { textBlock } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";

type Json = Record<string, any>;
type InspectedResource = { kind: "file"; path: string } | { kind: "url"; url: string };

export interface ResourceInspectorOptions {
  preview: HTMLElement;
  /**
   * The "open outside" control. Optional: the header that used to host it is
   * gone, so the button is wired only when a host element is provided.
   */
  openButton?: HTMLButtonElement;
  /**
   * The raw↔rendered toggle. Optional for now — its button will be placed
   * again later; the machinery stays so it can be re-wired.
   */
  renderToggle?: HTMLButtonElement;
  openPanel: () => void;
  getProjectRoot: () => string;
  getSearchRoots: () => string[];
  showStatus: ActionFeedback;
  /** Fires when a local file preview resolves so Inspector tabs can merge. */
  onFileResolved?: (path: string, name: string) => void;
}

/** Owns local/remote resource resolution and every Inspector rendering mode. */
export class ResourceInspector {
  readonly #options: ResourceInspectorOptions;
  #resource: InspectedResource | undefined;
  #preview: ResourcePreview | undefined;
  #sourceMode = false;
  #version = 0;
  #activeObjectUrl: string | undefined;
  /** Whether this inspector is the visible tab; only it may touch the shared controls. */
  #active = true;
  #openButtonHidden = true;
  #renderToggleHidden = true;

  constructor(options: ResourceInspectorOptions) {
    this.#options = options;
    options.openButton?.addEventListener("click", () => void this.openExternally());
    options.renderToggle?.addEventListener("click", () => this.toggleSource());
  }

  empty(message: string): HTMLElement { return textBlock("inspector-empty", message); }
  cancelPending(): void { this.#version += 1; this.#revokeObjectUrl(); }

  /**
   * Marks this inspector as the visible tab. Activating one restores the
   * shared controls (open-outside and raw↔rendered toggles) from this
   * inspector's state, since every tab shares the same controls.
   */
  setActive(active: boolean): void {
    this.#active = active;
    if (active) this.#restoreHeader();
  }

  /** Previews a locally pasted image (data URL) in the Inspector. */
  previewImage(dataUrl: string, mimeType: string, name: string): void {
    this.previewMedia("image", dataUrl, mimeType, name);
  }

  /** Previews locally staged image/video/audio media without materializing it
   * through the host first. Picker files arrive as blob URLs. */
  previewMedia(kind: "image" | "video" | "audio", url: string, _mimeType: string, name: string): void {
    this.#revokeObjectUrl();
    this.#resource = undefined;
    this.#preview = undefined;
    this.#setRenderToggle(true);
    this.#setOpenButton(true);
    this.#options.openPanel();
    this.#options.preview.replaceChildren();
    const node = document.createElement(kind === "image" ? "img" : kind) as HTMLImageElement | HTMLMediaElement;
    node.className = "inspector-media";
    if (node instanceof HTMLImageElement) node.alt = name;
    else node.controls = true;
    node.src = url;
    this.#options.preview.append(node);
  }

  /** Previews a locally pasted PDF (data URL) in the Inspector. */
  previewPdf(dataUrl: string, mimeType: string, name: string): void {
    this.#resource = undefined;
    this.#preview = undefined;
    this.#setRenderToggle(true);
    this.#setOpenButton(true);
    this.#options.openPanel();
    this.#options.preview.replaceChildren();
    const frame = document.createElement("iframe");
    frame.className = "inspector-frame";
    frame.title = name;
    // Chromium's PDF viewer is a plugin, and the sandbox attribute disables
    // plugins in the frame unconditionally (the "sandboxed plugins browsing
    // context flag" has no opt-in token), which is why PDFs render blank in
    // sandboxed frames even with allow-same-origin. The framed content is an
    // inert blob of the user's own file (never HTML), so we intentionally
    // leave this frame unsandboxed; the PDF plugin itself still runs in
    // Chromium's separate sandboxed process. Chromium's viewer also renders
    // data: URL PDFs unreliably, so the content is served as a same-process
    // blob URL instead.
    frame.src = dataUrl.startsWith("blob:") ? dataUrl : this.#objectUrl(this.#base64FromDataUrl(dataUrl), mimeType);
    this.#options.preview.append(frame);
  }

  async previewArtifact(artifact: Json): Promise<void> {
    this.#revokeObjectUrl();
    this.#resource = undefined;
    this.#preview = undefined;
    this.#setOpenButton(true);
    this.#setRenderToggle(true);
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
        // See previewPdf: the PDF viewer plugin cannot run in a sandboxed
        // frame, and a blob URL renders more reliably than a data: URL.
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
    this.#setRenderToggle(true);
    this.#options.openPanel();
    this.#options.preview.replaceChildren(this.empty("Loading preview…"));
    if (/^https?:\/\//i.test(reference)) {
      try {
        const url = new URL(reference);
        this.#resource = { kind: "url", url: url.toString() };
        this.#setOpenButton(false);
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
      this.#options.preview.replaceChildren(this.#error("Select a project before opening a local file."));
      return;
    }
    this.#setOpenButton(true);
    try {
      const preview = await window.fitz.previewResource({ projectRoot, reference, searchRoots: this.#options.getSearchRoots() });
      if (version !== this.#version) return;
      this.#resource = { kind: "file", path: preview.path };
      this.#preview = preview;
      this.#sourceMode = false;
      this.#syncRenderToggle();
      this.#setRenderToggle(preview.kind !== "markdown" && preview.kind !== "html");
      this.#setOpenButton(false);
      this.#render(preview);
      this.#options.onFileResolved?.(preview.path, preview.name);
    } catch (error) {
      if (version !== this.#version) return;
      this.#resource = undefined;
      this.#preview = undefined;
      this.#setOpenButton(true);
      this.#setRenderToggle(true);
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
      this.#options.showStatus(this.#errorMessage(error), "error");
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
    if (preview.kind === "image") {
      const img = document.createElement("img");
      img.className = "inspector-media";
      img.alt = preview.name;
      img.src = `data:${preview.mimeType ?? "image/png"};base64,${preview.base64 ?? ""}`;
      this.#options.preview.append(img);
      return;
    }
    if (preview.kind === "pdf") {
      const frame = document.createElement("iframe");
      frame.className = "inspector-frame";
      // See previewPdf: the PDF viewer plugin cannot run in a sandboxed
      // frame, so this frame is intentionally unsandboxed (the content is an
      // inert blob of the user's own PDF, never HTML).
      frame.title = preview.name;
      frame.src = this.#objectUrl(preview.base64 ?? "", preview.mimeType ?? "application/pdf");
      this.#options.preview.append(frame);
      return;
    }
    if (preview.kind === "audio" || preview.kind === "video") {
      const node = document.createElement(preview.kind) as HTMLAudioElement | HTMLVideoElement;
      node.className = "inspector-media";
      node.controls = true;
      node.src = `data:${preview.mimeType ?? (preview.kind === "audio" ? "audio/mpeg" : "video/mp4")};base64,${preview.base64 ?? ""}`;
      this.#options.preview.append(node);
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
    const style = `<style id="fitz-preview-scrollbar">${previewScrollbarCss()}</style>`;
    return /<\/body\s*>/i.test(source) ? source.replace(/<\/body\s*>/i, `${style}</body>`) : `${source}${style}`;
  }

  #applyScrollbar(frame: HTMLIFrameElement): void {
    const frameDocument = frame.contentDocument;
    if (!frameDocument?.documentElement) return;
    frameDocument.getElementById("fitz-preview-scrollbar-runtime")?.remove();
    const style = frameDocument.createElement("style");
    style.id = "fitz-preview-scrollbar-runtime";
    style.textContent = previewScrollbarCss();
    (frameDocument.head ?? frameDocument.documentElement).append(style);
  }

  #restoreHeader(): void {
    if (this.#options.openButton) this.#options.openButton.hidden = this.#openButtonHidden;
    if (this.#options.renderToggle) this.#options.renderToggle.hidden = this.#renderToggleHidden;
    if (this.#preview) this.#syncRenderToggle();
  }

  #setOpenButton(hidden: boolean): void {
    this.#openButtonHidden = hidden;
    if (this.#active && this.#options.openButton) this.#options.openButton.hidden = hidden;
  }

  #setRenderToggle(hidden: boolean): void {
    this.#renderToggleHidden = hidden;
    if (this.#active && this.#options.renderToggle) this.#options.renderToggle.hidden = hidden;
  }

  #syncRenderToggle(): void {
    if (!this.#active || !this.#options.renderToggle) return;
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
}

function previewScrollbarCss(): string {
  const theme = getComputedStyle(document.documentElement);
  const thumb = theme.getPropertyValue("--scrollbar-thumb").trim();
  const thumbHover = theme.getPropertyValue("--scrollbar-thumb-hover").trim();
  return `html{color-scheme:dark!important}html,body,*{scrollbar-width:thin!important;scrollbar-color:${thumb} transparent!important}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{width:10px!important;height:10px!important}html::-webkit-scrollbar-track,body::-webkit-scrollbar-track,*::-webkit-scrollbar-track,html::-webkit-scrollbar-corner,body::-webkit-scrollbar-corner,*::-webkit-scrollbar-corner{background:transparent!important}html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb,*::-webkit-scrollbar-thumb{min-height:30px!important;border:2px solid transparent!important;border-radius:999px!important;background:${thumb}!important;background-clip:content-box!important}html::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:hover,*::-webkit-scrollbar-thumb:hover{background-color:${thumbHover}!important}`;
}
