import { projectRelativePath } from "../chat/tool-activity.js";
import { normalizeResourceReference } from "../../markdown.js";
import { svgIcon, textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

/** A file the user inspected that is kept in the persistent repository. */
export interface RepositoryFile {
  path: string;
  name: string;
  addedAt: number;
  /** Relative references are transcript-derived and may be replayed; a
   * resolved entry is backed by an absolute path that the Inspector opened. */
  origin?: "reference" | "resolved";
}

export interface ArtifactRepositoryOptions {
  /** localStorage key that persists inspected files (default "fitz-inspector-repository"). */
  storageKey?: string;
  /** Opens a persisted file in the Inspector (receives the absolute path). */
  onOpenFile: (path: string) => void;
  /** Opens a session upload in the Inspector. */
  onOpenArtifact: (artifact: Json) => void;
  /** Resolves the active project root so repository rows can show relative paths. */
  getProjectRoot?: () => string;
}

/** Keeps at most this many inspected files in the persisted repository. */
const MAX_FILES = 200;

/** A repository-row icon: raw SVG markup plus the key stamped on the element for tests and styling. */
type RepositoryIcon = { key: string; markup: string };

/**
 * One icon per file type, drawn in the app's 20×20 stroke style (see the
 * global `svg` rules in renderer/styles.css). The key doubles as the
 * `data-file-type` attribute on the rendered symbol.
 */
const FILE_TYPE_ICONS = {
  file: { key: "file", markup: '<path d="M5.2 2.8h7l3.8 3.8v10.9a1.5 1.5 0 0 1-1.5 1.5H5.2a1.5 1.5 0 0 1-1.5-1.5V4.3a1.5 1.5 0 0 1 1.5-1.5Z"></path><path d="M12 2.8v4h4"></path>' },
  pdf: { key: "pdf", markup: '<path d="M5.2 2.8h7l3.8 3.8v10.9a1.5 1.5 0 0 1-1.5 1.5H5.2a1.5 1.5 0 0 1-1.5-1.5V4.3a1.5 1.5 0 0 1 1.5-1.5Z"></path><path d="M12 2.8v4h4"></path><path d="M7.4 12.2h5.2M7.4 15h5.2"></path>' },
  image: { key: "image", markup: '<rect x="3.4" y="3.8" width="13.2" height="12.4" rx="2"></rect><circle cx="7.9" cy="8" r="1.4"></circle><path d="m16.2 13.7-3.2-3.2-5.5 5.5"></path>' },
  code: { key: "code", markup: '<path d="m7.4 7.2-3.4 2.8 3.4 2.8M12.6 7.2l3.4 2.8-3.4 2.8"></path>' },
  audio: { key: "audio", markup: '<path d="M8.3 14.8V5.4l7-1.6v9.8"></path><circle cx="6.4" cy="14.8" r="1.9"></circle><circle cx="13.3" cy="13.6" r="1.9"></circle>' },
  video: { key: "video", markup: '<rect x="2.8" y="4" width="14.4" height="12" rx="2"></rect><path d="M7.2 4v12M12.8 4v12M2.8 9.4h14.4M2.8 10.6h14.4"></path>' },
  archive: { key: "archive", markup: '<path d="M3.8 6.8h12.4v8.7a1.7 1.7 0 0 1-1.7 1.7H5.5a1.7 1.7 0 0 1-1.7-1.7Z"></path><path d="M3.2 3.4h13.6v3.4H3.2z"></path><path d="M9.8 10.4h.4"></path>' },
  database: { key: "database", markup: '<ellipse cx="10" cy="5.2" rx="6.4" ry="2.3"></ellipse><path d="M3.6 5.2v9.6c0 1.3 2.9 2.3 6.4 2.3s6.4-1 6.4-2.3V5.2"></path><path d="M3.6 10c0 1.3 2.9 2.3 6.4 2.3s6.4-1 6.4-2.3"></path>' },
  web: { key: "web", markup: '<circle cx="10" cy="10" r="6.8"></circle><path d="M3.2 10h13.6"></path><path d="M10 3.2c1.7 1.9 2.6 4.2 2.6 6.8s-.9 4.9-2.6 6.8M10 3.2C8.3 5.1 7.4 7.4 7.4 10s.9 4.9 2.6 6.8"></path>' },
} as const satisfies Record<string, RepositoryIcon>;

/**
 * The artifact repository — the Inspector's defacto base tab. It grows with
 * every file the agent produces (registered as soon as it appears in the
 * conversation, persisted by path) and with the current session's uploaded
 * artifacts, and renders as one list where every entry reopens in the
 * Inspector.
 */
export class ArtifactRepository {
  readonly #options: ArtifactRepositoryOptions;
  #storageKey: string;
  #files: RepositoryFile[] = [];
  #sessionArtifacts: Json[] = [];
  #container: HTMLElement | undefined;

  constructor(options: ArtifactRepositoryOptions) {
    this.#options = options;
    this.#storageKey = options.storageKey ?? "fitz-inspector-repository";
    this.#load();
  }

  /**
   * Re-scopes the persisted repository to a new storage key — one per chat,
   * so one session's files never leak into another. The in-memory list is
   * dropped and reloaded from the new key; same-key calls are a no-op.
   */
  useStorage(storageKey: string): void {
    if (storageKey === this.#storageKey) return;
    this.#storageKey = storageKey;
    this.#files = [];
    this.#load();
    this.#render();
  }

  /** The persisted inspected files, newest first. */
  files(): RepositoryFile[] { return this.#files; }

  /**
   * Adds (or refreshes) an inspected file and persists the repository. The
   * optional reference is the chat reference that opened it — any entry that
   * was registered from that same reference on appearance is superseded by
   * the resolved absolute path so the file never appears twice.
   */
  registerFile(path: string, name: string, reference?: string): void {
    if (reference && reference !== path) {
      this.#files = this.#files.filter((file) => file.path !== reference && !ArtifactRepository.#supersedes(file.path, reference));
    }
    const existing = this.#files.find((file) => file.path === path);
    if (existing) {
      existing.name = name || existing.name;
      existing.addedAt = Date.now();
      existing.origin = "resolved";
    } else {
      this.#files.unshift({ path, name: name || path, addedAt: Date.now(), origin: "resolved" });
    }
    if (this.#files.length > MAX_FILES) this.#files.length = MAX_FILES;
    this.#save();
    this.#render();
  }

  /**
   * Registers a file the moment it appears in the conversation (no click
   * needed). References are stored as given and reopened through the normal
   * resolve path. Streaming partials like `src/app.t` are superseded by the
   * complete `src/app.ts` when it renders, and references that already sit in
   * the repository (exact path, or resolved to the same relative path) are
   * left untouched.
   */
  registerReference(reference: string): void {
    if (!reference || /^(?:https?|file):\/\//i.test(reference)) return;
    reference = normalizeResourceReference(reference);
    if (!reference) return;
    const root = this.#options.getProjectRoot?.() ?? "";
    const alreadyPresent = this.#files.some((file) => file.path === reference || (root && projectRelativePath(file.path, root) === reference));
    if (alreadyPresent) return;
    this.#files = this.#files.filter((file) => !ArtifactRepository.#supersedes(file.path, reference));
    this.#files.unshift({ path: reference, name: reference.split(/[\\/]/).pop() || reference, addedAt: Date.now(), origin: "reference" });
    if (this.#files.length > MAX_FILES) this.#files.length = MAX_FILES;
    this.#save();
    this.#render();
  }

  /** Replaces the current session's uploaded artifacts. */
  setSessionArtifacts(artifacts: Json[]): void {
    this.#sessionArtifacts = artifacts;
    this.#render();
  }

  /** Renders the repository into the given container (the base tab). */
  render(container: HTMLElement): void {
    this.#container = container;
    this.#render();
  }

  #load(): void {
    try {
      const raw = localStorage.getItem(this.#storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      // The repository is a derived cache. Relative chat references are
      // replayed from the transcript on session load, while absolute paths
      // represent files that were actually resolved by the Inspector. Drop
      // legacy relative-only entries here: older builds persisted ambiguous
      // prose such as `NInfer/llama.cpp` as if it were a file, and those rows
      // cannot be distinguished from valid references without resolving them.
      // Keeping resolved absolute paths preserves inspected files; replay
      // repopulates valid relative references for the active chat. New
      // reference records carry an origin marker so they survive a chat
      // switch; legacy relative records without one are discarded.
      const seen = new Set<string>();
      let changed = false;
      this.#files = parsed
        .filter((entry): entry is RepositoryFile => typeof entry === "object" && entry !== null && typeof (entry as RepositoryFile).path === "string")
        .map((entry) => ({
          path: normalizeResourceReference(entry.path),
          name: typeof entry.name === "string" ? entry.name : entry.path,
          addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
          ...(entry.origin === "reference" || entry.origin === "resolved" ? { origin: entry.origin } : {}),
        }))
        .sort((left, right) => right.addedAt - left.addedAt)
        .filter((entry) => {
          if (!entry.path || seen.has(entry.path)) { changed = true; return false; }
          if (!isAbsolutePath(entry.path) && entry.origin !== "reference") { changed = true; return false; }
          seen.add(entry.path);
          return true;
        });
      if (changed) this.#save();
    } catch {
      this.#files = [];
    }
  }

  #save(): void {
    try {
      localStorage.setItem(this.#storageKey, JSON.stringify(this.#files));
    } catch {
      // Repository persistence is best-effort; the in-memory list still works.
    }
  }

  #render(): void {
    if (!this.#container) return;
    this.#container.replaceChildren();
    if (this.#sessionArtifacts.length === 0 && this.#files.length === 0) {
      this.#container.append(textBlock("inspector-empty", "Files that appear in the conversation land here automatically."));
      return;
    }
    const list = document.createElement("div");
    list.className = "inspector-repository";
    for (const artifact of this.#sessionArtifacts) {
      const name = String(artifact.name ?? "Artifact");
      list.append(this.#item(name, `${this.#formatBytes(Number(artifact.byteSize ?? 0))} · Attachment`, this.#iconFor(name, String(artifact.kind ?? "")), () => this.#options.onOpenArtifact(artifact)));
    }
    for (const file of this.#files) {
      const root = this.#options.getProjectRoot?.() ?? "";
      list.append(this.#item(file.name, this.#displayPath(file.path, root), this.#iconFor(file.name), () => this.#options.onOpenFile(file.path)));
    }
    this.#container.append(list);
  }

  /**
   * The path shown under each repository entry: project-relative when the file
   * lives under the active project root, otherwise the bare file name (the
   * full path stays in the row's tooltip) so absolute paths and streamed
   * fragments don't clutter the list.
   */
  #displayPath(path: string, root: string): string {
    if (root) {
      const relative = projectRelativePath(path, root);
      if (relative !== path) return relative;
    }
    // Already relative (e.g. a chat reference outside the active root): keep.
    if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) return path;
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }

  #item(name: string, meta: string, icon: RepositoryIcon, open: () => void): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "inspector-repository-item";
    const symbol = svgIcon(icon.markup);
    symbol.dataset.fileType = icon.key;
    const label = document.createElement("span");
    label.textContent = name;
    const detail = document.createElement("small");
    detail.textContent = meta;
    detail.title = meta;
    row.append(symbol, label, detail);
    row.addEventListener("click", open);
    return row;
  }

  /**
   * The icon shown before a repository row. Extension wins (a `report.pdf`
   * upload renders the PDF sheet whether or not its kind was classified),
   * with the artifact kind as a fallback for uploads whose names carry no
   * useful extension; anything unrecognized gets the plain document.
   */
  #iconFor(name: string, kind?: string): RepositoryIcon {
    switch (name.toLowerCase().split(".").pop() ?? "") {
      case "pdf": return FILE_TYPE_ICONS.pdf;
      case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg": case "ico": case "bmp": case "avif": case "heic": return FILE_TYPE_ICONS.image;
      case "mp3": case "wav": case "ogg": case "oga": case "flac": case "m4a": case "aac": case "opus": return FILE_TYPE_ICONS.audio;
      case "mp4": case "webm": case "mov": case "avi": case "mkv": case "m4v": case "ogv": return FILE_TYPE_ICONS.video;
      case "zip": case "tar": case "gz": case "tgz": case "7z": case "rar": case "bz2": case "xz": case "zst": return FILE_TYPE_ICONS.archive;
      case "sql": case "db": case "sqlite": case "sqlite3": case "dbf": case "csv": case "tsv": return FILE_TYPE_ICONS.database;
      case "html": case "htm": case "xhtml": return FILE_TYPE_ICONS.web;
      case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs": case "py": case "rb": case "go": case "rs": case "java": case "c": case "cc": case "cpp": case "h": case "hpp": case "cs": case "php": case "swift": case "kt": case "scala": case "sh": case "bash": case "zsh": case "fish": case "yml": case "yaml": case "json": case "toml": case "ini": case "cfg": case "conf": case "css": case "scss": case "less": case "xml": case "vue": case "svelte": case "lua": case "pl": case "r": case "dart": case "ex": case "exs": case "erl": case "hs": case "clj": case "graphql": case "gql": case "proto": return FILE_TYPE_ICONS.code;
      default: break;
    }
    if (kind === "pdf") return FILE_TYPE_ICONS.pdf;
    if (kind === "image") return FILE_TYPE_ICONS.image;
    if (kind === "audio") return FILE_TYPE_ICONS.audio;
    if (kind === "video") return FILE_TYPE_ICONS.video;
    if (kind === "code" || kind === "markdown" || kind === "html") return FILE_TYPE_ICONS.code;
    return FILE_TYPE_ICONS.file;
  }

  #formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }

  /**
   * True when `partial` looks like an in-progress streaming fragment of
   * `complete` (e.g. `src/app.t` before `src/app.ts` lands): same directory
   * and filename stem, with `complete` growing the path by extension.
   */
  static #supersedes(partial: string, complete: string): boolean {
    const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
    const left = normalize(partial);
    const right = normalize(complete);
    if (right.length <= left.length || !right.startsWith(left)) return false;
    const dirOf = (value: string) => (value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "");
    const stemOf = (value: string) => {
      const name = value.slice(value.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      return dot > 0 ? name.slice(0, dot) : name;
    };
    return dirOf(left) === dirOf(right) && stemOf(left) === stemOf(right);
  }
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value);
}
