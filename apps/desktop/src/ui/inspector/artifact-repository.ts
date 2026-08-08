import { projectRelativePath } from "../chat/tool-activity.js";
import { normalizeResourceReference } from "../../markdown.js";
import { textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

/** A file the user inspected that is kept in the persistent repository. */
export interface RepositoryFile {
  path: string;
  name: string;
  addedAt: number;
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

/**
 * The artifact repository — the Inspector's defacto base tab. It grows with
 * every file the agent produces (registered as soon as it appears in the
 * conversation, persisted by path) and with the current session's uploaded
 * artifacts, and renders as one list where every entry reopens in the
 * Inspector.
 */
export class ArtifactRepository {
  readonly #options: ArtifactRepositoryOptions;
  #files: RepositoryFile[] = [];
  #sessionArtifacts: Json[] = [];
  #container: HTMLElement | undefined;

  constructor(options: ArtifactRepositoryOptions) {
    this.#options = options;
    this.#load();
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
    } else {
      this.#files.unshift({ path, name: name || path, addedAt: Date.now() });
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
    this.#files.unshift({ path: reference, name: reference.split(/[\\/]/).pop() || reference, addedAt: Date.now() });
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
      const raw = localStorage.getItem(this.#options.storageKey ?? "fitz-inspector-repository");
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      // Migration: normalize chat-emitted references that were stored with
      // stray delimiters (e.g. a streamed `(src/app.t`) and drop duplicates.
      const seen = new Set<string>();
      this.#files = parsed
        .filter((entry): entry is RepositoryFile => typeof entry === "object" && entry !== null && typeof (entry as RepositoryFile).path === "string")
        .map((entry) => ({
          path: normalizeResourceReference(entry.path),
          name: typeof entry.name === "string" ? entry.name : entry.path,
          addedAt: typeof entry.addedAt === "number" ? entry.addedAt : 0,
        }))
        .sort((left, right) => right.addedAt - left.addedAt)
        .filter((entry) => {
          if (!entry.path || seen.has(entry.path)) return false;
          seen.add(entry.path);
          return true;
        });
    } catch {
      this.#files = [];
    }
  }

  #save(): void {
    try {
      localStorage.setItem(this.#options.storageKey ?? "fitz-inspector-repository", JSON.stringify(this.#files));
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
      list.append(this.#item(String(artifact.name ?? "Artifact"), `${this.#formatBytes(Number(artifact.byteSize ?? 0))} · Attachment`, () => this.#options.onOpenArtifact(artifact)));
    }
    for (const file of this.#files) {
      const root = this.#options.getProjectRoot?.() ?? "";
      list.append(this.#item(file.name, this.#displayPath(file.path, root), () => this.#options.onOpenFile(file.path)));
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

  #item(name: string, meta: string, open: () => void): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "inspector-repository-item";
    const label = document.createElement("span");
    label.textContent = name;
    const detail = document.createElement("small");
    detail.textContent = meta;
    detail.title = meta;
    row.append(label, detail);
    row.addEventListener("click", open);
    return row;
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
