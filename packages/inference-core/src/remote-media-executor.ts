import type { MediaGenerationRequest, MediaJobEvent, Recipe } from "@fitz/protocol";
import type { MediaJobHandle } from "./adapter.js";
import { EngineAdapterRegistry } from "./adapter.js";
import { abortableDelay } from "./abortable-delay.js";

/** Executes provider-hosted media without entering the local model lifecycle.
 * Each job owns its provider handle, so bounded concurrent cloud requests cannot
 * evict, replace, or falsely report the state of the one local GPU model. */
export class RemoteMediaExecutor {
  constructor(readonly adapters: EngineAdapterRegistry) {}

  async *run(
    recipe: Recipe,
    request: MediaGenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<MediaJobEvent> {
    const adapter = this.adapters.getMedia(recipe.adapter);
    if ((adapter.executionLocation?.(recipe) ?? "local") !== "remote") {
      throw new Error(`Recipe ${recipe.id} is not a remote media recipe`);
    }
    const validation = await adapter.validateRecipe(recipe);
    if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, signal);
    let job: MediaJobHandle | undefined;
    try {
      await adapter.waitUntilReady(instance, signal);
      job = await adapter.submit(instance, request, signal);
      yield { type: "started", providerJobId: job.id };
      for (;;) {
        const poll = await adapter.poll(instance, job, signal);
        if (poll.status === "completed" && poll.result) {
          yield { type: "completed", result: poll.result };
          return;
        }
        if (poll.status === "failed") throw new Error(poll.error ?? "Remote media generation failed");
        if (poll.status === "cancelled") throw abortError();
        if (poll.progress !== undefined) yield { type: "progress", progress: poll.progress };
        await abortableDelay(adapter.defaultPollIntervalMs ?? 1_000, signal);
      }
    } catch (error) {
      // Once a provider accepted a job, every non-completion path attempts a
      // provider-side cancellation. Otherwise a failed poll or lost network
      // response could leave paid remote work running after Fitz releases it.
      if (job) try { await adapter.cancel(instance, job); } catch { /* best-effort provider cleanup */ }
      throw error;
    } finally {
      await adapter.stop(instance, "graceful").catch(() => undefined);
    }
  }
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
