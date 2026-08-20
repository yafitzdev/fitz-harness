import { textBlock } from "../primitives/dom.js";
import type { ActionFeedback } from "../primitives/action-status.js";

type Json = Record<string, any>;

export interface ArtifactControllerOptions {
  list: HTMLElement;
  fileInput: HTMLInputElement;
  pickButton: HTMLButtonElement;
  getSessionId: () => string | undefined;
  isNewChat: () => boolean;
  api: (path: string, method?: string, body?: Json) => Promise<Json>;
  setSessionArtifacts: (artifacts: Json[]) => void;
  previewArtifact: (artifact: Json, source?: HTMLButtonElement, list?: HTMLElement) => void | Promise<void>;
  openInspector: () => void;
  clearChips: () => void;
  addChip: (name: string, detail: string, preview: () => void, remove: () => void) => void;
  stageFile: (file: File) => void;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

/** Owns task artifact loading, picker staging, upload, and repository rendering. */
export class ArtifactController {
  readonly #options: ArtifactControllerOptions;
  #loadGeneration = 0;
  #sessionId: string | undefined;
  #sessionArtifacts: Json[] = [];

  constructor(options: ArtifactControllerOptions) {
    this.#options = options;
    options.pickButton.addEventListener("click", () => this.choose());
    options.fileInput.addEventListener("change", () => void this.uploadSelected());
  }

  setEnabled(enabled: boolean): void { this.#options.pickButton.disabled = !enabled; }

  choose(): void {
    if (!this.#options.getSessionId() && !this.#options.isNewChat()) {
      this.#options.showStatus("Create or select a task before attaching a file", "error");
      return;
    }
    this.#options.fileInput.click();
  }

  async load(): Promise<Json[]> {
    const generation = ++this.#loadGeneration;
    const { list } = this.#options;
    list.replaceChildren();
    this.#options.clearChips();
    const sessionId = this.#options.getSessionId();
    this.#sessionId = sessionId;
    if (!sessionId) {
      this.#sessionArtifacts = [];
      this.#options.setSessionArtifacts([]);
      list.append(textBlock("panel-empty", "Artifacts appear with a task"));
      return [];
    }
    const response = await this.#options.api(`/api/v1/sessions/${sessionId}/artifacts`);
    if (generation !== this.#loadGeneration || this.#options.getSessionId() !== sessionId) return [];
    const artifacts = Array.isArray(response.data) ? response.data : [];
    this.#sessionArtifacts = artifacts;
    this.#options.setSessionArtifacts(artifacts);
    if (!artifacts.length) list.append(textBlock("panel-empty", "No artifacts yet"));
    for (const artifact of artifacts) list.append(this.#renderItem(artifact));
    return artifacts;
  }

  async uploadData(sessionId: string, input: { name: string; mimeType: string; contentBase64: string }): Promise<Json> {
    const response = await this.#options.api(`/api/v1/sessions/${sessionId}/artifacts`, "POST", input);
    const artifact = response.data as Json;
    if (this.#sessionId !== sessionId) {
      this.#sessionId = sessionId;
      this.#sessionArtifacts = [];
    }
    const id = String(artifact.id ?? "");
    const sha256 = String(artifact.sha256 ?? "").toLowerCase();
    const duplicate = this.#sessionArtifacts.find((candidate) => {
      if (id && String(candidate.id ?? "") === id) return true;
      return Boolean(sha256) && String(candidate.sha256 ?? "").toLowerCase() === sha256;
    });
    if (duplicate) Object.assign(duplicate, artifact);
    else this.#sessionArtifacts = [...this.#sessionArtifacts, artifact];
    this.#options.setSessionArtifacts(this.#sessionArtifacts);
    return artifact;
  }

  /** Removes an upload that never became part of an admitted message. */
  async discardUpload(sessionId: string, artifactId: string): Promise<void> {
    await this.#options.api(`/api/v1/artifacts/${encodeURIComponent(artifactId)}`, "DELETE");
    if (this.#sessionId !== sessionId) return;
    this.#sessionArtifacts = this.#sessionArtifacts.filter((artifact) => String(artifact.id ?? "") !== artifactId);
    this.#options.setSessionArtifacts(this.#sessionArtifacts);
  }

  async uploadSelected(): Promise<void> {
    const files = [...(this.#options.fileInput.files ?? [])];
    this.#options.fileInput.value = "";
    if (!files.length) return;
    // A chooser selection is context for the next message, regardless of
    // whether the chat already exists. Prompt submission uploads it durably,
    // references it in the run, and consumes the chip exactly once.
    for (const file of files) this.#options.stageFile(file);
  }

  #renderItem(artifact: Json): HTMLElement {
    const value = document.createElement("button");
    value.type = "button";
    value.className = "artifact-item";
    const name = document.createElement("span");
    name.textContent = artifact.name;
    const detail = document.createElement("small");
    detail.textContent = formatBytes(Number(artifact.byteSize ?? 0));
    const preview = () => void this.#options.previewArtifact(artifact, value, this.#options.list);
    value.append(name, detail);
    value.addEventListener("click", preview);
    return value;
  }
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}
