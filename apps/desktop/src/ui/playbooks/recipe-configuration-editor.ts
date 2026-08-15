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
  #workerCount: HTMLInputElement | undefined;
  #workerContext: HTMLInputElement | undefined;
  #mainContext: HTMLElement | undefined;
  #agentValidation: HTMLElement | undefined;
  #sharedContextTokens = 0;
  #modelContextTokens = 0;
  #maximumWorkers = 0;
  #agentTopologyEnabled = false;
  constructor(readonly root: HTMLElement) {}

  load(adapter: string, configuration: Json, recipe: Json = {}, options: { showRuntimeSettings?: boolean } = {}): void {
    this.#source = structuredClone(configuration ?? {});
    this.#controls.clear(); this.root.replaceChildren();
    const fields = FIELDS[adapter];
    if (!fields) throw new TypeError(`Unsupported recipe adapter: ${adapter}`);
    this.#modelContextTokens = Number(recipe.contextTokens ?? this.#source.maxContext ?? 131_072);
    this.#sharedContextTokens = Number(recipe.agentTopology?.sharedContextTokens ?? this.#modelContextTokens);
    if (options.showRuntimeSettings) {
      const heading = document.createElement("div"); heading.className = "configuration-section-heading";
      const title = document.createElement("strong"); title.textContent = "Runtime setup";
      const description = document.createElement("small"); description.textContent = `Required only while creating this ${adapter} recipe.`;
      heading.append(title, description);
      const grid = document.createElement("div"); grid.className = "configuration-grid recipe-configuration-grid";
      for (const field of fields) grid.append(this.#field(field, configuration[field.key]));
      this.root.append(heading, grid);
    }
    this.#loadAgentTopology(recipe);
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

  agentTopology(): Json | undefined {
    if (!this.#agentTopologyEnabled || !this.#workerCount || !this.#workerContext) return undefined;
    return {
      sharedContextTokens: this.#sharedContextTokens,
      workers: {
        count: Number(this.#workerCount.value),
        contextTokens: Number(this.#workerContext.value),
      },
    };
  }

  setModelContextTokens(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) return;
    this.#modelContextTokens = value;
    this.#updateAgentSummary();
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

  #loadAgentTopology(recipe: Json): void {
    this.#workerCount = undefined;
    this.#workerContext = undefined;
    this.#mainContext = undefined;
    this.#agentValidation = undefined;
    const capabilities = recipe.capabilities ?? {};
    this.#maximumWorkers = Math.max(0, Number(capabilities.maxConcurrentGenerations ?? 1) - 1);
    this.#agentTopologyEnabled = capabilities.chatCompletions === true && capabilities.toolCalls === true && this.#maximumWorkers > 0;
    this.#modelContextTokens = Number(recipe.contextTokens ?? this.#source.maxContext ?? 131_072);
    this.#sharedContextTokens = Number(recipe.agentTopology?.sharedContextTokens ?? this.#modelContextTokens);
    const configuredCount = Number(recipe.agentTopology?.workers?.count ?? 0);
    const configuredContext = Number(recipe.agentTopology?.workers?.contextTokens ?? Math.min(32_000, this.#modelContextTokens));

    const topology = document.createElement("section"); topology.className = "agent-topology-editor";
    const summary = document.createElement("div"); summary.className = "agent-topology-summary";
    const main = document.createElement("div"); main.className = "agent-topology-member";
    const mainLabel = document.createElement("strong"); mainLabel.textContent = "Main agent";
    const mainRole = document.createElement("small"); mainRole.textContent = "Orchestration, delegation, and synthesis";
    this.#mainContext = document.createElement("b"); this.#mainContext.dataset.agentMainContext = "";
    main.append(mainLabel, mainRole, this.#mainContext);
    const pool = document.createElement("div"); pool.className = "agent-topology-member";
    const poolLabel = document.createElement("strong"); poolLabel.textContent = "Worker pool";
    const poolRole = document.createElement("small"); poolRole.textContent = "The orchestrator assigns roles at dispatch";
    const poolValue = document.createElement("b"); poolValue.dataset.agentWorkerSummary = "";
    pool.append(poolLabel, poolRole, poolValue);
    summary.append(main, pool);

    const fields = document.createElement("div"); fields.className = "configuration-grid agent-topology-fields";
    const countLabel = document.createElement("label"); countLabel.append(document.createTextNode("Workers"));
    this.#workerCount = document.createElement("input"); this.#workerCount.type = "number"; this.#workerCount.min = "0"; this.#workerCount.max = String(this.#maximumWorkers); this.#workerCount.step = "1"; this.#workerCount.value = String(Math.min(configuredCount, this.#maximumWorkers)); this.#workerCount.disabled = !this.#agentTopologyEnabled; this.#workerCount.dataset.agentWorkerCount = "";
    countLabel.append(this.#workerCount);
    const contextLabel = document.createElement("label"); contextLabel.append(document.createTextNode("Context per worker"));
    this.#workerContext = document.createElement("input"); this.#workerContext.type = "number"; this.#workerContext.min = "2048"; this.#workerContext.max = String(this.#modelContextTokens); this.#workerContext.step = "1"; this.#workerContext.value = String(configuredContext); this.#workerContext.disabled = !this.#agentTopologyEnabled; this.#workerContext.dataset.agentWorkerContext = "";
    contextLabel.append(this.#workerContext);
    fields.append(countLabel, contextLabel);

    this.#agentValidation = document.createElement("small"); this.#agentValidation.className = "agent-topology-validation";

    topology.append(summary, ...(this.#agentTopologyEnabled ? [fields] : []), this.#agentValidation);
    this.root.append(topology);
    this.#workerCount.addEventListener("input", () => this.#updateAgentSummary());
    this.#workerContext.addEventListener("input", () => this.#updateAgentSummary());
    this.#updateAgentSummary(poolValue);
  }

  #updateAgentSummary(workerSummary = this.root.querySelector<HTMLElement>("[data-agent-worker-summary]")): void {
    if (!this.#workerCount || !this.#workerContext || !this.#mainContext || !this.#agentValidation) return;
    const count = Number(this.#workerCount.value);
    const workerContext = Number(this.#workerContext.value);
    const mainContext = Math.min(this.#modelContextTokens, this.#sharedContextTokens - (count * workerContext));
    this.#mainContext.textContent = `${formatTokens(Math.max(0, mainContext))} context`;
    if (workerSummary) workerSummary.textContent = count > 0 ? `${count} × ${formatTokens(workerContext)}` : "No workers";
    const valid = Number.isSafeInteger(count) && count >= 0 && count <= this.#maximumWorkers
      && Number.isSafeInteger(workerContext) && workerContext >= 2_048 && workerContext <= this.#modelContextTokens
      && mainContext >= 2_048;
    this.#agentValidation.textContent = valid ? "" : "The worker pool exceeds this recipe's context or concurrency capacity.";
    this.#agentValidation.classList.toggle("is-error", !valid);
    this.#workerCount.setCustomValidity(valid ? "" : "Invalid worker pool");
    this.#workerContext.setCustomValidity(valid ? "" : "Invalid worker pool");
    const maxContext = this.#controls.get("maxContext");
    if (maxContext instanceof HTMLInputElement && this.#agentTopologyEnabled) {
      maxContext.value = String(Math.max(0, mainContext));
      maxContext.readOnly = true;
      maxContext.dataset.derivedAgentContext = "";
    }
  }
}

function formatTokens(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}
