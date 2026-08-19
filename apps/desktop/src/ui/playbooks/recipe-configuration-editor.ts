import type { RecipeSpeculativeDecoding, SpeculativeDrafter } from "@fitz/protocol";

type Json = Record<string, any>;
type FieldType = "text" | "number" | "boolean" | "lines";
interface Field { key: string; label: string; type: FieldType; placeholder?: string; help?: string; advanced?: boolean }

const COMMON_MANAGED: Field[] = [
  { key: "executable", label: "Server executable", type: "text" },
  { key: "modelPath", label: "Model file", type: "text" },
  { key: "expectedVramMiB", label: "Expected VRAM (MiB)", type: "number", advanced: true },
  { key: "readinessTimeoutMs", label: "Startup timeout (ms)", type: "number", advanced: true },
];

const MEDIA_PROVIDER_FIELDS: Field[] = [
  { key: "baseUrl", label: "Provider base URL", type: "text" },
  { key: "modelId", label: "Provider model ID", type: "text" },
  { key: "healthPath", label: "Health endpoint", type: "text" },
  { key: "apiKeyEnv", label: "API key environment variable", type: "text", advanced: true },
];

const FIELDS: Record<string, Field[]> = {
  "llama-cpp": [...COMMON_MANAGED, { key: "gpuLayers", label: "GPU layers", type: "number", help: "Leave empty to use the engine default." }, { key: "threads", label: "CPU threads", type: "number", advanced: true }, { key: "extraArgs", label: "Additional arguments", type: "lines", help: "One argument per line. Fitz owns model, host, port, API key, and context arguments.", advanced: true }],
  ninfer: [{ key: "executable", label: "Server executable", type: "text" }, { key: "artifact", label: "NiF model artifact", type: "text" }, { key: "maxContext", label: "Maximum context", type: "number" }, { key: "expectedVramMiB", label: "Expected VRAM (MiB)", type: "number", advanced: true }, { key: "draftTokens", label: "Speculative draft tokens", type: "number", advanced: true }],
  comfyui: [{ key: "baseUrl", label: "Existing ComfyUI URL", type: "text", help: "Use this for an already-running server; otherwise configure the managed fields below." }, { key: "executable", label: "Python executable", type: "text" }, { key: "cwd", label: "ComfyUI folder", type: "text" }, { key: "entrypoint", label: "Entrypoint", type: "text", placeholder: "main.py" }, { key: "comfyuiWorkflowPath", label: "Pinned workflow file", type: "text" }, { key: "expectedVramMiB", label: "Expected VRAM (MiB)", type: "number", advanced: true }, { key: "readinessTimeoutMs", label: "Startup timeout (ms)", type: "number", advanced: true }, { key: "launchArgs", label: "Additional launch arguments", type: "lines", advanced: true }, { key: "outputFormats", label: "Accepted output formats", type: "lines", advanced: true }],
  "openai-compatible": [{ key: "baseUrl", label: "API base URL", type: "text" }, { key: "healthPath", label: "Health endpoint", type: "text", placeholder: "/v1/models" }, { key: "apiKeyEnv", label: "API key environment variable", type: "text", advanced: true }, { key: "allowInsecureRemote", label: "Allow non-local HTTP", type: "boolean", advanced: true }],
  "openai-managed": [{ key: "enginePath", label: "Engine folder", type: "text" }, { key: "runtime", label: "Runtime", type: "text", placeholder: "linux-managed" }, { key: "runtimeId", label: "Managed runtime", type: "text", placeholder: "inference-linux" }, { key: "command", label: "Start command", type: "text" }, { key: "workingDirectory", label: "Working directory", type: "text" }, { key: "healthPath", label: "Health endpoint", type: "text" }, { key: "readinessTimeoutMs", label: "Startup timeout (ms)", type: "number", advanced: true }, { key: "args", label: "Arguments", type: "lines", advanced: true }],
  "openai-media": MEDIA_PROVIDER_FIELDS,
  fal: MEDIA_PROVIDER_FIELDS,
  replicate: MEDIA_PROVIDER_FIELDS,
};

/** Schema-driven recipe form. Adapter-specific configuration remains typed;
 * unrepresented adapter-owned values are preserved without exposing raw JSON. */
export class RecipeConfigurationEditor {
  readonly #controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  #source: Json = {};
  #speculativeDecoding: RecipeSpeculativeDecoding | undefined;
  #speculativeDrafters: SpeculativeDrafter[] = [];
  #speculativeSelect: HTMLSelectElement | undefined;
  constructor(readonly root: HTMLElement) {}

  load(adapter: string, configuration: Json, recipe: Json = {}, options: { showRuntimeSettings?: boolean; speculativeDrafters?: SpeculativeDrafter[] } = {}): void {
    this.#source = structuredClone(configuration ?? {});
    this.#controls.clear(); this.#speculativeDecoding = readSpeculativeDecoding(recipe.speculativeDecoding);
    this.#speculativeDrafters = [...(options.speculativeDrafters ?? [])];
    this.#speculativeSelect = undefined;
    this.root.replaceChildren();
    const fields = FIELDS[adapter];
    if (!fields) throw new TypeError(`Unsupported recipe adapter: ${adapter}`);
    if (options.showRuntimeSettings) {
      const heading = document.createElement("div"); heading.className = "configuration-section-heading";
      const title = document.createElement("strong"); title.textContent = "Runtime setup";
      const description = document.createElement("small"); description.textContent = `Required only while creating this ${adapter} recipe.`;
      heading.append(title, description);
      const grid = document.createElement("div"); grid.className = "configuration-grid recipe-configuration-grid";
      for (const field of fields) grid.append(this.#field(field, configuration[field.key]));
      this.root.append(heading, grid);
    }
    if (adapter === "openai-managed" && recipe.playbookId === "llama.cpp" && (this.#speculativeDecoding || this.#speculativeDrafters.length > 0)) {
      this.#renderSpeculativeDecoding();
    }
  }

  /** Returns undefined when the recipe has no drafter control, an object when
   * enabled, or null when an existing automatically-linked drafter was
   * explicitly disabled. The null value is intentional: the host parser uses
   * it to clear the persisted relationship instead of silently preserving it. */
  speculativeDecodingValue(): RecipeSpeculativeDecoding | null | undefined {
    if (!this.#speculativeSelect) return undefined;
    const selectedId = this.#speculativeSelect.value;
    if (!selectedId) return null;
    if (selectedId === "native-mtp") {
      return this.#speculativeDecoding?.strategy === "draft-mtp"
        ? structuredClone(this.#speculativeDecoding)
        : null;
    }
    const candidate = this.#speculativeDrafters.find((item) => item.id === selectedId);
    if (candidate) {
      const current = this.#speculativeDecoding?.strategy !== "draft-mtp" && this.#speculativeDecoding?.drafter.id === candidate.id ? this.#speculativeDecoding : undefined;
      return {
        strategy: current?.strategy ?? "draft-dflash",
        drafter: structuredClone(candidate),
        maxDraftTokens: current?.maxDraftTokens ?? 15,
        ...(current?.gpuLayers !== undefined ? { gpuLayers: current.gpuLayers } : { gpuLayers: "all" as const }),
        source: current?.source === "auto" ? "auto" : "manual",
      };
    }
    return this.#speculativeDecoding ? structuredClone(this.#speculativeDecoding) : null;
  }

  value(): Json {
    const result = structuredClone(this.#source);
    for (const [key, control] of this.#controls) {
      const field = control.dataset.fieldType as FieldType;
      if (field === "boolean") result[key] = (control as HTMLInputElement).checked;
      else if (!control.value.trim()) delete result[key];
      else if (field === "number") {
        const number = Number(control.value); if (!Number.isFinite(number)) throw new TypeError(`${control.dataset.label} must be a number`); result[key] = number;
      } else if (field === "lines") result[key] = control.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else result[key] = control.value.trim();
    }
    return result;
  }

  #field(field: Field, value: unknown): HTMLElement {
    const label = document.createElement("label"); if (field.type === "lines") label.classList.add("wide-field"); if (field.advanced) label.classList.add("advanced-field");
    label.append(document.createTextNode(field.label));
    const control = field.type === "lines" ? document.createElement("textarea") : document.createElement("input");
    control.dataset.fieldType = field.type; control.dataset.label = field.label;
    if (control instanceof HTMLInputElement) { control.type = field.type === "number" ? "number" : field.type === "boolean" ? "checkbox" : "text"; if (field.type === "number") control.step = "any"; if (field.type === "boolean") control.checked = value === true; else control.value = value === undefined ? "" : String(value); }
    else { control.rows = 4; control.value = Array.isArray(value) ? value.join("\n") : ""; }
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.help) { const help = document.createElement("small"); help.textContent = field.help; label.append(control, help); } else label.append(control);
    if (field.type === "boolean") label.classList.add("check-label");
    this.#controls.set(field.key, control); return label;
  }

  #renderSpeculativeDecoding(): void {
    const heading = document.createElement("div"); heading.className = "configuration-section-heading speculative-section-heading";
    const title = document.createElement("strong"); title.textContent = "Speculative decoding";
    const description = document.createElement("small"); description.textContent = "The target can use built-in MTP heads or a compatible auxiliary drafter.";
    heading.append(title, description);
    const label = document.createElement("label"); label.className = "speculative-toggle";
    const caption = document.createElement("span"); caption.textContent = "Drafter";
    const select = document.createElement("select"); select.dataset.speculativeDrafter = "true";
    const disabled = document.createElement("option"); disabled.value = ""; disabled.textContent = "Disabled"; select.append(disabled);
    if (this.#speculativeDecoding?.strategy === "draft-mtp") {
      const native = document.createElement("option"); native.value = "native-mtp"; native.textContent = `Native MTP · ${this.#speculativeDecoding.maxDraftTokens} tokens`; native.selected = true; select.append(native);
    }
    const candidates = [...this.#speculativeDrafters];
    const currentDrafter = this.#speculativeDecoding?.strategy === "draft-mtp" ? undefined : this.#speculativeDecoding?.drafter;
    if (currentDrafter && !candidates.some((item) => item.id === currentDrafter.id)) candidates.push(currentDrafter);
    for (const candidate of candidates.sort((left, right) => left.modelId.localeCompare(right.modelId))) {
      const option = document.createElement("option"); option.value = candidate.id; option.textContent = candidate.modelId; option.title = candidate.path;
      if (candidate.id === currentDrafter?.id) option.selected = true;
      select.append(option);
    }
    if (!this.#speculativeDecoding && candidates.length > 0) select.value = "";
    const source = document.createElement("small"); source.textContent = this.#speculativeDecoding?.source === "manual" ? "Configured manually" : this.#speculativeDecoding ? "Detected automatically" : "Choose a compatible artifact";
    label.append(caption, select, source);
    this.#speculativeSelect = select;
    this.root.append(heading, label);
  }

}

function readSpeculativeDecoding(value: unknown): RecipeSpeculativeDecoding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<RecipeSpeculativeDecoding>;
  if (candidate.strategy !== "draft-model" && candidate.strategy !== "draft-dflash" && candidate.strategy !== "draft-mtp") return undefined;
  if (!Number.isInteger(candidate.maxDraftTokens) || (candidate.maxDraftTokens as number) < 1) return undefined;
  if (candidate.strategy === "draft-mtp") return structuredClone(candidate as RecipeSpeculativeDecoding);
  if (!candidate.drafter || typeof candidate.drafter !== "object") return undefined;
  const drafter = candidate.drafter as Partial<SpeculativeDrafter>;
  if (typeof drafter.id !== "string" || typeof drafter.modelId !== "string" || typeof drafter.path !== "string") return undefined;
  return structuredClone(candidate as RecipeSpeculativeDecoding);
}
