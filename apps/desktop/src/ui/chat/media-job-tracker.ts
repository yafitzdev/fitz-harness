type Json = Record<string, any>;

export interface MediaJobSummary extends Json {
  id: string;
  sessionId?: string;
  modality: "image" | "audio" | "video";
  status: string;
  artifactId?: string;
  errorCode?: string;
}

export interface MediaJobTrackerOptions {
  api: (path: string, method?: string, body?: unknown) => Promise<Json>;
  onTerminal: (job: MediaJobSummary, failure?: string) => void | Promise<void>;
  pollIntervalMs?: number;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * Follows Fitz media jobs after the agent's non-blocking generation tool exits.
 * Agent runs and media jobs use separate queues, so the chat stream can finish
 * minutes before the generated artifact exists. This tracker bridges that gap.
 */
export class MediaJobTracker {
  readonly #options: MediaJobTrackerOptions;
  readonly #watched = new Map<string, number>();
  #generation = 0;

  constructor(options: MediaJobTrackerOptions) { this.#options = options; }

  reset(): void {
    this.#generation += 1;
    this.#watched.clear();
  }

  watch(jobId: string): void {
    if (!jobId || this.#watched.has(jobId)) return;
    const generation = this.#generation;
    this.#watched.set(jobId, generation);
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
          if (TERMINAL.has(String(job.status))) {
            const failure = job.status === "completed"
              ? undefined
              : await this.failureMessage(job.id, job.errorCode ?? `Media generation ${job.status}`);
            if (generation === this.#generation) await this.#options.onTerminal(job, failure);
            return;
          }
        } catch (error) {
          failures += 1;
          if (failures >= 12) throw error;
        }
        await delay(this.#options.pollIntervalMs ?? 1_000);
      }
    } catch (error) {
      if (generation === this.#generation) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#options.onTerminal({ id: jobId, modality: "video", status: "failed" }, `Could not follow media job: ${message}`);
      }
    } finally {
      if (this.#watched.get(jobId) === generation) this.#watched.delete(jobId);
    }
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
