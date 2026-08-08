import { positionNestedPopover, togglePopover } from "../primitives/popover.js";

export type AccessMode = "full" | "ask" | "read-only";
export type ComposerSetting = "model" | "effort";

export interface ComposerRouteOption {
  id: string;
  label: string;
  /** Short route name (e.g. "Smart"); the full label may append the model name. */
  displayName?: string;
  group?: string;
}

export interface ComposerControlsElements {
  model: HTMLSelectElement;
  effort: HTMLSelectElement;
  modelToggle: HTMLButtonElement;
  modelMenu: HTMLElement;
  modelSummary: HTMLElement;
  modelRoute: HTMLElement;
  modelName: HTMLElement;
  modelEffort: HTMLElement;
  modelValue: HTMLElement;
  effortValue: HTMLElement;
  settingsSubmenu: HTMLElement;
  settingRows: HTMLButtonElement[];
  advancedSettings: HTMLButtonElement;
  advancedSettingsPanel: HTMLElement;
  temperature: HTMLInputElement;
  temperatureValue: HTMLElement;
  contextMeter: HTMLButtonElement;
  contextUsagePopover: HTMLElement;
  contextPercent: HTMLElement;
  contextTokens: HTMLElement;
  contextCompactButton: HTMLButtonElement;
  contextCompactStatus: HTMLElement;
  accessModeToggle: HTMLButtonElement;
  accessModeMenu: HTMLElement;
  accessModeLabel: HTMLElement;
  accessModeIcon: SVGElement;
  accessModeChoices: HTMLButtonElement[];
}

export interface ComposerControlsOptions {
  closeAllPopovers: () => void;
  onRouteChange: (routeId: string) => void;
  onCompact: () => void | Promise<void>;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export interface ComposerControlState {
  running: boolean;
  hasSession: boolean;
}

const ACCESS_MODES: Record<AccessMode, { label: string; icon: string }> = {
  full: { label: "Full access", icon: '<path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M10 7v3.2M10 13h.01"></path>' },
  ask: { label: "Ask first", icon: '<path d="M10 2.8 16 5v4.4c0 3.8-2.4 6.3-6 7.8-3.6-1.5-6-4-6-7.8V5z"></path><path d="M8.4 8.1a1.8 1.8 0 1 1 2.5 1.7c-.8.4-.9.8-.9 1.3M10 13.7h.01"></path>' },
  "read-only": { label: "Read only", icon: '<rect x="4.2" y="8.5" width="11.6" height="8" rx="2"></rect><path d="M6.8 8.5V6.3a3.2 3.2 0 0 1 6.4 0v2.2"></path>' },
};

export class ComposerControls {
  readonly elements: ComposerControlsElements;
  private readonly options: ComposerControlsOptions;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private mode: AccessMode;

  constructor(elements: ComposerControlsElements, options: ComposerControlsOptions) {
    this.elements = elements;
    this.options = options;
    this.storage = options.storage ?? localStorage;
    this.mode = this.storedAccessMode();
    this.bind();
    this.restoreTemperature();
    this.renderAccessMode();
    this.refreshLabels();
  }

  get routeId(): string { return this.elements.model.value; }
  get routeLabel(): string { return [...this.elements.model.options].find((option) => option.value === this.routeId)?.textContent ?? "—"; }
  get maxTokens(): number { return Number(this.elements.effort.value); }
  get temperature(): number { return Number(this.elements.temperature.value); }
  get accessMode(): AccessMode { return this.mode; }
  get hasRoutes(): boolean { return this.elements.model.options.length > 0; }

  setRoutes(routes: ComposerRouteOption[], preferredRoute?: string): void {
    const previous = preferredRoute ?? this.routeId;
    this.elements.model.replaceChildren();
    for (const route of routes) {
      const option = document.createElement("option");
      option.textContent = route.label;
      option.value = route.id;
      if (route.group) option.dataset.group = route.group;
      if (route.displayName) option.dataset.displayName = route.displayName;
      this.elements.model.add(option);
    }
    if (previous && routes.some((route) => route.id === previous)) this.elements.model.value = previous;
    this.refreshLabels();
  }

  setRoute(routeId: string): boolean {
    if (![...this.elements.model.options].some((option) => option.value === routeId)) return false;
    this.elements.model.value = routeId;
    this.refreshLabels();
    return true;
  }

  refreshLabels(): void {
    const option = [...this.elements.model.options].find((candidate) => candidate.value === this.routeId);
    const fullLabel = option?.textContent ?? "Model";
    // The full label may be "Smart · ninfer-1.5b" (route name + model name)
    // or just "Smart". The route name alone stays visible when the composer
    // is squeezed; the model name hides so only "Smart · Medium" remains.
    const routeName = option?.dataset.displayName || fullLabel;
    const modelName = fullLabel === routeName ? "" : fullLabel.slice(`${routeName} · `.length);
    const effortLabel = [...this.elements.effort.options].find((candidate) => candidate.value === this.elements.effort.value)?.textContent ?? "Medium";
    this.elements.modelRoute.textContent = routeName;
    this.elements.modelName.textContent = modelName ? ` · ${modelName}` : "";
    this.elements.modelName.hidden = !modelName;
    this.elements.modelEffort.textContent = ` · ${effortLabel}`;
    this.elements.modelValue.textContent = fullLabel;
    this.elements.effortValue.textContent = effortLabel;
  }

  updateContext(usedTokens: number, tokenLimit: number): void {
    const percentage = tokenLimit > 0 ? Math.min(100, (usedTokens / tokenLimit) * 100) : 0;
    const rounded = Math.round(percentage);
    this.elements.contextMeter.style.setProperty("--context-used", `${percentage}%`);
    this.elements.contextPercent.textContent = `${rounded}% full`;
    this.elements.contextTokens.textContent = `≈${formatTokenCount(usedTokens)} / ${formatTokenCount(tokenLimit)} tokens used`;
    this.elements.contextMeter.setAttribute("aria-label", `Context window ${rounded}% full, approximately ${formatTokenCount(usedTokens)} of ${formatTokenCount(tokenLimit)} tokens used`);
  }

  updateState(state: ComposerControlState): void {
    const { running, hasSession } = state;
    this.elements.model.disabled = !this.hasRoutes || running;
    this.elements.effort.disabled = running;
    this.elements.temperature.disabled = running;
    this.elements.advancedSettings.disabled = running;
    this.elements.modelToggle.disabled = !this.hasRoutes || running;
    this.elements.accessModeToggle.disabled = running;
    this.elements.contextCompactButton.disabled = !hasSession || running;
  }

  openContextUsage(): void {
    this.options.closeAllPopovers();
    this.elements.contextUsagePopover.hidden = false;
    this.elements.contextMeter.setAttribute("aria-expanded", "true");
  }

  resetContextStatus(): void {
    this.elements.contextCompactStatus.hidden = true;
    this.elements.contextCompactStatus.textContent = "";
  }

  setContextStatus(text: string, busy = false): void {
    this.elements.contextCompactStatus.hidden = false;
    this.elements.contextCompactStatus.textContent = text;
    this.elements.contextCompactButton.disabled = busy;
  }

  closePopovers(): void {
    this.elements.modelMenu.hidden = true;
    this.elements.settingsSubmenu.hidden = true;
    this.elements.advancedSettingsPanel.hidden = true;
    this.elements.contextUsagePopover.hidden = true;
    this.elements.accessModeMenu.hidden = true;
    this.elements.modelToggle.setAttribute("aria-expanded", "false");
    this.elements.advancedSettings.setAttribute("aria-expanded", "false");
    this.elements.contextMeter.setAttribute("aria-expanded", "false");
    this.elements.accessModeToggle.setAttribute("aria-expanded", "false");
    for (const row of this.elements.settingRows) row.classList.remove("active");
  }

  private bind(): void {
    const elements = this.elements;
    elements.model.addEventListener("change", () => this.selectRoute());
    elements.effort.addEventListener("change", () => this.refreshLabels());
    elements.modelToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover(elements.modelMenu, elements.modelToggle, this.options.closeAllPopovers);
    });
    elements.modelMenu.addEventListener("click", (event) => event.stopPropagation());
    elements.contextMeter.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover(elements.contextUsagePopover, elements.contextMeter, this.options.closeAllPopovers);
    });
    elements.contextUsagePopover.addEventListener("click", (event) => event.stopPropagation());
    elements.contextCompactButton.addEventListener("click", () => void this.options.onCompact());
    elements.accessModeToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover(elements.accessModeMenu, elements.accessModeToggle, this.options.closeAllPopovers);
    });
    elements.accessModeMenu.addEventListener("click", (event) => event.stopPropagation());
    for (const choice of elements.accessModeChoices) choice.addEventListener("click", () => this.setAccessMode(choice.dataset.accessMode as AccessMode));
    for (const row of elements.settingRows) row.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openSettingsSubmenu(row.dataset.setting as ComposerSetting, row);
    });
    elements.advancedSettings.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleAdvancedSettings();
    });
    elements.temperature.addEventListener("input", () => this.updateTemperature());
  }

  private selectRoute(): void {
    this.refreshLabels();
    this.options.onRouteChange(this.routeId);
  }

  private toggleAdvancedSettings(): void {
    const opening = this.elements.advancedSettingsPanel.hidden;
    this.elements.settingsSubmenu.hidden = true;
    for (const row of this.elements.settingRows) row.classList.remove("active");
    this.elements.advancedSettingsPanel.hidden = !opening;
    this.elements.advancedSettings.setAttribute("aria-expanded", String(opening));
  }

  private openSettingsSubmenu(kind: ComposerSetting, row: HTMLButtonElement): void {
    const select = kind === "model" ? this.elements.model : this.elements.effort;
    this.elements.advancedSettingsPanel.hidden = true;
    this.elements.advancedSettings.setAttribute("aria-expanded", "false");
    this.elements.settingsSubmenu.replaceChildren();
    let currentGroup = "";
    for (const option of [...select.options]) {
      const group = kind === "model" ? option.dataset.group ?? "" : "";
      if (group && group !== currentGroup) {
        const heading = document.createElement("small");
        heading.className = "settings-submenu-heading";
        heading.textContent = group;
        this.elements.settingsSubmenu.append(heading);
        currentGroup = group;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.classList.toggle("selected", option.value === select.value);
      const label = document.createElement("span");
      label.textContent = option.textContent;
      button.append(label);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        select.value = option.value;
        this.refreshLabels();
        if (kind === "model") this.options.onRouteChange(this.routeId);
        this.options.closeAllPopovers();
      });
      this.elements.settingsSubmenu.append(button);
    }
    for (const item of this.elements.settingRows) item.classList.toggle("active", item === row);
    this.elements.settingsSubmenu.hidden = false;
    positionNestedPopover(this.elements.settingsSubmenu, row);
  }

  private restoreTemperature(): void {
    const stored = Number(this.storage.getItem("fitz-temperature") ?? "0.4");
    this.elements.temperature.value = String(Number.isFinite(stored) && stored >= 0 && stored <= 2 ? stored : 0.4);
    this.updateTemperature();
  }

  private updateTemperature(): void {
    this.elements.temperatureValue.textContent = this.temperature.toFixed(1);
    this.storage.setItem("fitz-temperature", this.elements.temperature.value);
  }

  private storedAccessMode(): AccessMode {
    const value = this.storage.getItem("fitz-access-mode");
    return value === "ask" || value === "read-only" ? value : "full";
  }

  private setAccessMode(mode: AccessMode): void {
    this.mode = mode;
    this.storage.setItem("fitz-access-mode", mode);
    this.renderAccessMode();
    this.options.closeAllPopovers();
  }

  private renderAccessMode(): void {
    const value = ACCESS_MODES[this.mode];
    this.elements.accessModeLabel.textContent = value.label;
    this.elements.accessModeIcon.innerHTML = value.icon;
    this.elements.accessModeToggle.dataset.mode = this.mode;
    // The label hides when the composer is squeezed; the tooltip keeps the
    // mode discoverable on the icon-only button.
    this.elements.accessModeToggle.title = value.label;
    for (const choice of this.elements.accessModeChoices) choice.classList.toggle("selected", choice.dataset.accessMode === this.mode);
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.max(0, Math.round(value)));
}
