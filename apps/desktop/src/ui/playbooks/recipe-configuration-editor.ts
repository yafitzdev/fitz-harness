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
  ninfer: [{ key: "executable", label: "Server executable", type: "text" }, { key: "artifact", label: "NiF model artifact", type: "text" }, { key: "maxContext", label: "Maximum context", type: "number" }, { key: "expectedVramMiB", label: "Expected VRAM (MiB)", type: "number", advanced: true }, { key: "draftTokens", label: "Speculative draft tokens", type: "number", advanced: true }, { key: "thinking", label: "Thinking mode", type: "boolean", advanced: true }, { key: "temperature", label: "Default temperature", type: "number", advanced: true }, { key: "topP", label: "Default top P", type: "number", advanced: true }, { key: "topK", label: "Default top K", type: "number", advanced: true }],
  comfyui: [{ key: "baseUrl", label: "Existing ComfyUI URL", type: "text", help: "Use this for an already-running server; otherwise configure the managed fields below." }, { key: "executable", label: "Python executable", type: "text" }, { key: "cwd", label: "ComfyUI folder", type: "text" }, { key: "entrypoint", label: "Entrypoint", type: "text", placeholder: "main.py" }, { key: "comfyuiWorkflowPath", label: "Pinned workflow file", type: "text" }, { key: "expectedVramMiB", label: "Expected VRAM (MiB)", type: "number", advanced: true }, { key: "readinessTimeoutMs", label: "Startup timeout (ms)", type: "number", advanced: true }, { key: "launchArgs", label: "Additional launch arguments", type: "lines", advanced: true }, { key: "outputFormats", label: "Accepted output formats", type: "lines", advanced: true }],
  "openai-compatible": [{ key: "baseUrl", label: "API base URL", type: "text" }, { key: "healthPath", label: "Health endpoint", type: "text", placeholder: "/v1/models" }, { key: "apiKeyEnv", label: "API key environment variable", type: "text", advanced: true }, { key: "allowInsecureRemote", label: "Allow non-local HTTP", type: "boolean", advanced: true }],
  "openai-managed": [{ key: "enginePath", label: "Engine folder", type: "text" }, { key: "runtime", label: "Runtime", type: "text", placeholder: "windows or wsl" }, { key: "command", label: "Start command", type: "text" }, { key: "workingDirectory", label: "Working directory", type: "text" }, { key: "healthPath", label: "Health endpoint", type: "text" }, { key: "wslDistribution", label: "WSL distribution", type: "text", advanced: true }, { key: "readinessTimeoutMs", label: "Startup timeout (ms)", type: "number", advanced: true }, { key: "args", label: "Arguments", type: "lines", advanced: true }],
  "openai-media": MEDIA_PROVIDER_FIELDS,
  fal: MEDIA_PROVIDER_FIELDS,
  replicate: MEDIA_PROVIDER_FIELDS,
};

/** Schema-driven recipe form. Adapter-specific configuration remains typed;
 * unrepresented adapter-owned values are preserved without exposing raw JSON. */
export class RecipeConfigurationEditor {
  readonly #controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  #source: Json = {};
  constructor(readonly root: HTMLElement) {}

  load(adapter: string, configuration: Json): void {
    this.#source = structuredClone(configuration ?? {});
    this.#controls.clear(); this.root.replaceChildren();
    const heading = document.createElement("div"); heading.className = "configuration-section-heading";
    const title = document.createElement("strong"); title.textContent = "Runtime settings";
    const description = document.createElement("small"); description.textContent = `Only settings supported by ${adapter} are shown.`;
    heading.append(title, description);
    const grid = document.createElement("div"); grid.className = "configuration-grid recipe-configuration-grid";
    const fields = FIELDS[adapter];
    if (!fields) throw new TypeError(`Unsupported recipe adapter: ${adapter}`);
    for (const field of fields) grid.append(this.#field(field, configuration[field.key]));
    this.root.append(heading, grid);
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
    if (control instanceof HTMLInputElement) { control.type = field.type === "number" ? "number" : field.type === "boolean" ? "checkbox" : "text"; if (field.type === "boolean") control.checked = value === true; else control.value = value === undefined ? "" : String(value); }
    else { control.rows = 4; control.value = Array.isArray(value) ? value.join("\n") : ""; }
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.help) { const help = document.createElement("small"); help.textContent = field.help; label.append(control, help); } else label.append(control);
    if (field.type === "boolean") label.classList.add("check-label");
    this.#controls.set(field.key, control); return label;
  }
}
