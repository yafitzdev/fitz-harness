import type { ConsumerConnectionInput, ConsumerConnectionSummary } from "../../preload.js";
import { ManagementPageLayout, managementRefreshIcon } from "../layout/management-page.js";
import type { ActionFeedback } from "../primitives/action-status.js";
import { CollapsibleSection } from "../layout/collapsible-section.js";
import { svgIcon } from "../primitives/dom.js";
import {
  CLOUD_TEXT_ROUTE_DEFINITIONS,
  TEXT_ROUTE_DEFINITIONS,
  type CloudTextRouteId,
  type TextRouteDefinition,
  type TextRouteId,
} from "../routes/text-route-presentation.js";
import {
  buildConnectionViews,
  connectionMatches,
  localRecipes,
  LOCAL_CONNECTION_ID,
  type ConnectionModelView,
  type ConnectionView,
  type Json,
  type MediaModelView,
  type MediaModality,
} from "./connection-workspace-model.js";

export { LOCAL_CONNECTION_ID } from "./connection-workspace-model.js";
export type { MediaModality } from "./connection-workspace-model.js";

const CONNECTION_EDITOR_TEMPLATE = `
  <div id="connection-editor" class="management-editor" hidden>
    <button id="connection-editor-back" class="management-back" type="button"><svg viewBox="0 0 20 20"><path d="m12.5 4-6 6 6 6"></path></svg>Inference</button>
    <form id="connection-form" class="management-editor-form">
      <input id="consumer-connection-id" type="hidden">
      <div class="editor-heading connection-editor-heading">
        <div id="connection-editor-title-row" class="connection-editor-title-row" hidden><h1 id="connection-editor-title"></h1><button id="connection-editor-rename" class="icon-button" type="button" title="Rename connection" aria-label="Rename connection"><svg viewBox="0 0 20 20"><path d="m13.8 3.2 3 3L7.2 15.8 3 17l1.2-4.2z"></path></svg></button></div>
        <input id="consumer-connection-name" class="connection-name-input" maxlength="100" required placeholder="Connection name" aria-label="Connection name">
      </div>
      <div class="configuration-grid">
        <label id="consumer-connection-url-field" class="wide-field">URL<input id="consumer-connection-url" type="url" maxlength="2048" required placeholder="http://127.0.0.1:8000/v1"></label>
        <label id="consumer-api-key-field" class="wide-field">API key<input id="consumer-connection-key" type="password" autocomplete="off" placeholder="Stored securely"></label>
        <label>Template<select id="consumer-connection-template"><option value="openai-compatible">OpenAI-compatible</option><option value="openai-media">OpenAI media</option><option value="fal">Fal</option><option value="replicate">Replicate</option></select></label>
        <label>Execution<select id="consumer-connection-execution"><option value="metered_cloud">Metered cloud</option><option value="self_hosted">Self-hosted</option></select></label>
        <label id="consumer-model-ids-field" class="wide-field" hidden>Model IDs<input id="consumer-model-ids" maxlength="4000" placeholder="fal-ai/minimax-video, fal-ai/flux/dev"></label>
      </div>
      <p id="connection-form-status" class="connection-form-status" hidden></p>
      <div class="editor-actions"><button id="cancel-connection-edit" class="quiet-button" type="button">Cancel</button><button class="primary-button" type="submit">Connect</button></div>
    </form>
  </div>
`;

export type FixedRouteId = TextRouteId;
export type CloudRouteId = CloudTextRouteId;
type RouteDefinition<T extends string> = { id: T; label: string; icon: string };
const EDIT_ICON = '<path d="m13.8 3.2 3 3L7.2 15.8 3 17l1.2-4.2z"></path>';
const SAVE_ICON = '<path d="m4 10.5 3.5 3.5L16 5.5"></path>';
const CANCEL_ICON = '<path d="m5 5 10 10M15 5 5 15"></path>';
const MODEL_ICON = '<path d="M10 2.5 17 6v8l-7 3.5L3 14V6z"></path><path d="M3 6l7 3.5L17 6M10 9.5V17.5"></path>';
const ROUTE_ICONS: Record<FixedRouteId, string> = {
  default: '<g class="route-icon-outline"><circle cx="10" cy="10" r="6"></circle><circle cx="10" cy="10" r="1.6"></circle></g><path class="route-icon-filled" fill-rule="evenodd" d="M10 3.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Zm0 4a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"></path>',
  fast: '<path class="route-icon-outline" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path><path class="route-icon-filled" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path>',
  smart: '<g class="route-icon-outline"><path d="M8.75 2.75A3.25 3.25 0 0 0 4.3 5.7 3.2 3.2 0 0 0 3 8.3a3.5 3.5 0 0 0 2.1 3.2V14a3.25 3.25 0 0 0 3.65 3.2M11.25 2.75a3.25 3.25 0 0 1 4.45 2.95A3.2 3.2 0 0 1 17 8.3a3.5 3.5 0 0 1-2.1 3.2V14a3.25 3.25 0 0 1-3.65 3.2M8.75 2.75V17.2M11.25 2.75V17.2M5.1 8h3.65M11.25 8h3.65M5.1 12h3.65M11.25 12h3.65"></path></g><g class="route-icon-filled"><path d="M8.8 2.35A3.65 3.65 0 0 0 4 5.55 3.55 3.55 0 0 0 2.65 8.3c0 1.6.8 3 2.15 3.85V14a3.75 3.75 0 0 0 4 3.65V2.35Zm2.4 0v15.3A3.75 3.75 0 0 0 15.2 14v-1.85a4.35 4.35 0 0 0 2.15-3.85A3.55 3.55 0 0 0 16 5.55a3.65 3.65 0 0 0-4.8-3.2Z"></path><path class="route-icon-cut" d="M8.8 6.35H6.6l-1.15-1M8.8 10H5.9l-1.15 1M8.8 13.65H6.7l-1 1M11.2 6.35h2.2l1.15-1M11.2 10h2.9l1.15 1M11.2 13.65h2.1l1 1"></path></g>',
};

function withRouteIcon<T extends FixedRouteId>(definition: TextRouteDefinition<T>): RouteDefinition<T> {
  return { id: definition.id, label: definition.label, icon: ROUTE_ICONS[definition.id] };
}

export const FIXED_ROUTES: readonly RouteDefinition<FixedRouteId>[] = TEXT_ROUTE_DEFINITIONS.map(withRouteIcon);
const DEFAULT_ROUTE = withRouteIcon(TEXT_ROUTE_DEFINITIONS.find((route): route is TextRouteDefinition<"default"> => route.id === "default")!);
const LOCAL_ROUTES: readonly RouteDefinition<"default">[] = [DEFAULT_ROUTE];
export const CLOUD_ROUTES: readonly RouteDefinition<CloudRouteId>[] = CLOUD_TEXT_ROUTE_DEFINITIONS.map(withRouteIcon);

/** Well-known media routes (§5.2): single-assignment toggles per modality.
 *  A recipe is only assignable to a route whose kind matches one of its output
 *  modalities; incompatible toggles are disabled (§5.10). */
export const MEDIA_ROUTES: readonly { id: MediaModality; label: string; icon: string }[] = [
  { id: "image", label: "Image", icon: '<g class="route-icon-outline"><path d="M3.5 14.5 8 9l3 3 2.5-2.5 3.5 5z"></path><circle cx="14.4" cy="5.6" r="1.6"></circle></g><path class="route-icon-filled" fill-rule="evenodd" d="M4.5 3.25h11a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-11a2.25 2.25 0 0 1-2.25-2.25v-9A2.25 2.25 0 0 1 4.5 3.25Zm9.8 2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM4 14.6h12l-3.25-4.05-2.15 2.2-2.65-3.1L4 14.6Z"></path>' },
  { id: "video", label: "Video", icon: '<g class="route-icon-outline"><rect x="3" y="5.5" width="14" height="9" rx="2"></rect><path d="m9.5 8 3.5 2-3.5 2z"></path></g><g class="route-icon-filled"><rect x="2.5" y="5" width="15" height="10" rx="2.5"></rect><path class="route-icon-negative" d="m8.75 7.8 4 2.2-4 2.2z"></path></g>' },
  { id: "audio", label: "Audio", icon: '<g class="route-icon-outline"><path d="M3.5 8v4h2.8L10 14.6V5.4L6.3 8z"></path><path d="M13.8 8.2a3.2 3.2 0 0 1 0 3.6"></path></g><g class="route-icon-filled"><path d="M3 7.5v5h3l4.75 3.15V4.35L6 7.5z"></path><path class="route-icon-wave" d="M13.1 7.5a3.6 3.6 0 0 1 0 5M15.25 5.65a6.2 6.2 0 0 1 0 8.7"></path></g>' },
];

export const CONSUMER_TEMPLATES: readonly { id: string; label: string; description: string }[] = [
  { id: "openai-compatible", label: "OpenAI-compatible", description: "Chat models over any OpenAI-compatible endpoint." },
  { id: "openai-media", label: "OpenAI media", description: "An OpenAI-compatible endpoint that also serves image, video, or audio models." },
  { id: "fal", label: "Fal", description: "Fal.ai media models; the base URL is filled in automatically." },
  { id: "replicate", label: "Replicate", description: "Replicate media models; the base URL is filled in automatically." },
];

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
  execution: HTMLSelectElement;
  modelIds: HTMLInputElement;
  modelIdsField: HTMLElement;
  apiKey: HTMLInputElement;
  apiKeyField: HTMLElement;
  formStatus: HTMLElement;
  connections: HTMLElement;
  listView: HTMLElement;
  editor: HTMLElement;
  editorTitle: HTMLElement;
  editorTitleRow: HTMLElement;
  editorRename: HTMLButtonElement;
  search: HTMLInputElement;
  refresh: HTMLButtonElement;
  newConnection: HTMLButtonElement;
  editorBack: HTMLButtonElement;
  cancelEdit: HTMLButtonElement;
}

export interface ConnectionWorkspaceOptions {
  mount: HTMLElement;
  bridge: ConnectionWorkspaceBridge;
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  reloadConfiguration: () => Promise<Json | undefined>;
  updateRouteConfiguration: (routeId: string, route: Json | undefined) => void;
  updateCloudRouteConfiguration: (role: CloudRouteId, recipeId: string | undefined) => void;
  closePopovers: () => void;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  onRouteChange?: (path: string[] | undefined) => void;
}

export class ConnectionWorkspaceController {
  readonly root: HTMLElement;
  readonly elements: ConnectionWorkspaceElements;
  private readonly options: ConnectionWorkspaceOptions;
  private readonly layout: ManagementPageLayout;
  private records: ConsumerConnectionSummary[] = [];
  private configuration: Json | undefined;
  private refreshGeneration = 0;
  private readonly routeAssignmentGeneration = new Map<string, number>();
  private inferenceScope: "cloud" | "local" = "cloud";
  private editingLocalRecipeId: string | undefined;
  private localNameDraft = "";

  constructor(options: ConnectionWorkspaceOptions) {
    this.options = options;
    this.root = document.createElement("section");
    this.root.className = "management-page connections-page inference-page";
    this.root.setAttribute("aria-label", "Inference");
    this.root.hidden = true;
    options.mount.append(this.root);
    this.layout = new ManagementPageLayout(this.root, {
      tabs: [
        { id: "inference-cloud-tab", label: "Cloud", active: true },
        { id: "inference-local-tab", label: "Local" },
      ],
      actions: [
        { id: "new-connection", label: "Connect cloud API", className: "quiet-button compact-button" },
        { id: "refresh-connections", icon: managementRefreshIcon, label: "Refresh inference" },
      ],
    });
    const connectionsList = document.createElement("div");
    connectionsList.id = "consumer-connections";
    connectionsList.className = "playbook-list";
    this.layout.addContent({
      id: "connection-list-view",
      title: "Cloud",
      description: "Provider APIs and remote model servers.",
      search: { id: "connection-search", placeholder: "Search models and providers" },
      body: [connectionsList],
    });
    this.root.insertAdjacentHTML("beforeend", CONNECTION_EDITOR_TEMPLATE);
    this.elements = {
      form: this.require("connection-form"),
      id: this.require("consumer-connection-id"),
      name: this.require("consumer-connection-name"),
      url: this.require("consumer-connection-url"),
      urlField: this.require("consumer-connection-url-field"),
      template: this.require("consumer-connection-template"),
      execution: this.require("consumer-connection-execution"),
      modelIds: this.require("consumer-model-ids"),
      modelIdsField: this.require("consumer-model-ids-field"),
      apiKey: this.require("consumer-connection-key"),
      apiKeyField: this.require("consumer-api-key-field"),
      formStatus: this.require("connection-form-status"),
      connections: this.require("consumer-connections"),
      listView: this.require("connection-list-view"),
      editor: this.require("connection-editor"),
      editorTitle: this.require("connection-editor-title"),
      editorTitleRow: this.require("connection-editor-title-row"),
      editorRename: this.require("connection-editor-rename"),
      search: this.require("connection-search"),
      refresh: this.require("refresh-connections"),
      newConnection: this.require("new-connection"),
      editorBack: this.require("connection-editor-back"),
      cancelEdit: this.require("cancel-connection-edit"),
    };
    this.layout.onTabSelect((id) => this.selectInferenceScope(id === "inference-local-tab" ? "local" : "cloud"));
    this.bind();
    this.resetForm();
    this.selectInferenceScope("cloud", false);
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
    const generation = ++this.refreshGeneration;
    let results: Array<{ id: string; connected: boolean; error?: string }>;
    try {
      results = await this.options.bridge.syncConsumerConnections();
      if (!await this.refreshSnapshot(generation)) return;
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      throw error;
    }
    const failed = results.filter((item) => !item.connected);
    if (reportFailure && failed.length) this.options.showStatus(failed[0]?.error ?? "Connection failed", "error");
  }

  render(): void {
    this.elements.connections.replaceChildren();
    const connectionRecords = buildConnectionViews(this.configuration, this.records)
      .filter((connection) => connection.hosted === (this.inferenceScope === "local"));
    const query = this.elements.search.value.trim().toLowerCase();
    const visible = connectionRecords.filter((connection) => connectionMatches(connection, query));
    if (!visible.length) {
      const empty = this.inferenceScope === "cloud" ? "No cloud APIs connected yet" : "No local engines available";
      this.elements.connections.append(emptyState(query ? "No matching models or providers" : empty, query ? "panel-empty" : "connections-empty"));
      return;
    }
    const routes = this.configuration?.routes ?? [];
    for (const connection of visible) this.elements.connections.append(this.connectionCard(connection, routes));
  }

  private openEditor(connection?: ConsumerConnectionSummary): void {
    this.selectInferenceScope("cloud");
    this.resetForm();
    this.elements.listView.hidden = true;
    this.elements.editor.hidden = false;
    this.elements.editorTitle.textContent = connection?.displayName ?? "";
    this.elements.editorTitleRow.hidden = !connection;
    this.elements.name.hidden = Boolean(connection);
    if (connection) {
      this.elements.id.value = connection.id;
      this.elements.name.value = connection.displayName;
      this.elements.template.value = connection.template ?? "openai-compatible";
      this.elements.execution.value = connection.executionClass;
      this.elements.url.value = connection.baseUrl;
      this.elements.modelIds.value = [...new Set((connection.mediaModels ?? []).map((model) => model.id))].join(", ");
      this.elements.apiKey.placeholder = connection.hasCredential ? "Leave blank to keep current key" : "API key";
      this.elements.apiKey.required = !connection.hasCredential;
    }
    this.updateTemplateFields();
    this.options.onRouteChange?.(connection ? ["edit", connection.id] : ["new"]);
    if (connection) this.elements.url.focus();
    else this.elements.name.focus();
  }

  openRoute(path: readonly string[]): boolean {
    const [kind, connectionId] = path;
    if (kind === "new") {
      this.openEditor();
      return true;
    }
    if (kind !== "edit" || !connectionId) return false;
    const connection = this.records.find((candidate) => candidate.id === connectionId);
    if (!connection) return false;
    this.openEditor(connection);
    return true;
  }

  closeEditor(remember = true): void {
    const wasOpen = this.editorOpen;
    this.resetForm();
    this.elements.editor.hidden = true;
    this.elements.listView.hidden = false;
    if (wasOpen && remember) this.options.onRouteChange?.(undefined);
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.sync(true));
    this.elements.newConnection.addEventListener("click", () => this.openEditor());
    this.elements.editorBack.addEventListener("click", () => this.closeEditor());
    this.elements.cancelEdit.addEventListener("click", () => this.closeEditor());
    this.elements.editorRename.addEventListener("click", () => {
      this.elements.editorTitleRow.hidden = true;
      this.elements.name.hidden = false;
      this.elements.name.focus();
      this.elements.name.select();
    });
    this.elements.search.addEventListener("input", () => this.render());
    this.elements.template.addEventListener("change", () => this.updateTemplateFields());
    this.elements.form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
  }

  private selectInferenceScope(scope: "cloud" | "local", render = true): void {
    if (scope !== this.inferenceScope) {
      if (this.editorOpen) this.closeEditor();
      if (this.editingLocalRecipeId) this.cancelLocalModelEditing(false);
    }
    this.inferenceScope = scope;
    this.layout.setActiveTab(scope === "cloud" ? "inference-cloud-tab" : "inference-local-tab");
    this.elements.newConnection.hidden = scope === "local";
    const description = this.elements.listView.querySelector<HTMLElement>(":scope > p");
    if (description) description.textContent = scope === "cloud"
      ? "Provider APIs and remote model servers."
      : "Models running on this machine, grouped by engine.";
    if (render) this.render();
  }

  private connectionCard(connection: ConnectionView, routes: Json[]): HTMLElement {
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
    section.body.classList.add("inference-model-grid");
    if (!section.collapsed) {
      if (!connection.availableModels.length && !connection.availableMediaModels.length) section.appendBody(emptyState("No models available"));
      for (const model of connection.availableModels) section.appendBody(this.modelCard(model, routes, connection.hosted));
      if (connection.availableMediaModels.length) {
        for (const model of connection.availableMediaModels) section.appendBody(this.mediaModelCard(model, routes, connection.hosted));
      }
    }
    return section.root;
  }

  private modelCard(model: ConnectionModelView, routes: Json[], hosted: boolean): HTMLElement {
    const card = document.createElement("article");
    card.className = "recipe-card inference-model-card";
    const icon = modelRowIcon();
    const copy = document.createElement("div");
    copy.className = "inference-model-copy";
    const name = this.modelName(model.recipeId, model.displayName ?? model.id, hosted);
    const meta = document.createElement("span");
    meta.className = "inference-model-meta";
    meta.textContent = model.modelId ?? "API model";
    copy.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "recipe-card-actions";
    const routeToggle = document.createElement("div");
    routeToggle.className = "recipe-route-toggle";
    routeToggle.setAttribute("role", "group");
    routeToggle.setAttribute("aria-label", `${model.id} routing`);
    const definitions = hosted ? LOCAL_ROUTES : CLOUD_ROUTES;
    for (const definition of definitions) {
      const routeId = definition.id;
      const route = routes.find((item: Json) => item.id === routeId);
      const active = hosted
        ? route?.recipeId === model.recipeId
        : this.configuration?.cloudRoutes?.[routeId] === model.recipeId;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `route-symbol route-${definition.id}`;
      button.title = definition.label;
      button.setAttribute("aria-label", `${definition.label} route`);
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("active", active);
      button.append(svgIcon(definition.icon));
      if (hosted && this.configuration?.isAdministrator !== true) button.disabled = true;
      button.addEventListener("click", () => void (definition.id === "default"
        ? this.assignDefaultRoute(definition, model)
        : this.assignCloudRoute(definition, model)));
      routeToggle.append(button);
    }
    actions.append(routeToggle);
    card.append(icon, copy, actions);
    return card;
  }

  private mediaModelCard(model: MediaModelView, routes: Json[], hosted: boolean): HTMLElement {
    const card = document.createElement("article");
    card.className = "recipe-card inference-model-card media-recipe-card";
    const icon = modelRowIcon();
    const copy = document.createElement("div");
    copy.className = "inference-model-copy";
    const name = this.modelName(model.recipeId, model.displayName, hosted);
    const meta = document.createElement("span");
    meta.className = "inference-model-meta";
    meta.textContent = model.modelId;
    copy.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "recipe-card-actions";
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
      if (this.configuration?.isAdministrator !== true) button.disabled = true;
      button.addEventListener("click", () => void this.assignMediaRoute(definition, model));
      routeToggle.append(button);
    }
    actions.append(routeToggle);
    card.append(icon, copy, actions);
    return card;
  }

  private modelName(recipeId: string, displayName: string, hosted: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "local-model-name-row";
    if (hosted && this.editingLocalRecipeId === recipeId) {
      const input = document.createElement("input");
      input.className = "local-model-name-input";
      input.maxLength = 100;
      input.required = true;
      input.value = this.localNameDraft;
      input.dataset.recipeId = recipeId;
      input.setAttribute("aria-label", `Name for ${displayName}`);
      input.addEventListener("input", () => { this.localNameDraft = input.value; });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.saveLocalModelName(recipeId);
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.cancelLocalModelEditing();
        }
      });
      row.append(
        input,
        iconAction("Save model name", SAVE_ICON, () => void this.saveLocalModelName(recipeId)),
        iconAction("Cancel rename", CANCEL_ICON, () => this.cancelLocalModelEditing()),
      );
      return row;
    }
    const name = document.createElement("span");
    name.className = "recipe-display-name";
    name.textContent = displayName;
    row.append(name);
    if (hosted) row.append(iconAction("Rename model", EDIT_ICON, () => this.beginLocalModelEdit(recipeId, displayName)));
    return row;
  }

  private beginLocalModelEdit(recipeId: string, displayName: string): void {
    if (this.inferenceScope !== "local") return;
    this.editingLocalRecipeId = recipeId;
    this.localNameDraft = displayName;
    this.render();
    const input = [...this.elements.connections.querySelectorAll<HTMLInputElement>(".local-model-name-input")]
      .find((candidate) => candidate.dataset.recipeId === recipeId);
    input?.focus();
    input?.select();
  }

  private cancelLocalModelEditing(render = true): void {
    this.editingLocalRecipeId = undefined;
    this.localNameDraft = "";
    if (render) this.render();
  }

  private async saveLocalModelName(recipeId: string): Promise<void> {
    const recipe = localRecipes(this.configuration).find((candidate) => String(candidate.id) === recipeId);
    if (!recipe || this.editingLocalRecipeId !== recipeId) return;
    const displayName = this.localNameDraft.trim();
    if (!displayName) {
      this.options.showStatus("Model names cannot be empty", "error");
      return;
    }
    if (displayName === String(recipe.displayName ?? recipe.modelId ?? recipe.id)) {
      this.cancelLocalModelEditing();
      return;
    }
    const row = [...this.elements.connections.querySelectorAll<HTMLInputElement>(".local-model-name-input")]
      .find((candidate) => candidate.dataset.recipeId === recipeId)?.parentElement;
    for (const control of row?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button") ?? []) control.disabled = true;
    try {
      await this.options.api(
        `/api/v1/management/recipes/${encodeURIComponent(String(recipe.id))}`,
        "PUT",
        { ...recipe, displayName },
      );
      this.editingLocalRecipeId = undefined;
      this.localNameDraft = "";
      await this.refreshRecordsAndConfiguration();
      this.options.showStatus("Model name updated", "success");
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
    } finally {
      for (const control of row?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button") ?? []) control.disabled = false;
    }
  }

  private async save(): Promise<void> {
    setFormBusy(this.elements.form, true);
    this.setFormStatus("Connecting…");
    try {
      const updating = Boolean(this.elements.id.value);
      const template = this.elements.template.value as "openai-compatible" | "openai-media" | "fal" | "replicate";
      const hidesUrl = template === "fal" || template === "replicate";
      await this.options.bridge.saveConsumerConnection({
        ...(this.elements.id.value ? { id: this.elements.id.value } : {}),
        displayName: this.elements.name.value.trim(),
        ...(hidesUrl ? {} : { baseUrl: this.elements.url.value.trim() }),
        template,
        executionClass: this.elements.execution.value as "self_hosted" | "metered_cloud",
        authType: "bearer",
        ...(this.elements.apiKey.value.trim() ? { apiKey: this.elements.apiKey.value.trim() } : {}),
        ...(template !== "openai-compatible" && this.elements.modelIds.value.trim()
          ? { modelIds: this.elements.modelIds.value.split(",").map((item) => item.trim()).filter(Boolean) }
          : {}),
      });
      this.closeEditor();
      await this.refreshRecordsAndConfiguration();
      this.options.showStatus(updating ? "Connection updated" : "Connection added", "success");
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
        executionClass: connection.executionClass,
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
        this.options.showStatus("Connection removed", "success");
      } catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
    });
    button.classList.add("danger");
    return button;
  }

  private async refreshRecordsAndConfiguration(): Promise<void> {
    const generation = ++this.refreshGeneration;
    await this.refreshSnapshot(generation);
  }

  private async refreshSnapshot(generation: number): Promise<boolean> {
    try {
      const records = await this.options.bridge.listConsumerConnections();
      const configuration = await this.options.reloadConfiguration();
      if (generation !== this.refreshGeneration) return false;
      this.records = records;
      this.configuration = configuration;
      this.render();
      return true;
    } catch (error) {
      if (generation !== this.refreshGeneration) return false;
      throw error;
    }
  }

  private async assignDefaultRoute(definition: RouteDefinition<"default">, model: ConnectionModelView): Promise<void> {
    const routeId = definition.id;
    const current = this.configuration?.routes?.find((route: Json) => route.id === routeId);
    if (current?.recipeId === model.recipeId) return;
    const route: Json = {
      ...(current ?? {}),
      id: routeId,
      displayName: definition.label,
      description: "Pinned local model",
      recipeId: model.recipeId,
      enabled: true,
      isDefault: true,
    };
    const generation = (this.routeAssignmentGeneration.get(routeId) ?? 0) + 1;
    this.routeAssignmentGeneration.set(routeId, generation);
    this.applyRoute(routeId, route);
    this.options.updateRouteConfiguration(routeId, route);
    this.render();
    try {
      const response = await this.options.api(`/api/v1/management/routes/${routeId}`, "PUT", route);
      if (this.routeAssignmentGeneration.get(routeId) !== generation) return;
      const saved = response.data ?? route;
      this.applyRoute(routeId, saved);
      this.options.updateRouteConfiguration(routeId, saved);
    } catch (error) {
      if (this.routeAssignmentGeneration.get(routeId) !== generation) return;
      this.applyRoute(routeId, current);
      this.options.updateRouteConfiguration(routeId, current);
      this.render();
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  private async assignCloudRoute(definition: RouteDefinition<CloudRouteId>, model: ConnectionModelView): Promise<void> {
    const role = definition.id;
    const previous = this.configuration?.cloudRoutes?.[role] as string | undefined;
    const next = previous === model.recipeId ? undefined : model.recipeId;
    const generation = (this.routeAssignmentGeneration.get(role) ?? 0) + 1;
    this.routeAssignmentGeneration.set(role, generation);
    this.applyCloudRoute(role, next);
    this.options.updateCloudRouteConfiguration(role, next);
    this.render();
    try {
      if (next) await this.options.api(`/api/v1/cloud-routes/${role}`, "PUT", { recipeId: next });
      else await this.options.api(`/api/v1/cloud-routes/${role}`, "DELETE");
      if (this.routeAssignmentGeneration.get(role) !== generation) return;
    } catch (error) {
      if (this.routeAssignmentGeneration.get(role) !== generation) return;
      this.applyCloudRoute(role, previous);
      this.options.updateCloudRouteConfiguration(role, previous);
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
    this.render();
  }

  private async assignMediaRoute(definition: (typeof MEDIA_ROUTES)[number], model: MediaModelView): Promise<void> {
    const routeId = definition.id;
    const current = this.configuration?.routes?.find((route: Json) => route.id === routeId);
    const selected = current?.recipeId === model.recipeId && current?.enabled !== false;
    const route: Json = selected
      ? { ...(current ?? {}), id: routeId, displayName: definition.label, recipeId: "", enabled: false }
      : { ...(current ?? {}), id: routeId, displayName: definition.label, recipeId: model.recipeId, enabled: true };
    const generation = (this.routeAssignmentGeneration.get(routeId) ?? 0) + 1;
    this.routeAssignmentGeneration.set(routeId, generation);
    this.applyRoute(routeId, route);
    this.options.updateRouteConfiguration(routeId, route);
    this.render();
    try {
      const response = await this.options.api(`/api/v1/management/routes/${routeId}`, "PUT", route);
      if (this.routeAssignmentGeneration.get(routeId) !== generation) return;
      const saved = response.data ?? route;
      this.applyRoute(routeId, saved);
      this.options.updateRouteConfiguration(routeId, saved);
    } catch (error) {
      if (this.routeAssignmentGeneration.get(routeId) !== generation) return;
      this.applyRoute(routeId, current);
      this.options.updateRouteConfiguration(routeId, current);
      this.render();
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  private applyRoute(routeId: string, route: Json | undefined): void {
    const routes = (this.configuration?.routes ?? []).filter((item: Json) => item.id !== routeId);
    if (route) routes.push(route);
    this.configuration = { ...(this.configuration ?? {}), routes };
  }

  private applyCloudRoute(role: CloudRouteId, recipeId: string | undefined): void {
    this.configuration = {
      ...(this.configuration ?? {}),
      cloudRoutes: { ...(this.configuration?.cloudRoutes ?? {}), [role]: recipeId },
    };
  }

  private resetForm(): void {
    this.elements.form.reset();
    this.elements.id.value = "";
    this.elements.template.value = "openai-compatible";
    this.elements.execution.value = "metered_cloud";
    this.elements.editorTitle.textContent = "";
    this.elements.editorTitleRow.hidden = true;
    this.elements.name.hidden = false;
    this.elements.apiKey.placeholder = "Stored securely";
    this.elements.apiKey.required = true;
    this.setFormStatus();
    this.updateTemplateFields();
  }

  private updateTemplateFields(): void {
    const template = this.elements.template.value;
    const hidesUrl = template === "fal" || template === "replicate";
    const mediaProvider = template !== "openai-compatible";
    this.elements.urlField.hidden = hidesUrl;
    this.elements.url.required = !hidesUrl;
    this.elements.modelIdsField.hidden = template === "openai-compatible";
    if (mediaProvider) this.elements.execution.value = "metered_cloud";
    this.elements.execution.disabled = mediaProvider;
  }

  private setFormStatus(message?: string, error = false): void {
    this.elements.formStatus.hidden = !message;
    this.elements.formStatus.textContent = message ?? "";
    this.elements.formStatus.classList.toggle("error", error);
  }
}

function actionButton(label: string, action: (button: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet-button compact-button";
  button.textContent = label;
  button.addEventListener("click", () => void action(button));
  return button;
}

function iconAction(label: string, icon: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button local-model-name-action";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(svgIcon(icon));
  button.addEventListener("click", action);
  return button;
}

function emptyState(message: string, className = "panel-empty"): HTMLElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = message;
  return element;
}

function modelRowIcon(): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "inference-model-icon";
  icon.append(svgIcon(MODEL_ICON));
  return icon;
}

function setFormBusy(form: HTMLFormElement, busy: boolean): void {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input,button,select")) control.disabled = busy;
}
