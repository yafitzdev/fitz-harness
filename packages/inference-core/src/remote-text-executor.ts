import type { InferenceDelta, InferenceRequest, Recipe } from "@fitz/protocol";
import { isMediaEngineAdapter, type EngineAdapterRegistry } from "./adapter.js";

/** Executes consumer-owned cloud text models outside the one local model
 * lifecycle. Every request gets an independent lightweight endpoint handle,
 * allowing cloud planning and workers to overlap without touching local VRAM. */
export class RemoteTextExecutor {
  constructor(readonly adapters: EngineAdapterRegistry) {}

  async *run(
    recipe: Recipe,
    request: InferenceRequest,
    signal: AbortSignal,
    hooks: { onInferenceStarted?: () => void } = {},
  ): AsyncIterable<InferenceDelta> {
    const adapter = this.adapters.get(recipe.adapter);
    if (isMediaEngineAdapter(adapter) || (adapter.executionLocation?.(recipe) ?? "local") !== "remote") {
      throw new Error(`Recipe ${recipe.id} is not a remote text recipe`);
    }
    const validation = await adapter.validateRecipe(recipe);
    if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
    const spec = await adapter.buildLaunchSpec(recipe, { host: "127.0.0.1", port: 0 });
    const instance = await adapter.start(recipe, spec, signal);
    try {
      hooks.onInferenceStarted?.();
      yield* adapter.streamChat(instance, request, signal);
    } finally {
      await adapter.stop(instance, "graceful").catch(() => undefined);
    }
  }
}
