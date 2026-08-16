import { CollapsibleSection } from "../layout/collapsible-section.js";
import { svgIcon } from "../primitives/dom.js";
import { CatalogFilterBar } from "../catalog/catalog-filter-bar.js";
import { catalogQueryString, type CatalogNumericFilter, type CatalogSortOption } from "../catalog/catalog-filters.js";
import { createActionMenu } from "../primitives/action-menu.js";
import type { ActionFeedback } from "../primitives/action-status.js";

/** Raw host request boundary used by the page adapter. */
export type ModelCatalogApi = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export interface CatalogModel {
  id: string;
  downloads: number;
  likes: number;
  pipelineTag?: string;
  downloadable?: boolean;
  updatedAt?: string;
}

export interface DownloadedModel {
  repoId: string;
  fileName: string;
  path: string;
  size: number;
}

export interface DownloadRecord {
  id: string;
  repoId: string;
  fileName: string;
  received: number;
  total?: number;
  status: "active" | "done" | "cancelled" | "failed";
  path?: string;
  error?: string;
}

export interface ModelCatalogPage {
  total: number;
  models: CatalogModel[];
}

/** Typed endpoint client consumed by the catalog controller. */
export interface ModelCatalogClient {
  listDownloaded(): Promise<DownloadedModel[]>;
  listActiveDownloads(): Promise<DownloadRecord[]>;
  searchCatalog(path: string): Promise<ModelCatalogPage>;
  startDownload(repoId: string): Promise<DownloadRecord>;
  getDownload(id: string): Promise<DownloadRecord>;
  cancelDownload(id: string): Promise<void>;
  removeDownloaded(repoId: string, fileName: string): Promise<void>;
}

/**
 * Converts the raw JSON request function into an endpoint-specific client.
 * Responses are validated at this boundary so rendering code never has to
 * reach through an untyped `data` envelope or guess which fields are present.
 */
export function createModelCatalogClient(request: ModelCatalogApi): ModelCatalogClient {
  return {
    listDownloaded: async () => parseEnvelope(await request("/api/v1/management/models/downloaded"), parseDownloadedModels),
    listActiveDownloads: async () => parseEnvelope(await request("/api/v1/management/models/downloads"), parseDownloadRecords),
    searchCatalog: async (path) => parseEnvelope(await request(path), parseCatalogPage),
    startDownload: async (repoId) => parseEnvelope(await request("/api/v1/management/models/download", "POST", { repo: repoId }), parseDownloadRecord),
    getDownload: async (id) => parseEnvelope(await request(`/api/v1/management/models/downloads/${encodeURIComponent(id)}`), parseDownloadRecord),
    cancelDownload: async (id) => { await request(`/api/v1/management/models/downloads/${encodeURIComponent(id)}`, "DELETE"); },
    removeDownloaded: async (repoId, fileName) => { await request("/api/v1/management/models/downloaded", "DELETE", { repoId, fileName }); },
  };
}

export interface ModelCatalogElements {
  /** The content column that owns the collapsible sections. */
  view: HTMLElement;
  /** The page h1; mirrors the active category tab's label. */
  title: HTMLElement;
  modelSearch: HTMLInputElement;
  downloadedList: HTMLElement;
  catalogList: HTMLElement;
  loadMoreModels: HTMLButtonElement;
  refresh: HTMLButtonElement;
  /** Header tabs that filter the catalog by output category (data-category). */
  categoryTabs: HTMLButtonElement[];
}

export interface ModelCatalogOptions {
  api: ModelCatalogClient;
  openExternal: (url: string) => void | Promise<void>;
  openPath: (path: string) => void | Promise<void>;
  showStatus: ActionFeedback;
  errorMessage: (error: unknown) => string;
  searchDelayMs?: number;
  pollIntervalMs?: number;
}

const MODEL_SORT_OPTIONS: CatalogSortOption[] = [
  { key: "downloads", direction: "desc", label: "Most downloads" },
  { key: "updated", direction: "desc", label: "Recently updated" },
  { key: "likes", direction: "desc", label: "Most likes" },
  { key: "name", direction: "asc", label: "Name A–Z" },
];

/**
 * Threshold sliders; the host skips models below these so pages stay full.
 * Stops are log-spaced because catalog stats are heavily skewed (the top-1000
 * GGUF text-generation window spans ~0–3.4K likes and ~3K–5M downloads), and
 * the recency slider mirrors them in weeks.
 */
const LIKES_STOPS = [0, 10, 50, 100, 250, 500, 1000, 2000, 3000, 4000, 5000];
const DOWNLOADS_STOPS = [0, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000];
const RECENCY_STOPS = [0, 1, 2, 4, 8, 12, 26, 52];
const MODEL_NUMERIC_FILTERS: CatalogNumericFilter[] = [
  { key: "min_likes", label: "Min likes", stops: LIKES_STOPS },
  { key: "min_downloads", label: "Min downloads", stops: DOWNLOADS_STOPS, format: formatNumber },
  { key: "released_within_weeks", label: "Released within", stops: RECENCY_STOPS, format: formatRecency },
];

const modelIcon = '<path d="M10 2.5 17 6v8l-7 3.5L3 14V6z"></path><path d="M3 6l7 3.5L17 6M10 9.5V17.5"></path>';

/**
 * Owns the Models management tab: the Hugging Face catalog separated into
 * text-producing LLMs and image/video generators, per-model downloads with
 * progress polling and cancel, and the list of model files on the host. The
 * page body mirrors the Plugins tab: a collapsible Downloaded section above a
 * collapsible Discover section, with the type filter in the header tabs.
 */
export class ModelCatalogController {
  readonly elements: ModelCatalogElements;
  private readonly options: ModelCatalogOptions;
  private readonly searchDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly filterBar: CatalogFilterBar;
  private category: string;
  private models: CatalogModel[] = [];
  private downloaded: DownloadedModel[] = [];
  private catalogTotal = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private loadGeneration = 0;
  /** Active downloads keyed by repo id; the record carries the server id. */
  private downloads = new Map<string, DownloadRecord>();
  private pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(elements: ModelCatalogElements, options: ModelCatalogOptions) {
    this.elements = elements;
    this.options = options;
    this.searchDelayMs = options.searchDelayMs ?? 250;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    const activeTab = elements.categoryTabs.find((tab) => tab.classList.contains("active"));
    this.category = activeTab?.dataset.category ?? "llm";
    if (activeTab) elements.title.textContent = activeTab.textContent?.trim() || elements.title.textContent;
    CollapsibleSection.adoptAll(elements.view, { storageKey: "fitz-collapsed-model-sections" });
    this.filterBar = new CatalogFilterBar({
      sortOptions: MODEL_SORT_OPTIONS,
      numericFilters: MODEL_NUMERIC_FILTERS,
      onChange: () => void this.load(false),
    });
    elements.view.insertBefore(this.filterBar.element, elements.view.querySelector(".collapsible-section"));
    this.bind();
  }

  showLoading(): void {
    this.elements.downloadedList.replaceChildren(emptyState("Loading models…"));
  }

  async load(appendCatalog = false): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      if (!appendCatalog) {
        this.stopPolls();
        this.downloads.clear();
        const [downloaded, active] = await Promise.all([
          this.options.api.listDownloaded(),
          this.options.api.listActiveDownloads(),
        ]);
        if (generation !== this.loadGeneration) return;
        this.downloaded = downloaded;
        this.renderDownloaded();
        // Re-attach to downloads that were already running on the host.
        for (const record of active) {
          this.downloads.set(record.repoId, record);
          this.poll(record.id, record.repoId);
        }
      }
      await this.loadCatalog(appendCatalog, generation);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      const message = this.options.errorMessage(error);
      if (!appendCatalog) {
        this.elements.downloadedList.replaceChildren(emptyState(message));
        this.elements.catalogList.replaceChildren();
      }
      this.options.showStatus(message, "error");
    }
  }

  private bind(): void {
    this.elements.refresh.addEventListener("click", () => void this.load(false));
    this.elements.modelSearch.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.load(false), this.searchDelayMs);
    });
    this.elements.loadMoreModels.addEventListener("click", () => void this.load(true));
    for (const tab of this.elements.categoryTabs) {
      tab.addEventListener("click", () => {
        this.category = tab.dataset.category ?? "llm";
        this.elements.title.textContent = tab.textContent?.trim() || this.elements.title.textContent;
        void this.load(false);
      });
    }
  }

  private async loadCatalog(append: boolean, generation: number): Promise<void> {
    const offset = append ? this.models.length : 0;
    const query = encodeURIComponent(this.elements.modelSearch.value.trim());
    const category = encodeURIComponent(this.category);
    const response = await this.options.api.searchCatalog(`/api/v1/management/models/catalog?query=${query}&category=${category}&offset=${offset}&limit=30&${catalogQueryString(this.filterBar.filters)}`);
    if (generation !== this.loadGeneration) return;
    this.catalogTotal = response.total;
    this.models = append ? [...this.models, ...response.models] : response.models;
    this.renderCatalog();
  }

  private renderCatalog(): void {
    this.elements.catalogList.replaceChildren();
    const downloadedRepos = new Set(this.downloaded.map((entry) => entry.repoId));
    const visible = this.models.filter((entry) => !downloadedRepos.has(entry.id));
    if (!visible.length) this.elements.catalogList.append(emptyState("No matching models"));
    for (const entry of visible) {
      const card = this.modelCard(modelName(entry.id), catalogMeta(entry), entry.id, {
        title: "Open on Hugging Face",
        action: () => this.openExternal(`https://huggingface.co/${entry.id}`),
      });
      const actions = card.querySelector(".model-actions") as HTMLElement;
      if (this.downloads.has(entry.id)) {
        actions.append(this.progressControl(entry.id, this.downloads.get(entry.id)!));
      } else if (entry.downloadable !== false) {
        actions.append(this.downloadAction(entry.id));
      }
      this.elements.catalogList.append(card);
    }
    this.elements.loadMoreModels.hidden = this.models.length >= this.catalogTotal;
  }

  private renderDownloaded(): void {
    this.elements.downloadedList.replaceChildren();
    if (!this.downloaded.length) {
      this.elements.downloadedList.append(emptyState("No models downloaded"));
      return;
    }
    for (const entry of this.downloaded) {
      const card = this.modelCard(modelName(entry.repoId), `${entry.fileName} · ${formatBytes(entry.size)}`, entry.repoId, {
        title: "Show in folder",
        action: () => this.openPath(parentDirectory(entry.path)),
      });
      const actions = card.querySelector(".model-actions") as HTMLElement;
      actions.append(createActionMenu([
        { label: "Show in folder", action: () => this.openPath(parentDirectory(entry.path)) },
        { label: "Delete", action: () => this.removeDownloaded(entry), danger: true, confirm: true },
      ], `Actions for ${modelName(entry.repoId)}`));
      this.elements.downloadedList.append(card);
    }
  }

  private modelCard(name: string, meta: string, repoId: string, open: { title: string; action: () => void | Promise<void> }): HTMLElement {
    const card = document.createElement("article");
    card.className = "model-card model-card-linked";
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.title = open.title;
    card.addEventListener("click", (event) => {
      if (!(event.target as HTMLElement).closest(".model-actions")) void open.action();
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest(".model-actions")) {
        event.preventDefault();
        void open.action();
      }
    });
    const icon = document.createElement("span");
    icon.className = "model-icon";
    icon.append(svgIcon(modelIcon));
    const copy = document.createElement("div");
    copy.className = "model-copy";
    const heading = document.createElement("strong");
    heading.textContent = name;
    const detail = document.createElement("span");
    detail.className = "model-meta";
    detail.textContent = meta;
    copy.append(heading, detail);
    const actions = document.createElement("div");
    actions.className = "model-actions";
    card.append(icon, copy, actions);
    return card;
  }

  private async openExternal(url: string): Promise<void> {
    try { await this.options.openExternal(url); }
    catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private async openPath(path: string): Promise<void> {
    try { await this.options.openPath(path); }
    catch (error) { this.options.showStatus(this.options.errorMessage(error), "error"); }
  }

  private downloadAction(repoId: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-action";
    button.textContent = "Download";
    button.title = "Downloads the recommended GGUF file for this model";
    button.addEventListener("click", async () => {
      if (button.dataset.confirm !== "true") {
        button.dataset.confirm = "true";
        button.textContent = "Download?";
        return;
      }
      button.disabled = true;
      button.textContent = "Starting…";
      try {
        const record = await this.options.api.startDownload(repoId);
        this.downloads.set(repoId, record);
        this.poll(record.id, repoId);
        this.renderCatalog();
      } catch (error) {
        this.options.showStatus(this.options.errorMessage(error), "error");
      } finally {
        button.disabled = false;
        button.dataset.confirm = "false";
        button.textContent = "Download";
      }
    });
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) {
        button.dataset.confirm = "false";
        button.textContent = "Download";
      }
    });
    return button;
  }

  private progressControl(repoId: string, record: DownloadRecord): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "model-progress";
    const track = document.createElement("span");
    track.className = "model-progress-track";
    const fill = document.createElement("span");
    fill.className = "model-progress-fill";
    const percent = record.total ? Math.min(100, Math.round((record.received / record.total) * 100)) : 0;
    fill.style.width = `${percent}%`;
    track.append(fill);
    const copy = document.createElement("span");
    copy.className = "model-progress-copy";
    const label = document.createElement("span");
    label.textContent = record.total ? `${formatBytes(record.received)} / ${formatBytes(record.total)}` : formatBytes(record.received);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "model-progress-cancel";
    cancel.title = "Cancel download";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      void this.cancelDownload(repoId).finally(() => { if (cancel.isConnected) cancel.disabled = false; });
    });
    copy.append(label, cancel);
    wrapper.append(track, copy);
    return wrapper;
  }

  private poll(id: string, repoId: string): void {
    const timer = setTimeout(async () => {
      if (this.pollTimers.get(repoId) !== timer) return;
      try {
        const record = await this.options.api.getDownload(id);
        this.downloads.set(repoId, record);
        this.renderCatalog();
        if (record.status === "active") {
          this.poll(id, repoId);
          return;
        }
        this.pollTimers.delete(repoId);
        if (record.status === "done") {
          this.options.showStatus(`Downloaded ${record.fileName}`, "success");
          await this.load(false);
        } else if (record.status === "failed") {
          this.downloads.delete(repoId);
          this.renderCatalog();
          this.options.showStatus(record.error ?? "Download failed", "error");
        }
      } catch (error) {
        this.pollTimers.delete(repoId);
        this.downloads.delete(repoId);
        this.renderCatalog();
        this.options.showStatus(this.options.errorMessage(error), "error");
      }
    }, this.pollIntervalMs);
    this.pollTimers.set(repoId, timer);
  }

  private async cancelDownload(repoId: string): Promise<void> {
    const record = this.downloads.get(repoId);
    if (!record) return;
    try {
      await this.options.api.cancelDownload(record.id);
      this.downloads.delete(repoId);
      this.pollTimers.delete(repoId);
      this.renderCatalog();
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  private async removeDownloaded(entry: DownloadedModel): Promise<void> {
    try {
      await this.options.api.removeDownloaded(entry.repoId, entry.fileName);
      await this.load(false);
      this.options.showStatus(`Removed ${entry.fileName}`, "success");
    } catch (error) {
      this.options.showStatus(this.options.errorMessage(error), "error");
    }
  }

  private stopPolls(): void {
    for (const timer of this.pollTimers.values()) clearTimeout(timer);
    this.pollTimers.clear();
  }
}

function parseEnvelope<T>(value: unknown, parse: (value: unknown) => T): T {
  if (!isRecord(value) || !("data" in value)) throw invalidResponse("missing data envelope");
  return parse(value.data);
}

function parseCatalogPage(value: unknown): ModelCatalogPage {
  if (!isRecord(value) || !isFiniteNumber(value.total) || !Array.isArray(value.models)) {
    throw invalidResponse("catalog page is invalid");
  }
  return { total: value.total, models: value.models.map(parseCatalogModel) };
}

function parseCatalogModel(value: unknown): CatalogModel {
  if (!isRecord(value) || typeof value.id !== "string" || !isFiniteNumber(value.downloads) || !isFiniteNumber(value.likes)) {
    throw invalidResponse("catalog model is invalid");
  }
  return {
    id: value.id,
    downloads: value.downloads,
    likes: value.likes,
    ...(typeof value.pipelineTag === "string" ? { pipelineTag: value.pipelineTag } : {}),
    ...(typeof value.downloadable === "boolean" ? { downloadable: value.downloadable } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function parseDownloadedModels(value: unknown): DownloadedModel[] {
  if (!Array.isArray(value)) throw invalidResponse("downloaded models are invalid");
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.repoId !== "string" || typeof entry.fileName !== "string"
      || typeof entry.path !== "string" || !isFiniteNumber(entry.size)) {
      throw invalidResponse("downloaded model is invalid");
    }
    return { repoId: entry.repoId, fileName: entry.fileName, path: entry.path, size: entry.size };
  });
}

function parseDownloadRecords(value: unknown): DownloadRecord[] {
  if (!Array.isArray(value)) throw invalidResponse("download records are invalid");
  return value.map(parseDownloadRecord);
}

function parseDownloadRecord(value: unknown): DownloadRecord {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.repoId !== "string"
    || typeof value.fileName !== "string" || !isFiniteNumber(value.received) || !isDownloadStatus(value.status)) {
    throw invalidResponse("download record is invalid");
  }
  return {
    id: value.id,
    repoId: value.repoId,
    fileName: value.fileName,
    received: value.received,
    status: value.status,
    ...(isFiniteNumber(value.total) ? { total: value.total } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function isDownloadStatus(value: unknown): value is DownloadRecord["status"] {
  return value === "active" || value === "done" || value === "cancelled" || value === "failed";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(detail: string): TypeError {
  return new TypeError(`The model catalog returned an invalid response: ${detail}`);
}

function emptyState(message: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "panel-empty";
  element.textContent = message;
  return element;
}

function parentDirectory(path: string): string {
  return path.replace(/[^/\\]+$/, "") || path;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

/** "released in the last X weeks" readout; 0 (no filter) reads as "any time". */
function formatRecency(weeks: number): string {
  if (weeks <= 0) return "any time";
  return weeks === 1 ? "last week" : `last ${weeks} weeks`;
}

function formatBytes(value: number): string {
  if (value >= 1 << 30) return `${(value / (1 << 30)).toFixed(1)} GB`;
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(0)} MB`;
  if (value >= 1 << 10) return `${(value / (1 << 10)).toFixed(0)} KB`;
  return `${value} B`;
}

/** The row title is the repo's last path segment, e.g. "Qwen/Qwen2.5-7B-Instruct-GGUF" → "Qwen2.5-7B-Instruct-GGUF". */
function modelName(repoId: string): string {
  return repoId.split("/").at(-1) ?? repoId;
}

/** Mirrors the plugin row's "description · version" line: publisher then the download stats. */
function catalogMeta(model: CatalogModel): string {
  const owner = model.id.split("/")[0];
  const stats = `${formatNumber(model.downloads)} downloads · ${formatNumber(model.likes)} likes`;
  return owner && owner !== model.id ? `${owner} · ${stats}` : stats;
}
