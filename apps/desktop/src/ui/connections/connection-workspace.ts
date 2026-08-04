import type { ConsumerConnectionInput, ConsumerConnectionSummary } from "../../preload.js";
import { svgIcon } from "../primitives/dom.js";

type Json = Record<string, any>;

export type FixedRouteId = "fast" | "default" | "smart";
export const LOCAL_CONNECTION_ID = "hosted--local";
export const FIXED_ROUTES: readonly { id: FixedRouteId; label: string; icon: string }[] = [
  { id: "fast", label: "Fast", icon: '<path class="route-icon-outline" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path><path class="route-icon-filled" d="m11 2.25-6.25 8.6h4.8l-.55 6.9 6.25-8.6h-4.8z"></path>' },
  { id: "default", label: "Default", icon: '<g class="route-icon-outline"><circle cx="10" cy="10" r="6"></circle><circle cx="10" cy="10" r="1.6"></circle></g><path class="route-icon-filled" fill-rule="evenodd" d="M10 3.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5Zm0 4a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z"></path>' },
  { id: "smart", label: "Smart", icon: '<g class="route-icon-outline"><path d="M8.75 2.75A3.25 3.25 0 0 0 4.3 5.7 3.2 3.2 0 0 0 3 8.3a3.5 3.5 0 0 0 2.1 3.2V14a3.25 3.25 0 0 0 3.65 3.2M11.25 2.75a3.25 3.25 0 0 1 4.45 2.95A3.2 3.2 0 0 1 17 8.3a3.5 3.5 0 0 1-2.1 3.2V14a3.25 3.25 0 0 1-3.65 3.2M8.75 2.75V17.2M11.25 2.75V17.2M5.1 8h3.65M11.25 8h3.65M5.1 12h3.65M11.25 12h3.65"></path></g><g class="route-icon-filled"><path d="M8.8 2.35A3.65 3.65 0 0 0 4 5.55 3.55 3.55 0 0 0 2.65 8.3c0 1.6.8 3 2.15 3.85V14a3.75 3.75 0 0 0 4 3.65V2.35Zm2.4 0v15.3A3.75 3.75 0 0 0 15.2 14v-1.85a4.35 4.35 0 0 0 2.15-3.85A3.55 3.55 0 0 0 16 5.55a3.65 3.65 0 0 0-4.8-3.2Z"></path><path class="route-icon-cut" d="M8.8 6.35H6.6l-1.15-1M8.8 10H5.9l-1.15 1M8.8 13.65H6.7l-1 1M11.2 6.35h2.2l1.15-1M11.2 10h2.9l1.15 1M11.2 13.65h2.1l1 1"></path></g>' },
];

type ConnectionModelView = ConsumerConnectionSummary["models"][number] & { displayName?: string; modelId?: string; contextTokens?: number };
type HostedConnectionView = Omit<ConsumerConnectionSummary, "models"> & { hosted: true; availableModels: ConnectionModelView[] };
type SavedConnectionView = Omit<ConsumerConnectionSummary, "models"> & { hosted: false; availableModels: ConnectionModelView[]; source: ConsumerConnectionSummary };
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
}

export interface ConnectionWorkspaceOptions {
  bridge: ConnectionWorkspaceBridge;
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  reloadConfiguration: () => Promise<Json | undefined>;
  testRecipe: (recipe: Json, card: HTMLElement, button: HTMLButtonElement) => Promise<void>;
  renderRecipeTestState: (recipeId: string, card: HTMLElement, button: HTMLButtonElement) => void;
  closePopovers: () => void;
  showToast: (message: string) => void;
  errorMessage: (error: unknown) => string;
}

export class ConnectionWorkspaceController {
  readonly elements: ConnectionWorkspaceElements;
  private readonly options: ConnectionWorkspaceOptions;
  private records: ConsumerConnectionSummary[] = [];
  private configuration: Json | undefined;

  constructor(elements: ConnectionWorkspaceElements, options: ConnectionWorkspaceOptions) {
    this.elements = elements;
    this.options = options;
    this.bind();
    this.resetForm();
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
    if (reportFailure && failed.length) this.options.showToast(failed[0]?.error ?? "Connection failed");
  }

  render(): void {
    this.elements.connections.replaceChildren();
    const connectionRecords = this.views();
    const query = this.elements.search.value.trim().toLowerCase();
    const visible = connectionRecords.filter((connection) => !query || [connection.displayName, ...connection.availableModels.flatMap((model) => [model.id, model.displayName, model.modelId])].some((value) => String(value ?? "").toLowerCase().includes(query)));
    if (!visible.length) {
      this.elements.connections.append(emptyState(query ? "No matching connections" : "No APIs connected yet", query ? "panel-empty" : "connections-empty"));
      return;
    }
    const routes = this.configuration?.routes ?? [];
    for (const connection of visible) this.elements.connections.append(this.connectionCard(connection, routes));
  }

  openEditor(connection?: ConsumerConnectionSummary): void {
    this.resetForm();
    this.elements.listView.hidden = true;
    this.elements.editor.hidden = false;
    this.elements.editorTitle.textContent = connection ? "Configure connection" : "New connection";
    if (connection) {
      this.elements.id.value = connection.id;
      this.elements.name.value = connection.displayName;
      this.elements.url.value = connection.baseUrl;
      this.elements.auth.value = connection.authType;
      this.elements.apiKey.placeholder = connection.hasCredential ? "Leave blank to keep current key" : "API key";
    }
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
    this.elements.form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
  }

  private views(): ConnectionView[] {
    const recipes = this.configuration?.recipes ?? [];
    const hostedModels = recipes
      .filter((recipe: Json) => !String(recipe.id).startsWith("consumer-recipe--") && recipe.capabilities?.chatCompletions !== false)
      .map((recipe: Json): ConnectionModelView => ({ id: String(recipe.id), routeId: "", recipeId: String(recipe.id), displayName: String(recipe.displayName ?? recipe.modelId ?? recipe.id), modelId: String(recipe.modelId ?? recipe.id), contextTokens: Number(recipe.contextTokens) }));
    const hostedConnection: HostedConnectionView = { id: LOCAL_CONNECTION_ID, displayName: String(this.configuration?.hostName ?? "This PC"), baseUrl: "", authType: "none", hasCredential: false, availableModels: hostedModels, updatedAt: "", hosted: true };
    return [hostedConnection, ...this.records.map((connection): SavedConnectionView => ({ ...connection, hosted: false, availableModels: connection.models.map((model) => ({ ...model })), source: connection }))];
  }

  private connectionCard(connection: ConnectionView, routes: Json[]): HTMLElement {
    const card = document.createElement("section");
    card.className = "playbook-card consumer-playbook-card";
    const heading = document.createElement("div");
    heading.className = "playbook-heading";
    const identity = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = connection.displayName;
    identity.append(name);
    const actions = document.createElement("div");
    actions.className = "playbook-actions";
    if (!connection.hosted) {
      actions.append(
        actionButton("Refresh", (button) => this.testConnection(connection.source, button)),
        actionButton("Edit", () => { this.openEditor(connection.source); }),
        this.removeButton(connection.id),
      );
    }
    heading.append(identity, actions);
    card.append(heading);
    if (!connection.availableModels.length) card.append(emptyState("No chat models available"));
    for (const model of connection.availableModels) card.append(this.modelCard(model, routes));
    return card;
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
    const modelLabel = document.createElement("span");
    modelLabel.className = "recipe-card-label";
    modelLabel.textContent = model.modelId ?? "API model";
    labels.append(modelLabel);
    if (model.contextTokens) {
      const contextLabel = document.createElement("span");
      contextLabel.className = "recipe-card-label recipe-context-label";
      contextLabel.textContent = `${formatTokenCount(model.contextTokens)} ctx`;
      labels.append(contextLabel);
    }
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

  private async save(): Promise<void> {
    setFormBusy(this.elements.form, true);
    this.setFormStatus("Connecting…");
    try {
      await this.options.bridge.saveConsumerConnection({
        ...(this.elements.id.value ? { id: this.elements.id.value } : {}),
        displayName: this.elements.name.value.trim(),
        baseUrl: this.elements.url.value.trim(),
        authType: this.elements.auth.value as "none" | "bearer",
        ...(this.elements.apiKey.value.trim() ? { apiKey: this.elements.apiKey.value.trim() } : {}),
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
      await this.options.bridge.saveConsumerConnection({ id: connection.id, displayName: connection.displayName, baseUrl: connection.baseUrl, authType: connection.authType });
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
      } catch (error) { this.options.showToast(this.options.errorMessage(error)); }
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
      this.options.showToast(this.options.errorMessage(error));
    }
  }

  private resetForm(): void {
    this.elements.form.reset();
    this.elements.id.value = "";
    this.elements.auth.value = "bearer";
    this.elements.apiKey.placeholder = "Stored securely";
    this.setFormStatus();
    this.updateAuthField();
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

function formatTokenCount(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
}
