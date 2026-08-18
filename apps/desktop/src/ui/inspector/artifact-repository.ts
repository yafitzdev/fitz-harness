import { projectRelativePath } from "../chat/tool-activity.js";
import { normalizeResourceReference } from "../../markdown.js";
import { svgIcon, textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

/** A file created or modified by the agent that is kept in the repository. */
export interface RepositoryFile {
  path: string;
  name: string;
  addedAt: number;
  origin: "generated";
}

function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value);
}

export interface ArtifactRepositoryOptions {
  /** localStorage key that persists generated files (default "fitz-inspector-repository"). */
  storageKey?: string;
  /** Opens a persisted file in the Inspector (receives the absolute path). */
  onOpenFile: (path: string) => void;
  /** Opens a session upload in the Inspector. */
  onOpenArtifact: (artifact: Json) => void;
  /** Resolves the active project root so repository rows can show relative paths. */
  getProjectRoot?: () => string;
}

/** Keeps at most this many generated files in the persisted repository. */
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
 * The artifact repository — the Inspector's de facto base tab. It contains
 * only files created/modified by the agent and files uploaded by the user.
 * Arbitrary links in chat remain openable in the Inspector, but do not become
 * repository entries merely because they were mentioned or inspected.
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
    // Uploads are session-scoped too. Clear them synchronously so a chat
    // switch cannot briefly render the previous chat's attachments while the
    // host fetch for the new session is still in flight.
    this.#sessionArtifacts = [];
    this.#load();
    this.#render();
  }

  /** The persisted agent-generated files, newest first. */
  files(): RepositoryFile[] { return this.#files; }

  /**
   * Adds (or refreshes) a file created or modified by the agent. References
   * with the same canonical project path are coalesced; ambiguous shortened
   * paths remain separate, and an absolute path is retained for reopening.
   */
  registerGeneratedFile(path: string, action: "edited" | "created" = "edited"): void {
    if (!path || /^(?:https?|file):\/\//i.test(path)) return;
    const reference = normalizeResourceReference(path);
    if (!reference) return;
    const root = this.#options.getProjectRoot?.() ?? "";
    const now = Date.now();
    const duplicate = this.#files.find((file) => ArtifactRepository.#sameFileReference(file.path, reference, root));
    if (duplicate) {
      duplicate.path = ArtifactRepository.#preferredPath(duplicate.path, reference, root);
      duplicate.name = duplicate.path.split(/[\\/]/).pop() || duplicate.name;
      duplicate.addedAt = now;
      duplicate.origin = "generated";
    } else {
      this.#files.unshift({ path: reference, name: reference.split(/[\\/]/).pop() || reference, addedAt: now, origin: "generated" });
    }
    if (this.#files.length > MAX_FILES) this.#files.length = MAX_FILES;
    this.#save();
    this.#render();
  }

  /** Replaces the current session's user-uploaded artifacts, deduplicated by content. */
  setSessionArtifacts(artifacts: Json[]): void {
    const seen = new Set<string>();
    this.#sessionArtifacts = artifacts.filter((artifact) => {
      const id = String(artifact.id ?? "");
      const sha256 = String(artifact.sha256 ?? "").toLowerCase();
      // Malformed/incomplete records are still renderable; without an id or
      // checksum they cannot be safely compared to another record.
      if (!id && !sha256) return true;
      const key = sha256 ? `sha256:${sha256}` : `id:${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
      // This is a derived cache. Older builds persisted every link that
      // appeared in chat and every file the user inspected. Those entries are
      // intentionally discarded during the semantic migration: only entries
      // explicitly marked as agent-generated belong here now. User uploads
      // are durable host artifacts and are loaded separately via
      // setSessionArtifacts().
      let changed = false;
      const loaded = parsed
        .filter((entry): entry is RepositoryFile => typeof entry === "object" && entry !== null && typeof (entry as RepositoryFile).path === "string")
        .map((entry) => ({
          path: normalizeResourceReference(entry.path),
          name: typeof entry.name === "string" ? entry.name : entry.path,
          addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
          ...(entry.origin === "generated" ? { origin: "generated" as const } : {}),
        }))
        .sort((left, right) => right.addedAt - left.addedAt)
        .filter((entry): entry is RepositoryFile => {
          if (!entry.path || entry.origin !== "generated") { changed = true; return false; }
          return true;
        });
      this.#files = [];
      const root = this.#options.getProjectRoot?.() ?? "";
      for (const entry of loaded) {
        const duplicate = this.#files.find((file) => ArtifactRepository.#sameFileReference(file.path, entry.path, root));
        if (duplicate) {
          changed = true;
          duplicate.path = ArtifactRepository.#preferredPath(duplicate.path, entry.path, root);
          duplicate.name = duplicate.path.split(/[\\/]/).pop() || duplicate.name;
        } else this.#files.push(entry);
      }
      if (this.#files.length !== loaded.length) changed = true;
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
      this.#container.append(textBlock("inspector-empty", "Agent-generated files and user uploads appear here."));
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
    // Already relative (for example a generated path outside the active root): keep.
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

  /**
   * File identity is exact after resolving an absolute path beneath the
   * project root to its project-relative form. A short suffix is not an
   * identity: `src/index.ts` and `packages/foo/src/index.ts` may both exist.
   * The only non-exact case is a same-directory streaming extension fragment.
   */
  static #sameFileReference(left: string, right: string, root: string): boolean {
    const normalizedLeft = ArtifactRepository.#relativeComparable(left, root);
    const normalizedRight = ArtifactRepository.#relativeComparable(right, root);
    if (normalizedLeft === normalizedRight) return true;
    return ArtifactRepository.#supersedes(normalizedLeft, normalizedRight)
      || ArtifactRepository.#supersedes(normalizedRight, normalizedLeft);
  }

  static #relativeComparable(value: string, root: string): string {
    const windowsPath = /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(root) || /^\\\\/.test(value) || /^\\\\/.test(root);
    const normalize = (input: string) => {
      const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
      return windowsPath ? normalized.toLowerCase() : normalized;
    };
    if (root && isAbsolutePath(value) && isAbsolutePath(root)) {
      const normalizedValue = normalize(value);
      const normalizedRoot = normalize(root);
      if (normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}/`)) {
        return `project:${normalizedValue.slice(normalizedRoot.length).replace(/^\/+/, "")}`;
      }
    }
    if (!isAbsolutePath(value) && root) return `project:${normalize(value)}`;
    return `${isAbsolutePath(value) ? "absolute" : "relative"}:${normalize(value)}`;
  }

  static #preferredPath(left: string, right: string, root: string): string {
    if (isAbsolutePath(right) && !isAbsolutePath(left)) return right;
    if (isAbsolutePath(left) && !isAbsolutePath(right)) return left;
    const leftLength = ArtifactRepository.#relativeComparable(left, root).split("/").length;
    const rightLength = ArtifactRepository.#relativeComparable(right, root).split("/").length;
    return rightLength > leftLength ? right : left;
  }
}
