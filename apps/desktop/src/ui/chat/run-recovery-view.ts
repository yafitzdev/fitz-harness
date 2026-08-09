type Json = Record<string, any>;

export interface RunRecoveryViewOptions {
  messages: HTMLElement;
  resume: (runId: string, confirmUnsafe: boolean) => Promise<void>;
}

/** A durable interrupted-run boundary. It never implies that an unfinished
 * mutation is safe: review-required checkpoints ask before resubmission. */
export class RunRecoveryView {
  constructor(private readonly options: RunRecoveryViewOptions) {}

  show(run: Json): HTMLElement {
    this.clear();
    const row = document.createElement("section");
    row.className = "message run-recovery";
    row.dataset.runRecoveryId = String(run.id);
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Task interrupted";
    const detail = document.createElement("span");
    const review = run.checkpoint?.resumeSafety === "review-required";
    detail.textContent = review ? "An unfinished tool action needs review before continuing." : "Continue from the last durable checkpoint.";
    copy.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = review ? "Review and continue" : "Continue";
    button.addEventListener("click", async () => {
      const confirmed = !review || window.confirm("A tool call was in flight when this task stopped. Fitz will tell the agent to inspect its effects before retrying. Continue?");
      if (!confirmed) return;
      button.disabled = true; button.textContent = "Resuming…";
      try { await this.options.resume(String(run.id), review); row.remove(); }
      catch { button.disabled = false; button.textContent = review ? "Review and continue" : "Continue"; }
    });
    row.append(copy, button);
    this.options.messages.append(row);
    return row;
  }

  clear(): void { this.options.messages.querySelectorAll(".run-recovery").forEach((row) => row.remove()); }
}
