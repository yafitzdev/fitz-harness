export interface ConversationContextOptions {
  draft: () => string;
  estimateTokens: (text: string) => number;
  configuredLimit: () => number | undefined;
  updateMeter: (tokens: number, limit: number) => void;
  currentSessionId: () => string | undefined;
  routeId: () => string;
  runActive: () => boolean;
  compact: (sessionId: string, routeId: string) => Promise<{ estimatedContextTokens?: number; estimatedInputTokens?: number }>;
  setStatus: (message: string, loading?: boolean) => void;
  appendContext: (message: string) => void;
  refreshControls: () => void;
  errorMessage: (error: unknown) => string;
}

/** Owns conversation token estimation, route context limits, and compaction. */
export class ConversationContextController {
  readonly #options: ConversationContextOptions;
  #tokenEstimate = 0;
  #contextLimit = 131_072;

  constructor(options: ConversationContextOptions) { this.#options = options; }

  add(text: string): void { this.#tokenEstimate += this.#options.estimateTokens(text); }
  recalibrate(tokens: number): void { this.#tokenEstimate = tokens; this.refresh(); }
  restore(tokens: number): void { this.#tokenEstimate = tokens; }
  reset(): void { this.#tokenEstimate = 0; }

  refresh(): void {
    const configured = this.#options.configuredLimit();
    if (configured !== undefined && Number.isFinite(configured) && configured > 0) this.#contextLimit = configured;
    this.#options.updateMeter(this.#tokenEstimate + this.#options.estimateTokens(this.#options.draft()), this.#contextLimit);
  }

  async compact(): Promise<void> {
    const sessionId = this.#options.currentSessionId();
    if (!sessionId || this.#options.runActive()) return;
    this.#options.setStatus("Compacting…", true);
    try {
      const response = await this.#options.compact(sessionId, this.#options.routeId() || "default");
      this.#tokenEstimate = Number(response.estimatedContextTokens ?? this.#tokenEstimate);
      this.refresh();
      this.#options.appendContext("Context compacted");
      this.#options.setStatus(`Reduced ${formatTokenCount(Number(response.estimatedInputTokens ?? 0))} to ${formatTokenCount(this.#tokenEstimate)} tokens`);
    } catch (error) { this.#options.setStatus(this.#options.errorMessage(error)); }
    finally { this.#options.refreshControls(); }
  }
}

function formatTokenCount(value: number): string { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)); }
