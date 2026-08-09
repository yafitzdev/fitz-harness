import type { ConsumerConnectionInput, ConsumerConnectionSummary } from "../../preload.js";
import { ManagementPageLayout, managementRefreshIcon } from "../layout/management-page.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import { CollapsibleSection } from "../layout/collapsible-section.js";
import { svgIcon } from "../primitives/dom.js";
import { recipeMetadata, type RecipeModality } from "../recipes/recipe-metadata.js";

type Json = Record<string, any>;
export type MediaModality = Exclude<RecipeModality, "text">;

const CONNECTION_EDITOR_TEMPLATE = `
  <div id="connection-editor" class="management-editor" hidden>
    <button id="connection-editor-back" class="management-back" type="button"><svg viewBox="0 0 20 20"><path d="m12.5 4-6 6 6 6"></path></svg>Connections</button>
    <form id="connection-form" class="management-editor-form">
      <input id="consumer-connection-id" type="hidden">
      <div class="editor-heading"><small>API connection</small><h1 id="connection-editor-title">New connection</h1><p>Connect a provider or a model server you host yourself. Models are discovered automatically.</p></div>
      <div class="configuration-grid">
        <label>Connection name<input id="consumer-connection-name" maxlength="100" required placeholder="Cohere"></label>
        <label>Template<select id="consumer-connection-template"><option value="openai-compatible">OpenAI-compatible</option><option value="openai-media">OpenAI media</option><option value="fal">Fal</option><option value="replicate">Replicate</option></select><small>Fal and Replicate fill in their base URL automatically.</small></label>
        <label id="consumer-connection-url-field" class="wide-field">OpenAI-compatible base URL<input id="consumer-connection-url" type="url" maxlength="2048" required placeholder="http://127.0.0.1:8000/v1"><small>Use a provider, local model server, or another Fitz host.</small></label>
        <label id="consumer-model-ids-field" class="wide-field" hidden>Model IDs<input id="consumer-model-ids" maxlength="4000" placeholder="fal-ai/minimax-video, fal-ai/flux/dev"><small>Optional: restrict discovery to these model IDs.</small></label>
        <label>Authorization<select id="consumer-connection-auth"><option value="bearer">Bearer token</option><option value="none">None</option></select></label>
        <label id="consumer-api-key-field" class="wide-field">API key<input id="consumer-connection-key" type="password" autocomplete="off" placeholder="Stored securely"></label>
      </div>
      <p id="connection-form-status" class="connection-form-status" hidden></p>
      <div class="editor-actions"><button id="cancel-connection-edit" class="quiet-button" type="button">Cancel</button><button class="primary-button" type="submit">Connect</button></div>
    </form>
  </div>
`;

export type FixedRouteId = "fast" | "default" | "smart";
export const LOCAL_CONNECTION_ID = "hosted--local";
export const FIXED_ROUTES: readonly { id: FixedRouteId; label: string; icon: string }[] = [
  { id: "fast", label: "Fast", icon: '<path class="route-icon-outline" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path><path class="route-icon-filled" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path>' },
  { id: "default", label: "Default", icon: '<g class="route-icon-outline"><circle cx="10" cy="10" r="6"></circle><circle cx="10" cy="10" r="1.6"></circle></g><path class="route-icon-filled" fill-rule="evenodd" d="M10 3.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Zm0 4a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"></path>' },
  { id: "smart", label: "Smart", icon: '<g class="route-icon-outline"><path d="M8.75 2.75A3.25 3.25 0 0 0 4.3 5.7 3.2 3.2 0 0 0 3 8.3a3.5 3.5 0 0 0 2.1 3.2V14a3.25 3.25 0 0 0 3.65 3.2M11.25 2.75a3.25 3.25 0 0 1 4.45 2.95A3.2 3.2 0 0 1 17 8.3a3.5 3.5 0 0 1-2.1 3.2V14a3.25 3.25 0 0 1-3.65 3.2M8.75 2.75V17.2M11.25 2.75V17.2M5.1 8h3.65M11.25 8h3.65M5.1 12h3.65M11.25 12h3.65"></path></g><g class="route-icon-filled"><path d="M8.8 2.35A3.65 3.65 0 0 0 4 5.55 3.55 3.55 0 0 0 2.65 8.3c0 1.6.8 3 2.15 3.85V14a3.75 3.75 0 0 0 4 3.65V2.35Zm2.4 0v15.3A3.75 3.75 0 0 0 15.2 14v-1.85a4.35 4.35 0 0 0 2.15-3.85A3.55 3.55 0 0 0 16 5.55a3.65 3.65 0 0 0-4.8-3.2Z"></path><path class="route-icon-cut" d="M8.8 6.35H6.6l-1.15-1M8.8 10H5.9l-1.15 1M8.8 13.65H6.7l-1 1M11.2 6.35h2.2l1.15-1M11.2 10h2.9l1.15 1M11.2 13.65h2.1l1 1"></path></g>' },
];

/** Well-known media routes (§5.2): single-assignment toggles per modality.
 *  A recipe is only assignable to a route whose kind matches one of its output
 *  modalities; incompatible toggles are disabled (§5.10). */
export const MEDIA_ROUTES: readonly { id: MediaModality; label: string; icon: string }[] = [
  { id: "image", label: "Image", icon: '<path d="M3.5 14.5 8 9l3 3 2.5-2.5 3.5 5z"></path><circle cx="14.4" cy="5.6" r="1.6"></circle>' },
  { id: "video", label: "Video", icon: '<rect x="3" y="5.5" width="14" height="9" rx="2"></rect><path d="m9.5 8 3.5 2-3.5 2z"></path>' },
  { id: "audio", label: "Audio", icon: '<path d="M3.5 8v4h2.8L10 14.6V5.4L6.3 8z"></path><path d="M13.8 8.2a3.2 3.2 0 0 1 0 3.6"></path>' },
];

export const CONSUMER_TEMPLATES: readonly { id: string; label: string; description: string }[] = [
  { id: "openai-compatible", label: "OpenAI-compatible", description: "Chat models over any OpenAI-compatible endpoint." },
  { id: "openai-media", label: "OpenAI media", description: "An OpenAI-compatible endpoint that also serves image, video, or audio models." },
  { id: "fal", label: "Fal", description: "Fal.ai media models; the base URL is filled in automatically." },
  { id: "replicate", label: "Replicate", description: "Replicate media models; the base URL is filled in automatically." },
];

type ConnectionModelView = ConsumerConnectionSummary["models"][number] & { displayName?: string; modelId?: string; contextTokens?: number };
/** One media model card: a media recipe plus the well-known route toggles it can serve. */
interface MediaModelView {
  recipeId: string;
  displayName: string;
  modelId: string;
  /** Output modalities the recipe can generate — one well-known route toggle each. */
  modalities: MediaModality[];
  limits?: { maxDurationSeconds?: number; maxResolution?: string; maxRefs?: number; maxFrames?: number };
  experimental?: boolean;
  template: string;
}
type HostedConnectionView = Omit<ConsumerConnectionSummary, "models" | "mediaModels"> & { hosted: true; availableModels: ConnectionModelView[]; availableMediaModels: MediaModelView[] };
type SavedConnectionView = Omit<ConsumerConnectionSummary, "models" | "mediaModels"> & { hosted: false; availableModels: ConnectionModelView[]; availableMediaModels: MediaModelView[]; source: ConsumerConnectionSummary };
type ConnectionView = HostedConnectionView | SavedConnectionView;

export interface ConnectionWorkspaceBridge {
  listConsumerConnections(): Promise<ConsumerConnectionSummary[]>;
  saveConsumerConnection(input: ConsumerConnectionInput): Promise<ConsumerConnectionSummary>;
  removeConsumerConnection(id: string): Promise<void>;
  syncConsumerConnections(): Promise<Array<{ id: string; connected: boolean; error?: string }>>;
}

export interface ConnectionWorkspaceElements {
  form: HTMLFormElement;
  id: HTMLInputElement;
  name: HTMLInputElement;
  url: HTMLInputElement;
  urlField: HTMLElement;
  template: HTMLSelectElement;
  modelIds: HTMLInputElement;
  modelIdsField: HTMLElement;
  auth: HTMLSelectElement;
  apiKey: HTMLInputElement;
  apiKeyField: HTMLElement;
  formStatus: HTMLElement;
  connections: HTMLElement;
  listView: HTMLElement;
  editor: HTMLElement;
  editorTitle: HTMLElement;
  search: HTMLInputElement;
  refresh: HTMLButtonElement;
  newConnection: HTMLButtonElement;
  editorBack: HTMLButtonElement;
  cancelEdit: HTMLButtonElement;
  experimentalToggle: HTMLInputElement;
}

export interface ConnectionWorkspaceOptions {
  mount: HTMLElement;
  bridge: ConnectionWorkspaceBridge;
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  reloadConfiguration: () => Promise<Json | undefined>;
  testRecipe: (recipe: Json, card: HTMLElement, button: HTMLButtonElement) => Promise<void>;
  renderRecipeTestState: (recipeId: string, card: HTMLElement, button: HTMLButtonElement) => void;
  closePopovers: () => void;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
}

export class ConnectionWorkspaceController {
  readonly root: HTMLElement;
  readonly elements: ConnectionWorkspaceElements;
  private readonly options: ConnectionWorkspaceOptions;
  private records: ConsumerConnectionSummary[] = [];
  private configuration: Json | undefined;

  constructor(options: ConnectionWorkspaceOptions) {
    this.options = options;
    this.root = document.createElement("section");
    this.root.className = "management-page connections-page";
    this.root.setAttribute("aria-label", "API connections");
    this.root.hidden = true;
    options.mount.append(this.root);
    const layout = new ManagementPageLayout(this.root, {
      actions: [
        { id: "new-connection", label: "New connection", className: "quiet-button compact-button" },
        { id: "refresh-connections", icon: managementRefreshIcon, label: "Refresh connections" },
      ],
    });
    const connectionsList = document.createElement("div");
    connectionsList.id = "consumer-connections";
    connectionsList.className = "playbook-list";
    const experimentalFilter = document.createElement("label");
    experimentalFilter.className = "experimental-filter";
    experimentalFilter.innerHTML = `<input id="show-experimental-media" type="checkbox"><span>Show experimental media models</span>`;
    layout.addContent({
      id: "connection-list-view",
      title: "Connections",
      description: "Provider and self-hosted OpenAI-compatible APIs.",
      search: { id: "connection-search", placeholder: "Search connections" },
      body: [experimentalFilter, connectionsList],
    });
    this.root.insertAdjacentHTML("beforeend", CONNECTION_EDITOR_TEMPLATE);
    this.elements = {
      form: this.require("connection-form"),
      id: this.require("consumer-connection-id"),
      name: this.require("consumer-connection-name"),
      url: this.require("consumer-connection-url"),
      urlField: this.require("consumer-connection-url-field"),
      template: this.require("consumer-connection-template"),
      modelIds: this.require("consumer-model-ids"),
      modelIdsField: this.require("consumer-model-ids-field"),
      auth: this.require("consumer-connection-auth"),
      apiKey: this.require("consumer-connection-key"),
      apiKeyField: this.require("consumer-api-key-field"),
      formStatus: this.require("connection-form-status"),
      connections: this.require("consumer-connections"),
      listView: this.require("connection-list-view"),
      editor: this.require("connection-editor"),
      editorTitle: this.require("connection-editor-title"),
      search: this.require("connection-search"),
      refresh: this.require("refresh-connections"),
      newConnection: this.require("new-connection"),
      editorBack: this.require("connection-editor-back"),
      cancelEdit: this.require("cancel-connection-edit"),
      experimentalToggle: this.require("show-experimental-media"),
    };
    this.bind();
    this.resetForm();
  }

  private require<T extends HTMLElement>(id: string): T {
    const value = this.root.querySelector<T>(`#${id}`);
    if (!value) throw new Error(`Connection workspace is missing #${id}`);
    return value;
  }

  get editorOpen(): boolean { return !this.elements.editor.hidden; }

  setConfiguration(configuration: Json | undefined): void {
    this.configuration = configuration;
  }

  routeIdFor(routeId: FixedRouteId): string {
    return routeId;
  }

  async sync(reportFailure: boolean): Promise<void> {
    const results = await this.options.bridge.syncConsumerConnections();
    this.records = await this.options.bridge.listConsumerConnections();
    this.configuration = await this.options.reloadConfiguration();
    this.render();
    const failed = results.filter((item) => !item.connected);
    if (reportFailure && failed.length) this.options.showStatus(failed[0]?.error ?? "Connection failed", "error");
  }

  render(): void {
    this.elements.connections.replaceChildren();
    const connectionRecords = this.views();
    const query = this.elements.search.value.trim().toLowerCase();
    const visible = connectionRecords.filter((connection) => !query || [connection.displayName, ...connection.availableModels.flatMap((model) => [model.id, model.displayName, model.modelId]), ...connection.availableMediaModels.flatMap((model) => [model.modelId, model.displayName])].some((value) => String(value ?? "").toLowerCase().includes(query)));
    if (!visible.length) {
      this.elements.connections.append(emptyState(query ? "No matching connections" : "No APIs connected yet", query ? "panel-empty" : "connections-empty"));
      return;
    }
    const routes = this.configuration?.routes ?? [];
    const showExperimental = this.elements.experimentalToggle.checked;
    for (const connection of visible) {
      const mediaModels = showExperimental ? connection.availableMediaModels : connection.availableMediaModels.filter((model) => !model.experimental);
      this.elements.connections.append(this.connectionCard(connection, routes, mediaModels));
    }
  }

  private openEditor(connection?: ConsumerConnectionSummary): void {
    this.resetForm();
    this.elements.listView.hidden = true;
    this.elements.editor.hidden = false;
    this.elements.editorTitle.textContent = connection ? "Configure connection" : "New connection";
    if (connection) {
      this.elements.id.value = connection.id;
      this.elements.name.value = connection.displayName;
      this.elements.template.value = connection.template ?? "openai-compatible";
      this.elements.url.value = connection.baseUrl;
      this.elements.modelIds.value = [...new Set((connection.mediaModels ?? []).map((model) => model.id))].join(", ");
      this.elements.auth.value = connection.authType;
      this.elements.apiKey.placeholder = connection.hasCredential ? "Leave blank to keep current key" : "API key";
    }
    this.updateTemplateFields();
    this.updateAuthField();
    this.elements.name.focus();
  }

  closeEditor(): void {
    this.resetForm();
    this.elements.editor.hidden = true;
    this.elements.listView.hidden = false;
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.sync(true));
    this.elements.newConnection.addEventListener("click", () => this.openEditor());
    this.elements.editorBack.addEventListener("click", () => this.closeEditor());
    this.elements.cancelEdit.addEventListener("click", () => this.closeEditor());
    this.elements.search.addEventListener("input", () => this.render());
    this.elements.auth.addEventListener("change", () => this.updateAuthField());
    this.elements.template.addEventListener("change", () => this.updateTemplateFields());
    this.elements.experimentalToggle.addEventListener("change", () => this.render());
    this.elements.form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
  }

  private views(): ConnectionView[] {
    const recipes = this.configuration?.recipes ?? [];
    const hostedModels = recipes
      .filter((recipe: Json) => !String(recipe.id).startsWith("consumer-recipe--") && recipe.capabilities?.chatCompletions !== false)
      .map((recipe: Json): ConnectionModelView => ({ id: String(recipe.id), routeId: "", recipeId: String(recipe.id), displayName: String(recipe.displayName ?? recipe.modelId ?? recipe.id), modelId: String(recipe.modelId ?? recipe.id), contextTokens: Number(recipe.contextTokens) }));
    const hostedMediaModels = hostedMediaViews(recipes);
    const hostedConnection: HostedConnectionView = { id: LOCAL_CONNECTION_ID, displayName: String(this.configuration?.hostName ?? "This PC"), baseUrl: "", authType: "none", hasCredential: false, template: "openai-compatible", availableModels: hostedModels, availableMediaModels: hostedMediaModels, updatedAt: "", hosted: true };
    return [hostedConnection, ...this.records.map((connection): SavedConnectionView => ({ ...connection, hosted: false, availableModels: connection.models.map((model) => ({ ...model })), availableMediaModels: savedMediaViews(connection), source: connection }))];
  }

  private connectionCard(connection: ConnectionView, routes: Json[], mediaModels: MediaModelView[]): HTMLElement {
    const actions: HTMLButtonElement[] = [];
    if (!connection.hosted) {
      actions.push(
        actionButton("Refresh", (button) => this.testConnection(connection.source, button)),
        actionButton("Edit", () => { this.openEditor(connection.source); }),
        this.removeButton(connection.id),
      );
    }
    const section = CollapsibleSection.create({
      id: connection.id,
      storageKey: "fitz-collapsed-connections",
      title: connection.displayName,
      className: "consumer-playbook-card",
      onToggle: () => this.render(),
      actions,
    });
    if (!section.collapsed) {
      if (!connection.availableModels.length && !mediaModels.length) section.appendBody(emptyState("No models available"));
      for (const model of connection.availableModels) section.appendBody(this.modelCard(model, routes));
      if (mediaModels.length) {
        for (const model of mediaModels) section.appendBody(this.mediaModelCard(model, routes));
      }
    }
    return section.root;
  }

  private modelCard(model: ConnectionModelView, routes: Json[]): HTMLElement {
    const card = document.createElement("article");
    card.className = "recipe-card";
    const details = document.createElement("div");
    details.className = "recipe-card-details";
    const name = document.createElement("span");
    name.className = "recipe-display-name";
    name.textContent = model.displayName ?? model.id;
    const labels = document.createElement("div");
    labels.className = "recipe-card-labels";
    labels.append(...recipeMetadata({
      modelId: model.modelId ?? "API model",
      ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
      capabilities: { chatCompletions: true },
    }));
    details.append(name, labels);
    const actions = document.createElement("div");
    actions.className = "recipe-card-actions";
    const test = document.createElement("button");
    test.type = "button";
    test.className = "recipe-test-button";
    test.setAttribute("aria-live", "polite");
    test.addEventListener("click", () => void this.options.testRecipe({ id: model.recipeId, displayName: model.id }, card, test));
    const routeToggle = document.createElement("div");
    routeToggle.className = "recipe-route-toggle";
    routeToggle.setAttribute("role", "group");
    routeToggle.setAttribute("aria-label", `${model.id} routing`);
    for (const definition of FIXED_ROUTES) {
      const routeId = definition.id;
      const route = routes.find((item: Json) => item.id === routeId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `route-symbol route-${definition.id}`;
      button.title = definition.label;
      button.setAttribute("aria-label", `${definition.label} route`);
      button.setAttribute("aria-pressed", String(route?.recipeId === model.recipeId));
      button.classList.toggle("active", route?.recipeId === model.recipeId);
      button.append(svgIcon(definition.icon));
      button.addEventListener("click", () => void this.assignRoute(definition, model, button));
      routeToggle.append(button);
    }
    actions.append(routeToggle, test);
    this.options.renderRecipeTestState(model.recipeId, card, test);
    card.append(details, actions);
    return card;
  }

  private mediaModelCard(model: MediaModelView, routes: Json[]): HTMLElement {
    const card = document.createElement("article");
    card.className = "recipe-card media-recipe-card";
    if (model.experimental) card.classList.add("experimental");
    const details = document.createElement("div");
    details.className = "recipe-card-details";
    const name = document.createElement("span");
    name.className = "recipe-display-name";
    name.textContent = model.displayName;
    const labels = document.createElement("div");
    labels.className = "recipe-card-labels";
    labels.append(...recipeMetadata({
      modelId: model.modelId,
      capabilities: { chatCompletions: false, modalities: { output: model.modalities, ...(model.limits ? { limits: model.limits } : {}) } },
      ...(model.experimental ? { experimental: true } : {}),
    }));
    details.append(name, labels);
    const actions = document.createElement("div");
    actions.className = "recipe-card-actions";
    const test = document.createElement("button");
    test.type = "button";
    test.className = "recipe-test-button";
    test.setAttribute("aria-live", "polite");
    test.addEventListener("click", () => void this.options.testRecipe({
      id: model.recipeId,
      displayName: model.modelId,
      capabilities: { chatCompletions: false, modalities: { output: model.modalities } },
    }, card, test));
    const routeToggle = document.createElement("div");
    routeToggle.className = "recipe-route-toggle media-route-toggle";
    routeToggle.setAttribute("role", "group");
    routeToggle.setAttribute("aria-label", `${model.modelId} media routing`);
    for (const definition of MEDIA_ROUTES) {
      const route = routes.find((item: Json) => item.id === definition.id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `route-symbol route-media route-${definition.id}`;
      button.title = definition.label;
      button.setAttribute("aria-label", `${definition.label} route`);
      button.setAttribute("aria-pressed", String(route?.recipeId === model.recipeId));
      button.classList.toggle("active", route?.recipeId === model.recipeId);
      button.append(svgIcon(definition.icon));
      if (!model.modalities.includes(definition.id)) {
        button.disabled = true;
        button.title = `${model.modelId} does not generate ${definition.label.toLowerCase()}`;
      }
      button.addEventListener("click", () => void this.assignMediaRoute(definition, model, button));
      routeToggle.append(button);
    }
    actions.append(routeToggle, test);
    this.options.renderRecipeTestState(model.recipeId, card, test);
    card.append(details, actions);
    return card;
  }

  private async save(): Promise<void> {
    setFormBusy(this.elements.form, true);
    this.setFormStatus("Connecting…");
    try {
      const template = this.elements.template.value as "openai-compatible" | "openai-media" | "fal" | "replicate";
      const hidesUrl = template === "fal" || template === "replicate";
      await this.options.bridge.saveConsumerConnection({
        ...(this.elements.id.value ? { id: this.elements.id.value } : {}),
        displayName: this.elements.name.value.trim(),
        ...(hidesUrl ? {} : { baseUrl: this.elements.url.value.trim() }),
        template,
        authType: this.elements.auth.value as "none" | "bearer",
        ...(this.elements.apiKey.value.trim() ? { apiKey: this.elements.apiKey.value.trim() } : {}),
        ...(template !== "openai-compatible" && this.elements.modelIds.value.trim()
          ? { modelIds: this.elements.modelIds.value.split(",").map((item) => item.trim()).filter(Boolean) }
          : {}),
      });
      this.closeEditor();
      await this.refreshRecordsAndConfiguration();
    } catch (error) { this.setFormStatus(this.options.errorMessage(error), true); }
    finally { setFormBusy(this.elements.form, false); }
  }

  private async testConnection(connection: ConsumerConnectionSummary, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    button.textContent = "Refreshing…";
    try {
      const template = connection.template ?? "openai-compatible";
      const hidesUrl = template === "fal" || template === "replicate";
      await this.options.bridge.saveConsumerConnection({
        id: connection.id,
        displayName: connection.displayName,
        ...(hidesUrl ? {} : { baseUrl: connection.baseUrl }),
        template,
        authType: connection.authType,
        ...((connection.mediaModels?.length ?? 0) > 0 ? { modelIds: [...new Set(connection.mediaModels.map((model) => model.id))] } : {}),
      });
      await this.refreshRecordsAndConfiguration();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Failed";
      button.title = this.options.errorMessage(error);
    }
  }

  private removeButton(id: string): HTMLButtonElement {
    const button = actionButton("Remove", async () => {
      if (button.dataset.confirm !== "true") {
        button.dataset.confirm = "true";
        button.textContent = "Confirm";
        return;
      }
      try {
        await this.options.bridge.removeConsumerConnection(id);
        await this.refreshRecordsAndConfiguration();
      } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    });
    button.classList.add("danger");
    return button;
  }

  private async refreshRecordsAndConfiguration(): Promise<void> {
    this.records = await this.options.bridge.listConsumerConnections();
    this.configuration = await this.options.reloadConfiguration();
    this.render();
  }

  private async assignRoute(definition: (typeof FIXED_ROUTES)[number], model: ConnectionModelView, button: HTMLButtonElement): Promise<void> {
    const routeId = definition.id;
    const current = this.configuration?.routes?.find((route: Json) => route.id === routeId);
    if (current?.recipeId === model.recipeId) return;
    button.disabled = true;
    try {
      await this.options.api(`/api/v1/management/routes/${routeId}`, "PUT", {
        displayName: definition.label,
        description: definition.id === "fast" ? "Lowest-latency route" : definition.id === "smart" ? "Highest-capability route" : "Primary route",
        recipeId: model.recipeId,
        enabled: true,
        isDefault: definition.id === "default",
      });
      this.configuration = await this.options.reloadConfiguration();
      this.render();
    } catch (error) {
      button.disabled = false;
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  private async assignMediaRoute(definition: (typeof MEDIA_ROUTES)[number], model: MediaModelView, button: HTMLButtonElement): Promise<void> {
    const routeId = definition.id;
    const current = this.configuration?.routes?.find((route: Json) => route.id === routeId);
    if (current?.recipeId === model.recipeId) return;
    button.disabled = true;
    try {
      await this.options.api(`/api/v1/management/routes/${routeId}`, "PUT", {
        displayName: definition.label,
        recipeId: model.recipeId,
        enabled: true,
        ...(model.experimental ? { acceptExperimental: true } : {}),
      });
      this.configuration = await this.options.reloadConfiguration();
      this.render();
    } catch (error) {
      button.disabled = false;
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  private resetForm(): void {
    this.elements.form.reset();
    this.elements.id.value = "";
    this.elements.template.value = "openai-compatible";
    this.elements.auth.value = "bearer";
    this.elements.apiKey.placeholder = "Stored securely";
    this.setFormStatus();
    this.updateTemplateFields();
    this.updateAuthField();
  }

  private updateTemplateFields(): void {
    const template = this.elements.template.value;
    const hidesUrl = template === "fal" || template === "replicate";
    this.elements.urlField.hidden = hidesUrl;
    this.elements.url.required = !hidesUrl;
    this.elements.modelIdsField.hidden = template === "openai-compatible";
  }

  private updateAuthField(): void {
    this.elements.apiKeyField.hidden = this.elements.auth.value === "none";
    this.elements.apiKey.required = this.elements.auth.value === "bearer" && !this.elements.id.value;
  }

  private setFormStatus(message?: string, error = false): void {
    this.elements.formStatus.hidden = !message;
    this.elements.formStatus.textContent = message ?? "";
    this.elements.formStatus.classList.toggle("error", error);
  }
}

export function consumerFixedRouteId(connectionId: string, id: FixedRouteId): string {
  return `consumer--${connectionId}--route--${id}`;
}

function actionButton(label: string, action: (button: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet-button compact-button";
  button.textContent = label;
  button.addEventListener("click", () => void action(button));
  return button;
}

function emptyState(message: string, className = "panel-empty"): HTMLElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = message;
  return element;
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}

/** Media recipes hosted on this PC (playbook/engine recipes, §5.10): one card
 *  per recipe with all of its output modalities as route toggles. */
function hostedMediaViews(recipes: Json[]): MediaModelView[] {
  return recipes
    .filter((recipe: Json) => !String(recipe.id).startsWith("consumer-recipe--") && recipe.capabilities?.chatCompletions === false && Array.isArray(recipe.capabilities?.modalities?.output) && recipe.capabilities.modalities.output.length)
    .map((recipe: Json): MediaModelView => ({
      recipeId: String(recipe.id),
      displayName: String(recipe.displayName ?? recipe.modelId ?? recipe.id),
      modelId: String(recipe.modelId ?? recipe.id),
      modalities: recipe.capabilities.modalities.output.filter((modality: unknown) => modality === "image" || modality === "video" || modality === "audio"),
      ...(recipe.capabilities?.modalities?.limits ? { limits: recipe.capabilities.modalities.limits } : {}),
      ...(recipe.configuration?.experimental === true ? { experimental: true } : {}),
      template: String(recipe.adapter ?? "openai-compatible"),
    }));
}

/** Media models from a saved connection: the host registers one entry per
 *  (model, modality) but the UI shows one card per model (recipe). */
function savedMediaViews(connection: ConsumerConnectionSummary): MediaModelView[] {
  const byRecipe = new Map<string, MediaModelView>();
  for (const model of connection.mediaModels ?? []) {
    const view = byRecipe.get(model.recipeId) ?? {
      recipeId: model.recipeId,
      displayName: model.id,
      modelId: model.id,
      modalities: [],
      template: model.template,
    };
    if (!view.modalities.includes(model.modality)) view.modalities.push(model.modality);
    byRecipe.set(model.recipeId, view);
  }
  return [...byRecipe.values()];
}
