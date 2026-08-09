import { textBlock } from "../primitives/dom.js";

type Json = Record<string, any>;

export interface DiagnosticsBridge { saveDiagnostics(content: string): Promise<string | undefined>; }

export interface DiagnosticsElements {
  generatedAt: HTMLElement;
  summary: HTMLElement;
  metrics: HTMLElement;
  failures: HTMLElement;
  exportStatus: HTMLElement;
  exportButton: HTMLButtonElement;
}

export interface DiagnosticsOptions {
  bridge: DiagnosticsBridge;
  errorMessage: (error: unknown) => string;
}

/** Owns redacted diagnostic rendering and export state. */
export class DiagnosticsController {
  readonly #elements: DiagnosticsElements;
  readonly #options: DiagnosticsOptions;
  #bundle: Json | undefined;

  constructor(elements: DiagnosticsElements, options: DiagnosticsOptions) {
    this.#elements = elements;
    this.#options = options;
    elements.exportButton.addEventListener("click", () => void this.#export());
  }

  render(diagnostics: Json): void {
    this.#bundle = diagnostics;
    this.#elements.generatedAt.textContent = diagnostics.generatedAt
      ? `Captured ${new Date(diagnostics.generatedAt).toLocaleString()} · values are redacted before leaving the host`
      : "";
    this.#elements.summary.replaceChildren();
    const stats = [
      ["Engine", diagnostics.engine?.state ?? "Unknown"],
      ["Queue", String(diagnostics.queueDepth ?? 0)],
      ["Free RAM", diagnosticMib(diagnostics.resources?.freeRamMiB, diagnostics.resources?.totalRamMiB)],
      ["Free VRAM", diagnosticMib(diagnostics.resources?.freeVramMiB, diagnostics.resources?.totalVramMiB)],
    ];
    for (const [label, value] of stats) {
      const stat = document.createElement("div");
      stat.className = "diagnostic-stat";
      stat.append(
        Object.assign(document.createElement("small"), { textContent: label }),
        Object.assign(document.createElement("strong"), { textContent: value }),
      );
      this.#elements.summary.append(stat);
    }

    const metricRows: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(diagnostics.metrics?.counters ?? {})) metricRows.push([name, Number(value).toLocaleString()]);
    for (const [name, value] of Object.entries(diagnostics.metrics?.gauges ?? {})) metricRows.push([name, String(value)]);
    for (const [name, value] of Object.entries<Json>(diagnostics.metrics?.timings ?? {})) metricRows.push([name, `${Number(value.averageMs ?? 0).toFixed(1)} ms avg`]);
    renderRows(this.#elements.metrics, metricRows, "No metrics recorded yet");

    const failures: Array<[string, string]> = [];
    for (const request of diagnostics.recentRequests ?? []) {
      if (["failed", "interrupted", "cancelled"].includes(request.status)) failures.push([`${request.routeId} · ${request.status}`, request.errorCode ?? request.id]);
    }
    for (const event of diagnostics.recentLifecycleEvents ?? []) {
      if (event.data?.state === "FAILED") failures.push([event.data.recipeId ?? "engine", event.data.reason ?? "Engine failed"]);
    }
    renderRows(this.#elements.failures, failures.slice(0, 20), "No recent failures");
  }

  async #export(): Promise<void> {
    if (!this.#bundle) return;
    this.#elements.exportButton.disabled = true;
    this.#elements.exportStatus.hidden = true;
    this.#elements.exportStatus.removeAttribute("role");
    delete this.#elements.exportStatus.dataset.state;
    try {
      const path = await this.#options.bridge.saveDiagnostics(JSON.stringify(this.#bundle, null, 2));
      if (path) this.#showExportStatus(`Saved to ${path}`);
    } catch (error) { this.#showExportStatus(this.#options.errorMessage(error), true); }
    finally { this.#elements.exportButton.disabled = false; }
  }

  #showExportStatus(message: string, error = false): void {
    this.#elements.exportStatus.textContent = message;
    this.#elements.exportStatus.hidden = false;
    if (error) {
      this.#elements.exportStatus.dataset.state = "error";
      this.#elements.exportStatus.setAttribute("role", "alert");
    } else {
      this.#elements.exportStatus.setAttribute("role", "status");
    }
  }
}

function renderRows(container: HTMLElement, rows: Array<[string, string]>, empty: string): void {
  container.replaceChildren();
  for (const [name, value] of rows) {
    const row = document.createElement("div");
    row.className = "diagnostic-row";
    row.append(
      Object.assign(document.createElement("span"), { textContent: name }),
      Object.assign(document.createElement("strong"), { textContent: value }),
    );
    container.append(row);
  }
  if (!rows.length) container.append(textBlock("panel-empty", empty));
}

function diagnosticMib(free: unknown, total: unknown): string {
  if (!Number.isFinite(Number(free)) || !Number.isFinite(Number(total))) return "Unavailable";
  return `${Math.round(Number(free)).toLocaleString()} / ${Math.round(Number(total)).toLocaleString()} MiB`;
}
