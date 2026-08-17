export interface ConversationContextOptions {
  draft: () => string;
  estimateTokens: (text: string) => number;
  configuredLimit: () => number | undefined;
  updateMeter: (tokens: number, limit: number) => void;
  currentSessionId: () => string | undefined;
  routeId: () => string;
  compact: (sessionId: string, routeId: string) => Promise<{ estimatedContextTokens?: number; estimatedInputTokens?: number }>;
  /** Re-read the host's authoritative post-compaction estimate. */
  refreshSessionEstimate?: (sessionId: string) => Promise<number | undefined>;
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
    if (!sessionId) {
      this.#options.setStatus("Open a chat before compacting");
      this.#options.refreshControls();
      return;
    }
    this.#options.setStatus("Compacting…", true);
    try {
      const response = await this.#options.compact(sessionId, this.#options.routeId() || "default");
      // The host is the authority for both the checkpoint and its resulting
      // context estimate. A renderer can be stale after a reconnect or chat
      // switch, so never accept a malformed response as a successful reset.
      let estimatedContextTokens = Number(response.estimatedContextTokens);
      if (this.#options.refreshSessionEstimate) {
        try {
          const refreshed = await this.#options.refreshSessionEstimate(sessionId);
          if (refreshed !== undefined) estimatedContextTokens = refreshed;
        } catch {
          // The POST response remains authoritative when the follow-up read
          // is unavailable; the checkpoint has already been durably written.
        }
      }
      if (!Number.isFinite(estimatedContextTokens) || estimatedContextTokens < 0) {
        throw new Error("The host returned an invalid compaction estimate");
      }
      // Do not let a late response from an old chat overwrite the current
      // chat's meter or activity feed.
      if (this.#options.currentSessionId() !== sessionId) return;
      this.#tokenEstimate = estimatedContextTokens;
      this.refresh();
      this.#options.appendContext("Context compacted");
      this.#options.setStatus(`Reduced ${formatTokenCount(Number(response.estimatedInputTokens ?? 0))} to ${formatTokenCount(this.#tokenEstimate)} tokens`);
    } catch (error) {
      if (this.#options.currentSessionId() === sessionId) this.#options.setStatus(this.#options.errorMessage(error));
    }
    finally { this.#options.refreshControls(); }
  }
}

function formatTokenCount(value: number): string { return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value)); }
