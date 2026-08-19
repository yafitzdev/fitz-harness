import type { Recipe } from "@fitz/protocol";
import type { EngineFolderSnapshot, ManagementConfiguration } from "../../management-configuration.js";
import { CollapsibleSection } from "../layout/collapsible-section.js";
import { recipeMetadata } from "../recipes/recipe-metadata.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import { RecipeConfigurationEditor } from "./recipe-configuration-editor.js";

type Json = Record<string, any>;

/** The typed management fields that the Playbooks page actually consumes. */
export type PlaybookConfiguration = Pick<ManagementConfiguration, "recipes" | "engineFolders" | "engineRoot" | "speculativeDrafters">;

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
  engineRuntimeId: HTMLInputElement;
  engineManagedFields: HTMLElement;
  engineRuntimeField: HTMLElement;
  engineBaseUrlField: HTMLElement;
  engineRuntimeIdField: HTMLElement;
  engineEditorTitle: HTMLElement;
  recipeForm: HTMLFormElement;
  recipePlaybookId: HTMLInputElement;
  recipeId: HTMLInputElement;
  recipeDisplayName: HTMLInputElement;
  recipeAdapter: HTMLInputElement;
  recipeModelId: HTMLInputElement;
  recipeContextTokens: HTMLInputElement;
  recipeConfiguration: HTMLElement;
  recipeEditorTitle: HTMLElement;
  recipeEditorEyebrow: HTMLElement;
  recipeEditorDescription: HTMLElement;
  recipeRename: HTMLButtonElement;
  recipeIdentityFields: HTMLElement;
}

export interface PlaybookWorkspaceOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  reloadConfiguration: () => Promise<PlaybookConfiguration | undefined>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  onRouteChange?: (path: string[] | undefined) => void;
}

export class PlaybookWorkspaceController {
  readonly elements: PlaybookWorkspaceElements;
  private readonly options: PlaybookWorkspaceOptions;
  private configuration: PlaybookConfiguration | undefined;
  private editingRecipe: Recipe | undefined;
  private originalRecipeDisplayName = "";
  private readonly configurationEditor: RecipeConfigurationEditor;

  constructor(elements: PlaybookWorkspaceElements, options: PlaybookWorkspaceOptions) {
    this.elements = elements;
    this.options = options;
    this.configurationEditor = new RecipeConfigurationEditor(elements.recipeConfiguration);
    this.bind();
  }

  get editorOpen(): boolean { return !this.elements.editor.hidden; }

  setConfiguration(configuration: PlaybookConfiguration | undefined): void {
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
    this.elements.description.textContent = "Configure recipes from your engine folders.";
    this.elements.search.placeholder = "Search playbooks";
    if (!configuration) { this.elements.list.append(emptyState("Management data is unavailable")); return; }
    const recipes = configuration.recipes ?? [];
    const folders = configuration.engineFolders ?? [];
    const query = this.elements.search.value.trim().toLowerCase();
    const matches = (...values: unknown[]) => !query || values.some((value) => String(value ?? "").toLowerCase().includes(query));
    const visibleFolders = folders.filter((folder) => {
      const engineRecipes = recipes.filter((recipe) => samePlaybook(recipe.playbookId, folder.folderName));
      return matches(folder.folderName, folder.rootPath, folder.engine?.displayName, ...engineRecipes.flatMap((recipe) => [recipe.displayName, recipe.modelId]));
    });
    if (!visibleFolders.length) { this.elements.list.append(emptyState(`No engine folders found in ${configuration.engineRoot ?? "the configured root"}`)); return; }
    for (const folder of visibleFolders) this.elements.list.append(this.renderFolderCard(folder, recipes));
  }

  openEngineEditor(folder?: EngineFolderSnapshot): void {
    this.elements.engineForm.reset();
    this.elements.engineFolder.replaceChildren();
    const folders = this.configuration?.engineFolders ?? [];
    for (const candidate of folders) {
      const option = document.createElement("option");
      option.value = candidate.folderName;
      option.textContent = candidate.folderName;
      this.elements.engineFolder.append(option);
    }
    const preferred = folder ?? folders.find((candidate) => !candidate.registered) ?? folders[0];
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
    this.options.onRouteChange?.(["engine", this.elements.engineFolder.value]);
    (preferred ? this.elements.engineDisplayName : this.elements.engineFolder).focus();
  }

  openRecipeEditor(recipe?: Recipe, playbook?: Json): void {
    this.editingRecipe = recipe;
    this.elements.recipeForm.reset();
    this.originalRecipeDisplayName = String(recipe?.displayName ?? "");
    this.elements.recipeEditorTitle.textContent = recipe?.displayName ?? "Create recipe";
    this.elements.recipeEditorTitle.hidden = !recipe;
    this.elements.recipeEditorEyebrow.textContent = recipe ? "Recipe" : "Create recipe";
    this.elements.recipeEditorDescription.textContent = recipe ? "" : "Name the model and provide the runtime information needed to create it.";
    this.elements.recipeEditorDescription.hidden = Boolean(recipe);
    this.elements.recipeRename.hidden = !recipe;
    this.elements.recipeIdentityFields.hidden = Boolean(recipe);
    const playbookIds = [...new Set((this.configuration?.recipes ?? []).map((item) => item.playbookId))];
    const playbookId = recipe?.playbookId ?? playbook?.id ?? (playbookIds.length === 1 ? playbookIds[0] : "");
    this.elements.recipePlaybookId.value = playbookId; this.elements.recipePlaybookId.readOnly = Boolean(playbookId);
    this.elements.recipeId.value = recipe?.id ?? ""; this.elements.recipeId.readOnly = Boolean(recipe);
    this.elements.recipeDisplayName.value = recipe?.displayName ?? "";
    this.elements.recipeDisplayName.hidden = Boolean(recipe);
    const adapter = recipe?.adapter ?? (playbook?.connectionMode === "managed" ? "openai-managed" : "openai-compatible");
    this.elements.recipeAdapter.value = adapter; this.elements.recipeAdapter.readOnly = true;
    this.elements.recipeModelId.value = recipe?.modelId ?? "";
    this.elements.recipeContextTokens.value = String(recipe?.contextTokens ?? 131_072);
    const defaultConfiguration = playbook?.connectionMode === "managed"
      ? { enginePath: playbook.runtime === "linux-managed" ? `/opt/fitz/llm/engines/${playbook.folderName}` : playbook.rootPath, runtime: playbook.runtime, command: playbook.launchCommand, args: playbook.launchArguments, workingDirectory: playbook.workingDirectory ?? ".", healthPath: playbook.healthPath, readinessTimeoutMs: 120_000, ...(playbook.runtimeId ? { runtimeId: playbook.runtimeId } : {}) }
      : playbook ? { baseUrl: playbook.baseUrl, healthPath: playbook.healthPath, allowInsecureRemote: false } : {};
    this.configurationEditor.load(adapter, recipe?.configuration ?? defaultConfiguration, recipe ?? {
      playbookId,
      adapter,
      contextTokens: Number(this.elements.recipeContextTokens.value),
      capabilities: { chatCompletions: true, toolCalls: false, maxConcurrentGenerations: 1 },
    }, { showRuntimeSettings: !recipe, speculativeDrafters: this.configuration?.speculativeDrafters ?? [] });
    this.showEditor("recipe");
    this.options.onRouteChange?.(["recipe", playbookId, ...(recipe?.id ? [String(recipe.id)] : [])]);
    (recipe ? this.elements.recipeRename : this.elements.recipeDisplayName).focus();
  }

  openRoute(path: readonly string[]): boolean {
    const [kind, playbookId, recipeId] = path;
    if (kind === "engine" && playbookId) {
      const folder = (this.configuration?.engineFolders ?? []).find((candidate) => candidate.folderName === playbookId);
      if (!folder) return false;
      this.openEngineEditor(folder);
      return true;
    }
    if (kind !== "recipe" || !playbookId) return false;
    const recipe = recipeId
      ? (this.configuration?.recipes ?? []).find((candidate) => candidate.id === recipeId)
      : undefined;
    if (recipeId && !recipe) return false;
    const folder = (this.configuration?.engineFolders ?? []).find((candidate) => samePlaybook(candidate.folderName, playbookId));
    if (!recipe && !folder?.engine) return false;
    this.openRecipeEditor(recipe, folder ? editorPlaybook(folder) : undefined);
    return true;
  }

  closeEditor(remember = true): void {
    const wasOpen = this.editorOpen;
    this.elements.editor.hidden = true;
    this.elements.browser.hidden = false;
    this.elements.engineForm.hidden = true;
    this.elements.recipeForm.hidden = true;
    if (wasOpen && remember) this.options.onRouteChange?.(undefined);
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.options.reloadConfiguration());
    this.elements.search.addEventListener("input", () => this.render());
    this.elements.engineForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveEngine(); });
    this.elements.recipeForm.addEventListener("submit", (event) => { event.preventDefault(); void this.saveRecipe(); });
    this.elements.recipeRename.addEventListener("click", () => this.beginRecipeRename());
    this.elements.recipeDisplayName.addEventListener("blur", () => { if (this.editingRecipe) this.commitRecipeRename(); });
    this.elements.recipeDisplayName.addEventListener("keydown", (event) => {
      if (!this.editingRecipe) return;
      if (event.key === "Enter") { event.preventDefault(); this.commitRecipeRename(); }
      if (event.key === "Escape") { event.preventDefault(); this.cancelRecipeRename(); }
    });
    this.elements.engineFolder.addEventListener("change", () => this.applyEngineFolderChoice());
    this.elements.engineConnection.addEventListener("change", () => this.updateEngineFieldVisibility());
    this.elements.engineRuntime.addEventListener("change", () => this.updateEngineFieldVisibility());
    for (const button of this.elements.closeEditorButtons) button.addEventListener("click", () => this.closeEditor());
  }

  private renderFolderCard(folder: EngineFolderSnapshot, recipes: Recipe[]): HTMLElement {
    const engine = folder.engine;
    const playbookId = folder.folderName;
    const playbookRecipes = recipes.filter((recipe) => samePlaybook(recipe.playbookId, playbookId));
    const actions: HTMLButtonElement[] = [];
    const configure = document.createElement("button");
    configure.type = "button";
    configure.className = "quiet-button compact-button";
    configure.textContent = engine ? "Configure" : "Set up";
    configure.addEventListener("click", () => this.openEngineEditor(folder));
    actions.push(configure);
    if (engine) {
      const addRecipe = document.createElement("button");
      addRecipe.type = "button";
      addRecipe.className = "quiet-button compact-button";
      addRecipe.textContent = "Add recipe";
      addRecipe.addEventListener("click", () => this.openRecipeEditor(undefined, editorPlaybook(folder)));
      actions.push(addRecipe);
    }
    const section = CollapsibleSection.create({
      id: playbookId,
      storageKey: "fitz-collapsed-playbooks",
      title: engine?.displayName ?? "Unconfigured engine",
      className: "playbook-card",
      actions,
      onToggle: () => this.render(),
    });
    if (!engine) section.root.title = `Engine folder: ${playbookId}`;
    if (!section.collapsed) {
      if (engine && !playbookRecipes.length) section.appendBody(emptyState("No recipes yet"));
      if (engine) for (const recipe of playbookRecipes) section.appendBody(this.renderRecipeCard(recipe));
    }
    return section.root;
  }

  private beginRecipeRename(): void {
    if (!this.editingRecipe) return;
    this.originalRecipeDisplayName = this.elements.recipeDisplayName.value.trim() || String(this.editingRecipe.displayName ?? "");
    this.elements.recipeEditorTitle.hidden = true;
    this.elements.recipeRename.hidden = true;
    this.elements.recipeDisplayName.hidden = false;
    this.elements.recipeDisplayName.focus();
    this.elements.recipeDisplayName.select();
  }

  private commitRecipeRename(): void {
    const name = this.elements.recipeDisplayName.value.trim();
    if (!name) {
      this.elements.recipeDisplayName.value = this.originalRecipeDisplayName;
      this.elements.recipeDisplayName.focus();
      return;
    }
    this.originalRecipeDisplayName = name;
    this.elements.recipeEditorTitle.textContent = name;
    this.elements.recipeEditorTitle.hidden = false;
    this.elements.recipeDisplayName.hidden = true;
    this.elements.recipeRename.hidden = false;
  }

  private cancelRecipeRename(): void {
    this.elements.recipeDisplayName.value = this.originalRecipeDisplayName;
    this.elements.recipeEditorTitle.textContent = this.originalRecipeDisplayName;
    this.elements.recipeEditorTitle.hidden = false;
    this.elements.recipeDisplayName.hidden = true;
    this.elements.recipeRename.hidden = false;
    this.elements.recipeRename.focus();
  }

  private renderRecipeCard(recipe: Recipe): HTMLElement {
    const recipeCard = document.createElement("article");
    recipeCard.className = "recipe-card";
    const recipeDetails = document.createElement("button");
    recipeDetails.type = "button";
    recipeDetails.className = "recipe-card-details";
    recipeDetails.addEventListener("click", () => this.openRecipeEditor(recipe));
    const name = document.createElement("span");
    name.className = "recipe-display-name";
    name.textContent = recipe.displayName;
    const labels = document.createElement("div");
    labels.className = "recipe-card-labels";
    labels.append(...recipeMetadata({
      modelId: String(recipe.modelId ?? recipe.id),
      contextTokens: Number(recipe.contextTokens),
      capabilities: recipe.capabilities,
      ...(recipe.speculativeDecoding ? { speculativeDecoding: recipe.speculativeDecoding } : {}),
    }));
    recipeDetails.append(name, labels);
    recipeCard.append(recipeDetails);
    return recipeCard;
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
        runtimeId: this.elements.engineRuntimeId.value.trim(),
      });
      this.closeEditor();
      await this.options.reloadConfiguration();
      this.options.showStatus("Engine configuration saved", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    finally { setFormBusy(this.elements.engineForm, false); }
  }

  private async saveRecipe(): Promise<void> {
    let configuration: Json;
    try { configuration = this.configurationEditor.value(); }
    catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); return; }
    const id = this.elements.recipeId.value.trim(); if (!id) return;
    setFormBusy(this.elements.recipeForm, true);
    try {
      const speculativeDecoding = this.configurationEditor.speculativeDecodingValue();
      await this.options.api(`/api/v1/management/recipes/${encodeURIComponent(id)}`, "PUT", {
        playbookId: this.elements.recipePlaybookId.value.trim(), displayName: this.elements.recipeDisplayName.value.trim(), adapter: this.elements.recipeAdapter.value.trim(), modelId: this.elements.recipeModelId.value.trim(),
        contextTokens: Number(this.elements.recipeContextTokens.value.trim()), configuration,
        capabilities: this.editingRecipe?.capabilities ?? { chatCompletions: true, streaming: true, toolCalls: false, responseFormat: false, minP: false, maxConcurrentGenerations: 1 },
        lifecycle: this.editingRecipe?.lifecycle ?? { loadPolicy: "onDemand", evictionPolicy: "idle-ttl", idleTtlSeconds: 600, minimumResidencySeconds: 0 },
        ...(speculativeDecoding !== undefined ? { speculativeDecoding } : {}),
      });
      this.closeEditor();
      await this.options.reloadConfiguration();
      this.options.showStatus("Recipe saved", "success");
    } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    finally { setFormBusy(this.elements.recipeForm, false); }
  }

  private applyEngineFolderChoice(): void {
    const folderName = this.elements.engineFolder.value;
    const folder = (this.configuration?.engineFolders ?? []).find((candidate) => candidate.folderName === folderName);
    const engine = folder?.engine;
    this.elements.engineDisplayName.value = engine?.displayName ?? folderName;
    this.elements.engineConnection.value = engine?.connectionMode ?? "managed";
    this.elements.engineRuntime.value = "linux-managed";
    this.elements.engineBaseUrl.value = engine?.baseUrl ?? "http://127.0.0.1:18080";
    this.elements.engineHealthPath.value = engine?.healthPath ?? "/v1/models";
    this.elements.engineCommand.value = engine?.launchCommand ?? "";
    this.elements.engineArguments.value = (engine?.launchArguments ?? []).join("\n");
    this.elements.engineWorkingDirectory.value = engine?.workingDirectory ?? ".";
    this.elements.engineRuntimeId.value = engine?.runtimeId ?? "inference-linux";
    const submit = this.elements.engineForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = !folder;
    this.updateEngineFieldVisibility();
  }

  private updateEngineFieldVisibility(): void {
    const managed = this.elements.engineConnection.value === "managed";
    this.elements.engineManagedFields.hidden = !managed;
    this.elements.engineRuntimeField.hidden = !managed;
    this.elements.engineBaseUrlField.hidden = managed;
    this.elements.engineRuntimeIdField.hidden = !managed || this.elements.engineRuntime.value !== "linux-managed";
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

function samePlaybook(left: unknown, right: unknown): boolean {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "accent" }) === 0;
}

function editorPlaybook(folder: EngineFolderSnapshot): Json {
  return { ...(folder.engine ?? {}), folderName: folder.folderName, rootPath: folder.rootPath };
}
