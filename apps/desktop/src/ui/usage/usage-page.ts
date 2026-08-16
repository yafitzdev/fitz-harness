import type { UsageBreakdownRow, UsageReport, UsageTimelineBucket } from "@fitz/protocol";

type RangeId = "day" | "week" | "month";

/** Raw host request boundary used by the usage page adapter. */
export type UsagePageApi = (path: string) => Promise<unknown>;

export interface UsagePageClient {
  report(path: string): Promise<UsageReport>;
}

/** Validates the immutable usage report before it reaches the renderer. */
export function createUsagePageClient(request: UsagePageApi): UsagePageClient {
  return { report: async (path) => parseEnvelope(await request(path), parseUsageReport) };
}

export interface UsagePageOptions {
  root: HTMLElement;
  refresh: HTMLButtonElement;
  api: UsagePageClient;
  errorMessage: (error: unknown) => string;
}

const ranges: Record<RangeId, { label: string; milliseconds: number; bucket: "hour" | "day" }> = {
  day: { label: "24 hours", milliseconds: 86_400_000, bucket: "hour" },
  week: { label: "7 days", milliseconds: 7 * 86_400_000, bucket: "day" },
  month: { label: "30 days", milliseconds: 30 * 86_400_000, bucket: "day" },
};

/** Owns the usage dashboard lifecycle and renders only immutable aggregate facts. */
export class UsagePageController {
  readonly #options: UsagePageOptions;
  #range: RangeId = "week";

  constructor(options: UsagePageOptions) {
    this.#options = options;
    options.refresh.addEventListener("click", () => void this.load());
  }

  showLoading(): void {
    this.#options.root.replaceChildren(message("Loading usage…"));
  }

  async load(): Promise<void> {
    this.showLoading();
    try {
      const range = ranges[this.#range];
      const to = new Date();
      const from = new Date(to.getTime() - range.milliseconds);
      const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), bucket: range.bucket });
      const report = await this.#options.api.report(`/api/v1/management/usage?${query}`);
      this.render(report);
    } catch (error) {
      this.#options.root.replaceChildren(message(this.#options.errorMessage(error)));
    }
  }

  render(report: UsageReport): void {
    const controls = document.createElement("div");
    controls.className = "usage-range";
    for (const [id, range] of Object.entries(ranges) as [RangeId, typeof ranges[RangeId]][]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = range.label;
      button.classList.toggle("active", id === this.#range);
      button.addEventListener("click", () => {
        if (id === this.#range) return;
        this.#range = id;
        void this.load();
      });
      controls.append(button);
    }

    const cards = document.createElement("section");
    cards.className = "usage-kpis";
    const totalTokens = report.totals.promptTokens + report.totals.completionTokens;
    const successRate = report.totals.requests === 0 ? 0 : report.totals.successful / report.totals.requests;
    cards.append(
      metric("Requests", formatNumber(report.totals.requests), `${report.totals.mediaJobs} media`),
      metric("Success rate", formatPercent(successRate), terminalFailureSummary(report)),
      metric("Tokens", compactNumber(totalTokens), `${report.totals.tokenReportedRequests}/${report.totals.requests} reported`),
      metric("Avg. queue", formatDuration(report.totals.averageQueueWaitMs), "Time before execution"),
      metric("Avg. first output", formatDuration(report.totals.averageTtftMs), "Chat requests with telemetry"),
      metric("Avg. duration", formatDuration(report.totals.averageDurationMs), "All terminal requests"),
      metric("Recorded cost", formatMoney(report.totals.creditCostCents), "Provider-reported credits only"),
    );

    const timeline = panel("Request volume", "Terminal requests over time", renderTimeline(report.timeline));
    const breakdowns = document.createElement("div");
    breakdowns.className = "usage-breakdowns";
    breakdowns.append(
      panel("Routes", "Requests and token usage", renderBreakdown(report.routes)),
      panel("Modalities", "Text and media workload", renderBreakdown(report.modalities)),
    );
    const recipes = panel("Recipes", "Models that handled work in this period", renderRecipeTable(report.recipes));

    const content = document.createDocumentFragment();
    content.append(controls, cards, timeline, breakdowns, recipes);
    this.#options.root.replaceChildren(content);
  }
}

function message(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "panel-empty";
  element.textContent = text;
  return element;
}

function metric(label: string, value: string, note: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "usage-kpi";
  const name = document.createElement("span"); name.textContent = label;
  const amount = document.createElement("strong"); amount.textContent = value;
  const detail = document.createElement("small"); detail.textContent = note;
  article.append(name, amount, detail);
  return article;
}

function panel(title: string, description: string, body: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.className = "usage-panel";
  const header = document.createElement("header");
  const heading = document.createElement("h2"); heading.textContent = title;
  const note = document.createElement("p"); note.textContent = description;
  header.append(heading, note);
  section.append(header, body);
  return section;
}

function renderTimeline(rows: UsageTimelineBucket[]): HTMLElement {
  if (!rows.length) return empty("No requests in this period");
  const width = 720;
  const height = 190;
  const pad = 18;
  const max = Math.max(1, ...rows.map((row) => row.requests));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Request volume over time");
  svg.classList.add("usage-line-chart");
  const point = (row: UsageTimelineBucket, index: number) => ({
    x: rows.length === 1 ? width / 2 : pad + index * ((width - pad * 2) / (rows.length - 1)),
    y: height - pad - row.requests / max * (height - pad * 2),
  });
  const points = rows.map(point);
  const area = document.createElementNS(svg.namespaceURI, "path");
  area.setAttribute("d", `M ${points[0]!.x} ${height - pad} ${points.map((item) => `L ${item.x} ${item.y}`).join(" ")} L ${points.at(-1)!.x} ${height - pad} Z`);
  area.classList.add("usage-chart-area");
  const line = document.createElementNS(svg.namespaceURI, "path");
  line.setAttribute("d", `M ${points.map((item) => `${item.x} ${item.y}`).join(" L ")}`);
  line.classList.add("usage-chart-line");
  svg.append(area, line);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.requests === 0) continue;
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", String(points[index]!.x));
    circle.setAttribute("cy", String(points[index]!.y));
    circle.setAttribute("r", "3");
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = `${new Date(row.timestamp).toLocaleString()}: ${row.requests} requests`;
    circle.append(title);
    svg.append(circle);
  }
  const container = document.createElement("div");
  container.className = "usage-chart-container";
  container.append(svg);
  return container;
}

function renderBreakdown(rows: UsageBreakdownRow[]): HTMLElement {
  if (!rows.length) return empty("No usage yet");
  const list = document.createElement("div");
  list.className = "usage-bars";
  const max = Math.max(1, ...rows.map((row) => row.requests));
  for (const row of rows.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "usage-bar-row";
    const heading = document.createElement("div");
    const label = document.createElement("span"); label.textContent = row.label;
    const value = document.createElement("strong"); value.textContent = formatNumber(row.requests);
    heading.append(label, value);
    const track = document.createElement("div"); track.className = "usage-bar-track";
    const fill = document.createElement("span"); fill.style.width = `${Math.max(2, row.requests / max * 100)}%`;
    track.append(fill);
    const detail = document.createElement("small");
    detail.textContent = `${compactNumber(row.totalTokens)} tokens${row.failed ? ` · ${row.failed} failed` : ""}${row.interrupted ? ` · ${row.interrupted} interrupted` : ""}`;
    item.append(heading, track, detail);
    list.append(item);
  }
  return list;
}

function renderRecipeTable(rows: UsageBreakdownRow[]): HTMLElement {
  if (!rows.length) return empty("No recipes handled requests in this period");
  const table = document.createElement("div");
  table.className = "usage-table";
  const header = document.createElement("div");
  for (const value of ["Recipe", "Requests", "Tokens", "Avg. duration"]) {
    const cell = document.createElement("strong"); cell.textContent = value; header.append(cell);
  }
  table.append(header);
  for (const row of rows.slice(0, 20)) {
    const item = document.createElement("div");
    const label = document.createElement("span"); label.textContent = row.label;
    const requests = document.createElement("span"); requests.textContent = formatNumber(row.requests);
    const tokens = document.createElement("span"); tokens.textContent = compactNumber(row.totalTokens);
    const duration = document.createElement("span"); duration.textContent = formatDuration(row.averageDurationMs);
    item.append(label, requests, tokens, duration);
    table.append(item);
  }
  return table;
}

function empty(message: string): HTMLElement {
  const value = document.createElement("p");
  value.className = "usage-empty";
  value.textContent = message;
  return value;
}

function formatNumber(value: number): string { return new Intl.NumberFormat().format(value); }
function compactNumber(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatPercent(value: number): string { return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value); }
function formatMoney(cents: number): string { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100); }
function formatDuration(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function terminalFailureSummary(report: UsageReport): string {
  const parts = [
    report.totals.failed ? `${report.totals.failed} failed` : "",
    report.totals.cancelled ? `${report.totals.cancelled} cancelled` : "",
    report.totals.interrupted ? `${report.totals.interrupted} interrupted` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "No unsuccessful requests";
}

function parseEnvelope<T>(value: unknown, parse: (value: unknown) => T): T {
  if (!isRecord(value) || !("data" in value)) throw invalidResponse("missing data envelope");
  return parse(value.data);
}

function parseUsageReport(value: unknown): UsageReport {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string"
    || (value.bucket !== "hour" && value.bucket !== "day") || !isRecord(value.totals)
    || !Array.isArray(value.timeline) || !Array.isArray(value.routes) || !Array.isArray(value.recipes) || !Array.isArray(value.modalities)) {
    throw invalidResponse("usage report is invalid");
  }
  return {
    from: value.from,
    to: value.to,
    bucket: value.bucket,
    totals: parseUsageTotals(value.totals),
    timeline: value.timeline.map(parseTimelineBucket),
    routes: value.routes.map(parseBreakdownRow),
    recipes: value.recipes.map(parseBreakdownRow),
    modalities: value.modalities.map(parseBreakdownRow),
  };
}

function parseUsageTotals(value: Record<string, unknown>): UsageReport["totals"] {
  const required = ["requests", "successful", "failed", "cancelled", "interrupted", "promptTokens", "completionTokens", "totalTokens", "tokenReportedRequests", "mediaJobs", "creditCostCents"];
  if (required.some((key) => !isFiniteNumber(value[key]))) throw invalidResponse("usage totals are invalid");
  const averageQueueWaitMs = optionalNumber(value.averageQueueWaitMs);
  const averageTtftMs = optionalNumber(value.averageTtftMs);
  const averageDurationMs = optionalNumber(value.averageDurationMs);
  return {
    requests: requiredNumber(value, "requests"),
    successful: requiredNumber(value, "successful"),
    failed: requiredNumber(value, "failed"),
    cancelled: requiredNumber(value, "cancelled"),
    interrupted: requiredNumber(value, "interrupted"),
    promptTokens: requiredNumber(value, "promptTokens"),
    completionTokens: requiredNumber(value, "completionTokens"),
    totalTokens: requiredNumber(value, "totalTokens"),
    tokenReportedRequests: requiredNumber(value, "tokenReportedRequests"),
    mediaJobs: requiredNumber(value, "mediaJobs"),
    creditCostCents: requiredNumber(value, "creditCostCents"),
    ...(averageQueueWaitMs !== undefined ? { averageQueueWaitMs } : {}),
    ...(averageTtftMs !== undefined ? { averageTtftMs } : {}),
    ...(averageDurationMs !== undefined ? { averageDurationMs } : {}),
  };
}

function parseTimelineBucket(value: unknown): UsageTimelineBucket {
  if (!isRecord(value) || typeof value.timestamp !== "string"
    || !isFiniteNumber(value.requests) || !isFiniteNumber(value.failed) || !isFiniteNumber(value.interrupted)
    || !isFiniteNumber(value.mediaJobs) || !isFiniteNumber(value.promptTokens) || !isFiniteNumber(value.completionTokens)) {
    throw invalidResponse("usage timeline is invalid");
  }
  return {
    timestamp: value.timestamp,
    requests: value.requests,
    failed: value.failed,
    interrupted: value.interrupted,
    mediaJobs: value.mediaJobs,
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
  };
}

function parseBreakdownRow(value: unknown): UsageBreakdownRow {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.label !== "string"
    || !isFiniteNumber(value.requests) || !isFiniteNumber(value.failed) || !isFiniteNumber(value.interrupted) || !isFiniteNumber(value.totalTokens)) {
    throw invalidResponse("usage breakdown is invalid");
  }
  const averageTtftMs = optionalNumber(value.averageTtftMs);
  const averageDurationMs = optionalNumber(value.averageDurationMs);
  return {
    key: value.key,
    label: value.label,
    requests: value.requests,
    failed: value.failed,
    interrupted: value.interrupted,
    totalTokens: value.totalTokens,
    ...(averageTtftMs !== undefined ? { averageTtftMs } : {}),
    ...(averageDurationMs !== undefined ? { averageDurationMs } : {}),
  };
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const entry = value[key];
  if (!isFiniteNumber(entry)) throw invalidResponse(`usage total ${key} is invalid`);
  return entry;
}

function optionalNumber(value: unknown): number | undefined { return isFiniteNumber(value) ? value : undefined; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalidResponse(detail: string): TypeError { return new TypeError(`The usage API returned an invalid response: ${detail}`); }
