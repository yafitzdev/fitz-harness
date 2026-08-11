import { isTerminalMediaJobStatus } from "@fitz/protocol";

type Json = Record<string, any>;

export interface MediaJobSummary extends Json {
  id: string;
  sessionId?: string;
  modality: "image" | "audio" | "video";
  status: string;
  artifactId?: string;
  errorCode?: string;
  /** 0..1 diffusion progress reported by the engine (persisted on the job). */
  progress?: number;
}

export interface MediaJobTrackerOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  onTerminal: (job: MediaJobSummary, failure?: string) => void | Promise<void>;
  /** Fired whenever the set of active (non-terminal) watched jobs changes. */
  onActiveChange?: () => void;
  /** Fired while a watched job is queued/started/progressing so the job card can re-render its status bar. */
  onProgress?: (job: MediaJobSummary) => void;
  pollIntervalMs?: number;
}

/**
 * Follows Fitz media jobs after the agent's non-blocking generation tool exits.
 * Agent runs and media jobs use separate queues, so the chat stream can finish
 * minutes before the generated artifact exists. This tracker bridges that gap.
 */
export class MediaJobTracker {
  readonly #options: MediaJobTrackerOptions;
  readonly #watched = new Map<string, number>();
  readonly #state = new Map<string, { status: string; progress?: number }>();
  readonly #activeOrder: string[] = [];
  #generation = 0;

  constructor(options: MediaJobTrackerOptions) { this.#options = options; }

  /** True while any watched job is queued, started, or progressing. */
  get active(): boolean { return this.#activeOrder.length > 0; }

  /** The most recently watched non-terminal job; the one a stop button should cancel. */
  get activeJobId(): string | undefined { return this.#activeOrder[this.#activeOrder.length - 1]; }

  reset(): void {
    this.#generation += 1;
    this.#watched.clear();
    this.#state.clear();
    this.#activeOrder.length = 0;
    this.#options.onActiveChange?.();
  }

  /** Cancels the most recently watched active job (POST /cancel on the host). */
  async cancelActive(): Promise<boolean> {
    const jobId = this.activeJobId;
    if (!jobId) return false;
    await this.#options.api(`/api/v1/media/jobs/${encodeURIComponent(jobId)}/cancel`, "POST");
    return true;
  }

  watch(jobId: string): void {
    if (!jobId || this.#watched.has(jobId)) return;
    const generation = this.#generation;
    this.#watched.set(jobId, generation);
    this.#state.set(jobId, { status: "queued" });
    this.#activeOrder.push(jobId);
    this.#options.onActiveChange?.();
    void this.#follow(jobId, generation);
  }

  async failureMessage(jobId: string, fallback: string): Promise<string> {
    try {
      const response = await this.#options.api(`/api/v1/media/jobs/${encodeURIComponent(jobId)}/events?after=0`);
      const events = Array.isArray(response.data) ? response.data : [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]?.event;
        if (event?.type === "failed" && typeof event.error === "string" && event.error) return event.error;
      }
    } catch { /* The durable job state is still enough to show a useful fallback. */ }
    return fallback;
  }

  async #follow(jobId: string, generation: number): Promise<void> {
    let failures = 0;
    try {
      while (generation === this.#generation) {
        try {
          const response = await this.#options.api(`/api/v1/media/jobs/${encodeURIComponent(jobId)}`);
          failures = 0;
          const job = response.data as MediaJobSummary;
          if (isTerminalMediaJobStatus(String(job.status))) {
            this.#forget(jobId);
            const failure = job.status === "completed"
              ? undefined
              : await this.failureMessage(job.id, job.errorCode ?? `Media generation ${job.status}`);
            if (generation === this.#generation) await this.#options.onTerminal(job, failure);
            return;
          }
          this.#observe(job);
        } catch (error) {
          failures += 1;
          if (failures >= 12) throw error;
        }
        await delay(this.#options.pollIntervalMs ?? 1_000);
      }
    } catch (error) {
      if (generation === this.#generation) {
        this.#forget(jobId);
        const message = error instanceof Error ? error.message : String(error);
        await this.#options.onTerminal({ id: jobId, modality: "video", status: "failed" }, `Could not follow media job: ${message}`);
      }
    } finally {
      if (this.#watched.get(jobId) === generation) this.#watched.delete(jobId);
    }
  }

  /** Re-render the card only on meaningful changes: status transitions or ≥1% progress moves. */
  #observe(job: MediaJobSummary): void {
    const status = String(job.status);
    const progress = typeof job.progress === "number" ? job.progress : undefined;
    const previous = this.#state.get(job.id);
    const changed = !previous || status !== previous.status
      || (progress !== undefined && (previous.progress === undefined || Math.abs(progress - previous.progress) >= 0.01));
    const next: { status: string; progress?: number } = { status };
    if (progress !== undefined) next.progress = progress;
    this.#state.set(job.id, next);
    if (changed) this.#options.onProgress?.(job);
  }

  #forget(jobId: string): void {
    const index = this.#activeOrder.indexOf(jobId);
    if (index >= 0) this.#activeOrder.splice(index, 1);
    if (this.#state.delete(jobId)) this.#options.onActiveChange?.();
  }
}

/** Pi tool results keep custom metadata in `details`; ignore ordinary tools. */
export function mediaJobIdFromToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const mediaJobId = (details as { mediaJobId?: unknown }).mediaJobId;
  return typeof mediaJobId === "string" && mediaJobId ? mediaJobId : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
