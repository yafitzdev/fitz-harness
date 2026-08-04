type Json = Record<string, any>;

export interface PlaybookWorkspaceElements {
  page: HTMLElement;
  list: HTMLElement;
  search: HTMLInputElement;
  title: HTMLElement;
  description: HTMLElement;
  browser: HTMLElement;
  editor: HTMLElement;
  closeEditorButtons: HTMLButtonElement[];
  refresh: HTMLButtonElement;
  engineForm: HTMLFormElement;
  engineFolder: HTMLSelectElement;
  engineDisplayName: HTMLInputElement;
  engineConnection: HTMLSelectElement;
  engineRuntime: HTMLSelectElement;
  engineBaseUrl: HTMLInputElement;
  engineHealthPath: HTMLInputElement;
  engineCommand: HTMLInputElement;
  engineArguments: HTMLTextAreaElement;
  engineWorkingDirectory: HTMLInputElement;
  engineWslDistribution: HTMLInputElement;
  engineManagedFields: HTMLElement;
  engineRuntimeField: HTMLElement;
  engineBaseUrlField: HTMLElement;
  engineWslField: HTMLElement;
  engineEditorTitle: HTMLElement;
  recipeForm: HTMLFormElement;
  recipePlaybookId: HTMLInputElement;
  recipeId: HTMLInputElement;
  recipeDisplayName: HTMLInputElement;
  recipeAdapter: HTMLInputElement;
  recipeModelId: HTMLInputElement;
  recipeContextTokens: HTMLInputElement;
  recipeConfiguration: HTMLTextAreaElement;
  recipeEditorTitle: HTMLElement;
}

export interface PlaybookWorkspaceOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  reloadConfiguration: () => Promise<Json | undefined>;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

export class PlaybookWorkspaceController {
  readonly elements: PlaybookWorkspaceElements;
  private readonly options: PlaybookWorkspaceOptions;
  private configuration: Json | undefined;
  private readonly recipeTestStates = new Map<string, { state: "testing" | "passed" | "failed"; detail: string }>();
  private editingRecipe: Json | undefined;

  constructor(elements: PlaybookWorkspaceElements, options: PlaybookWorkspaceOptions) {
    this.elements = elements;
    this.options = options;
    this.bind();
  }

  get editorOpen(): boolean { return !this.elements.editor.hidden; }

  setConfiguration(configuration: Json | undefined): void {
    this.configuration = configuration;
  }

  showLoading(): void {
    this.elements.list.replaceChildren(emptyState("Loading playbooks…"));
  }

  showUnavailable(message: string): void {
    this.elements.list.replaceChildren(emptyState(`Management data is unavailable: ${message}`));
  }

  render(): void {
    const configuration = this.configuration;
    this.elements.list.replaceChildren();
    this.elements.title.textContent = "Playbooks";
    this.elements.description.textContent = "Engine folders appear automatically. Configure and test their recipes here.";
    this.elements.search.placeholder = "Search playbooks";
    if (!configuration) { this.elements.list.append(emptyState("Management data is unavailable")); return; }
    const recipes = configuration.recipes ?? [];
    const folders = configuration.engineFolders ?? [];
    const query = this.elements.search.value.trim().toLowerCase();
    const matches = (...values: unknown[]) => !query || values.some((value) => String(value ?? "").toLowerCase().includes(query));
    const visibleFolders = folders.filter((folder: Json) => {
      const engineRecipes = recipes.filter((recipe: Json) => recipe.playbookId === folder.folderName);
      return matches(folder.folderName, folder.rootPath, folder.engine?.displayName, ...engineRecipes.flatMap((recipe: Json) => [recipe.displayName, recipe.modelId]));
    });
    if (!visibleFolders.length) { this.elements.list.append(emptyState(`No engine folders found in ${configuration.engineRoot ?? "the configured root"}`)); return; }
    for (const folder of visibleFolders) this.elements.list.append(this.renderFolderCard(folder, recipes));
  }

  async testRecipe(recipe: Json, card: HTMLElement, button: HTMLButtonElement): Promise<void> {
    this.recipeTestStates.set(recipe.id, { state: "testing", detail: "Sending “Say hi.” to this recipe" });
    this.renderRecipeTestState(recipe.id, card, button);
    try {
      const response = await this.options.api(`/api/v1/management/recipes/${encodeURIComponent(recipe.id)}/test`, "POST");
      this.recipeTestStates.set(recipe.id, { state: "passed", detail: String(response.data?.output ?? "Recipe returned a response") });
    } catch (error) {
      this.recipeTestStates.set(recipe.id, { state: "failed", detail: this.options.errorMessage(error) });
    }
    this.renderRecipeTestState(recipe.id, card, button);
  }

  renderRecipeTestState(recipeId: string, card: HTMLElement, button: HTMLButtonElement): void {
    const result = this.recipeTestStates.get(recipeId);
    const state = result?.state ?? "idle";
    button.disabled = state === "testing";
    button.classList.toggle("testing", state === "testing");
    button.classList.toggle("passed", state === "passed");
    button.classList.toggle("failed", state === "failed");
    card.classList.toggle("recipe-test-passed", state === "passed");
    card.classList.toggle("recipe-test-failed", state === "failed");
    button.textContent = state === "testing" ? "Testing…" : state === "passed" ? "✓ Working" : state === "failed" ? "Retry" : "Test";
    button.title = result?.detail ?? "Send “Say hi.” directly to this recipe";
    button.setAttribute("aria-label", state === "passed" ? "Recipe test passed" : state === "failed" ? `Recipe test failed: ${result?.detail ?? "Unknown error"}. Retry` : state === "testing" ? "Testing recipe" : "Test recipe");
  }

  openEngineEditor(folder?: Json): void {
    this.elements.engineForm.reset();
    this.elements.engineFolder.replaceChildren();
    const folders = this.configuration?.engineFolders ?? [];
    for (const candidate of folders) {
      const option = document.createElement("option");
      option.value = candidate.folderName;
      option.textContent = candidate.folderName;
      this.elements.engineFolder.append(option);
    }
    const preferred = folder ?? folders.find((candidate: Json) => !candidate.registered) ?? folders[0];
    this.elements.engineEditorTitle.textContent = preferred?.engine ? "Configure engine" : "Set up engine";
    if (preferred) this.elements.engineFolder.value = preferred.folderName;
    else {
      const option = document.createElement("option");
      option.textContent = "No folders found";
      option.disabled = true;
      option.selected = true;
      this.elements.engineFolder.append(option);
    }
    this.applyEngineFolderChoice();
    this.showEditor("engine");
    (preferred ? this.elements.engineDisplayName : this.elements.engineFolder).focus();
  }

  openRecipeEditor(recipe?: Json, playbook?: Json): void {
    this.editingRecipe = recipe;
    this.elements.recipeForm.reset();
    this.elements.recipeEditorTitle.textContent = recipe ? "Edit recipe" : "Create recipe";
    const playbookIds = [...new Set((this.configuration?.recipes ?? []).map((item: Json) => item.playbookId))];
    const playbookId = recipe?.playbookId ?? playbook?.id ?? (playbookIds.length === 1 ? playbookIds[0] : "");
    this.elements.recipePlaybookId.value = playbookId; this.elements.recipePlaybookId.readOnly = Boolean(playbookId);
    this.elements.recipeId.value = recipe?.id ?? ""; this.elements.recipeId.readOnly = Boolean(recipe);
    this.elements.recipeDisplayName.value = recipe?.displayName ?? "";
    const adapter = recipe?.adapter ?? (playbook?.connectionMode === "managed" ? "openai-managed" : "openai-compatible");
    this.elements.recipeAdapter.value = adapter; this.elements.recipeAdapter.readOnly = true;
    this.elements.recipeModelId.value = recipe?.modelId ?? "";
    this.elements.recipeContextTokens.value = String(recipe?.contextTokens ?? 131_072);
    const defaultConfiguration = playbook?.connectionMode === "managed"
      ? { enginePath: playbook.rootPath, runtime: playbook.runtime, command: playbook.launchCommand, args: playbook.launchArguments, workingDirectory: playbook.workingDirectory ?? ".", healthPath: playbook.healthPath, readinessTimeoutMs: 120_000, ...(playbook.wslDistribution ? { wslDistribution: playbook.wslDistribution } : {}) }
      : playbook ? { baseUrl: playbook.baseUrl, healthPath: playbook.healthPath, allowInsecureRemote: false } : {};
    this.elements.recipeConfiguration.value = JSON.stringify(recipe?.configuration ?? defaultConfiguration, null, 2);
    this.showEditor("recipe"); this.elements.recipeId.focus();
  }

  closeEditor(): void {
    this.elements.editor.hidden = true;
    this.elements.browser.hidden = false;
    this.elements.engineForm.hidden = true;
    this.elements.recipeForm.hidden = true;
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.options.reloadConfiguration());
    this.elements.search.addEventListener("input", () => this.render());
    this.elements.engineForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveEngine(); });
    this.elements.recipeForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveRecipe(); });
    this.elements.engineFolder.addEventListener("change", () => this.applyEngineFolderChoice());
    this.elements.engineConnection.addEventListener("change", () => this.updateEngineFieldVisibility());
    this.elements.engineRuntime.addEventListener("change", () => this.updateEngineFieldVisibility());
    for (const button of this.elements.closeEditorButtons) button.addEventListener("click", () => this.closeEditor());
  }

  private renderFolderCard(folder: Json, recipes: Json[]): HTMLElement {
    const engine = folder.engine;
    const playbookId = folder.folderName;
    const playbookRecipes = recipes.filter((recipe: Json) => recipe.playbookId === playbookId);
    const card = document.createElement("section"); card.className = "playbook-card";
    const heading = document.createElement("div"); heading.className = "playbook-heading";
    const identity = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = engine?.displayName ?? playbookId;
    identity.append(title);
    const headingActions = document.createElement("div"); headingActions.className = "playbook-actions";
    const configure = document.createElement("button"); configure.type = "button"; configure.className = "quiet-button compact-button"; configure.textContent = engine ? "Configure" : "Set up"; configure.addEventListener("click", () => this.openEngineEditor(folder)); headingActions.append(configure);
    if (engine) {
      const addRecipe = document.createElement("button"); addRecipe.type = "button"; addRecipe.className = "quiet-button compact-button"; addRecipe.textContent = "Add recipe"; addRecipe.addEventListener("click", () => this.openRecipeEditor(undefined, { ...engine, rootPath: folder.rootPath })); headingActions.append(addRecipe);
    }
    heading.append(identity, headingActions); card.append(heading);
    if (engine && !playbookRecipes.length) card.append(emptyState("No recipes yet"));
    if (!engine) return card;
    for (const recipe of playbookRecipes) {
      const recipeCard = document.createElement("article"); recipeCard.className = "recipe-card";
      const recipeDetails = document.createElement("button"); recipeDetails.type = "button"; recipeDetails.className = "recipe-card-details"; recipeDetails.addEventListener("click", () => this.openRecipeEditor(recipe));
      const name = document.createElement("span"); name.className = "recipe-display-name"; name.textContent = recipe.displayName;
      const labels = document.createElement("div"); labels.className = "recipe-card-labels";
      const modelLabel = document.createElement("span"); modelLabel.className = "recipe-card-label"; modelLabel.textContent = recipe.modelId;
      const contextLabel = document.createElement("span"); contextLabel.className = "recipe-card-label recipe-context-label"; contextLabel.textContent = `${formatTokenCount(recipe.contextTokens)} ctx`;
      labels.append(modelLabel, contextLabel); recipeDetails.append(name, labels);
      const recipeActions = document.createElement("div"); recipeActions.className = "recipe-card-actions";
      const testButton = document.createElement("button"); testButton.type = "button"; testButton.className = "recipe-test-button"; testButton.setAttribute("aria-live", "polite"); testButton.addEventListener("click", (event) => { event.stopPropagation(); void this.testRecipe(recipe, recipeCard, testButton); });
      recipeActions.append(testButton); this.renderRecipeTestState(recipe.id, recipeCard, testButton);
      recipeCard.append(recipeDetails, recipeActions); card.append(recipeCard);
    }
    return card;
  }

  private showEditor(kind: "engine" | "recipe"): void {
    this.elements.browser.hidden = true;
    this.elements.editor.hidden = false;
    this.elements.engineForm.hidden = kind !== "engine";
    this.elements.recipeForm.hidden = kind !== "recipe";
    this.elements.page.scrollTop = 0;
  }

  private async saveEngine(): Promise<void> {
    const folderName = this.elements.engineFolder.value.trim();
    if (!folderName) return;
    setFormBusy(this.elements.engineForm, true);
    try {
      await this.options.api(`/api/v1/management/engines/${encodeURIComponent(folderName)}`, "PUT", {
        displayName: this.elements.engineDisplayName.value.trim(),
        connectionMode: this.elements.engineConnection.value.trim(),
        runtime: this.elements.engineRuntime.value.trim(),
        baseUrl: this.elements.engineBaseUrl.value.trim(),
        healthPath: this.elements.engineHealthPath.value.trim(),
        launchCommand: this.elements.engineCommand.value.trim(),
        launchArguments: this.elements.engineArguments.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        workingDirectory: this.elements.engineWorkingDirectory.value.trim(),
        wslDistribution: this.elements.engineWslDistribution.value.trim(),
      });
      this.closeEditor();
      await this.options.reloadConfiguration();
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.engineForm, false); }
  }

  private async saveRecipe(): Promise<void> {
    let configuration: Json;
    try { configuration = JSON.parse(this.elements.recipeConfiguration.value || "{}"); }
    catch { this.options.showToast("Configuration must be valid JSON"); return; }
    const id = this.elements.recipeId.value.trim(); if (!id) return;
    setFormBusy(this.elements.recipeForm, true);
    try {
      await this.options.api(`/api/v1/management/recipes/${encodeURIComponent(id)}`, "PUT", {
        playbookId: this.elements.recipePlaybookId.value.trim(), displayName: this.elements.recipeDisplayName.value.trim(), adapter: this.elements.recipeAdapter.value.trim(), modelId: this.elements.recipeModelId.value.trim(),
        contextTokens: Number(this.elements.recipeContextTokens.value.trim()), configuration,
        capabilities: this.editingRecipe?.capabilities ?? { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
        lifecycle: this.editingRecipe?.lifecycle ?? { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
      });
      this.closeEditor();
      await this.options.reloadConfiguration();
    } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
    finally { setFormBusy(this.elements.recipeForm, false); }
  }

  private applyEngineFolderChoice(): void {
    const folderName = this.elements.engineFolder.value;
    const folder = (this.configuration?.engineFolders ?? []).find((candidate: Json) => candidate.folderName === folderName);
    const engine = folder?.engine;
    this.elements.engineDisplayName.value = engine?.displayName ?? folderName;
    this.elements.engineConnection.value = engine?.connectionMode ?? "managed";
    this.elements.engineRuntime.value = engine?.runtime ?? "windows";
    this.elements.engineBaseUrl.value = engine?.baseUrl ?? "http://127.0.0.1:18080";
    this.elements.engineHealthPath.value = engine?.healthPath ?? "/v1/models";
    this.elements.engineCommand.value = engine?.launchCommand ?? "";
    this.elements.engineArguments.value = (engine?.launchArguments ?? []).join("\n");
    this.elements.engineWorkingDirectory.value = engine?.workingDirectory ?? ".";
    this.elements.engineWslDistribution.value = engine?.wslDistribution ?? "Ubuntu";
    const submit = this.elements.engineForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = !folder;
    this.updateEngineFieldVisibility();
  }

  private updateEngineFieldVisibility(): void {
    const managed = this.elements.engineConnection.value === "managed";
    this.elements.engineManagedFields.hidden = !managed;
    this.elements.engineRuntimeField.hidden = !managed;
    this.elements.engineBaseUrlField.hidden = managed;
    this.elements.engineWslField.hidden = !managed || this.elements.engineRuntime.value !== "wsl";
  }
}

function emptyState(message: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "panel-empty";
  element.textContent = message;
  return element;
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}

function formatTokenCount(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
}
