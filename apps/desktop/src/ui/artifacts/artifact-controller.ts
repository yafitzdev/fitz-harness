import { textBlock } from "../primitives/dom.js";

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
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

/** Owns task artifact loading, picker staging, upload, and repository rendering. */
export class ArtifactController {
  readonly #options: ArtifactControllerOptions;

  constructor(options: ArtifactControllerOptions) {
    this.#options = options;
    options.pickButton.addEventListener("click", () => this.choose());
    options.fileInput.addEventListener("change", () => void this.uploadSelected());
  }

  setEnabled(enabled: boolean): void { this.#options.pickButton.disabled = !enabled; }

  choose(): void {
    if (!this.#options.getSessionId() && !this.#options.isNewChat()) {
      this.#options.showToast("Create or select a task before attaching a file");
      return;
    }
    this.#options.fileInput.click();
  }

  async load(): Promise<Json[]> {
    const { list } = this.#options;
    list.replaceChildren();
    this.#options.clearChips();
    const sessionId = this.#options.getSessionId();
    if (!sessionId) {
      this.#options.setSessionArtifacts([]);
      list.append(textBlock("panel-empty", "Artifacts appear with a task"));
      return [];
    }
    const response = await this.#options.api(`/api/v1/sessions/${sessionId}/artifacts`);
    const artifacts = Array.isArray(response.data) ? response.data : [];
    this.#options.setSessionArtifacts(artifacts);
    if (!artifacts.length) list.append(textBlock("panel-empty", "No artifacts yet"));
    for (const artifact of artifacts) list.append(this.#renderItem(artifact));
    return artifacts;
  }

  async uploadData(sessionId: string, input: { name: string; mimeType: string; contentBase64: string }): Promise<Json> {
    const response = await this.#options.api(`/api/v1/sessions/${sessionId}/artifacts`, "POST", input);
    return response.data;
  }

  async uploadSelected(): Promise<void> {
    const file = this.#options.fileInput.files?.[0];
    this.#options.fileInput.value = "";
    if (!file) return;
    if (file.size > 5_000_000) {
      this.#options.showToast("Artifacts are currently limited to 5 MB");
      return;
    }
    const sessionId = this.#options.getSessionId();
    if (!sessionId) {
      if (this.#options.isNewChat()) this.#options.stageFile(file);
      else this.#options.showToast("Create or select a task before attaching a file");
      return;
    }
    try {
      await this.uploadData(sessionId, {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      });
      await this.load();
      this.#options.openInspector();
      this.#options.showToast(`Attached ${file.name}`);
    } catch (error) {
      this.#options.showToast(this.#options.errorMessage(error));
    }
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
    // Generated media stays a durable output. Only user uploads can become
    // composer context chips for a later turn.
    if (!artifact.metadata?.mediaJobId) this.#options.addChip(artifact.name, detail.textContent, preview, () => undefined);
    return value;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}
