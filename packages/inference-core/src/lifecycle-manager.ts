import { randomUUID } from "node:crypto";
import type {
  InferenceDelta,
  InferenceRequest,
  InstanceSnapshot,
  InstanceState,
  MediaGenerationRequest,
  MediaJobEvent,
  Recipe,
} from "@fitz/protocol";
import type { EngineAdapter, EngineInstanceHandle, MediaEngineAdapter, MediaJobHandle } from "./adapter.js";
import { EngineAdapterRegistry, isMediaEngineAdapter } from "./adapter.js";
import type { Clock, ScheduledTask } from "./clock.js";
import { SystemClock } from "./clock.js";
import { LifecycleEventBus } from "./event-bus.js";
import { assertTransition } from "./state-machine.js";
import { ResourceGovernor, SystemResourceMonitor } from "./resources.js";
import { GpuThermalGuard, ThermalSafetyError } from "./thermal.js";

const MAX_MODEL_IDLE_TTL_MS = 10 * 60 * 1_000;

export interface LifecycleManagerOptions {
  adapters: EngineAdapterRegistry;
  events?: LifecycleEventBus;
  clock?: Clock;
  allocatePort?: () => number;
  resources?: ResourceGovernor;
  thermalGuard?: GpuThermalGuard;
}

export class LifecycleManager {
  readonly events: LifecycleEventBus;
  readonly resources: ResourceGovernor;
  readonly thermalGuard: GpuThermalGuard;
  readonly #adapters: EngineAdapterRegistry;
  readonly #clock: Clock;
  readonly #allocatePort: () => number;
  #state: InstanceState = "UNLOADED";
  #instanceId: string | undefined;
  #recipe: Recipe | undefined;
  #adapter: EngineAdapter | MediaEngineAdapter | undefined;
  #handle: EngineInstanceHandle | undefined;
  #startedAt: number | undefined;
  #lastActivityAt: number | undefined;
  #activeLeases = 0;
  #failureReason: string | undefined;
  #evictionTask: ScheduledTask | undefined;
  #readinessTask: { recipeId: string; promise: Promise<void> } | undefined;
  readonly #preparationTasks = new Map<string, { promise: Promise<void>; controller: AbortController }>();

  constructor(options: LifecycleManagerOptions) {
    this.#adapters = options.adapters;
    this.events = options.events ?? new LifecycleEventBus();
    this.#clock = options.clock ?? new SystemClock();
    this.#allocatePort = options.allocatePort ?? (() => 19_000);
    this.resources = options.resources ?? new ResourceGovernor(new SystemResourceMonitor());
    this.thermalGuard = options.thermalGuard ?? new GpuThermalGuard(this.resources.monitor);
  }

  snapshot(): InstanceSnapshot {
    return {
      state: this.#state,
      activeLeases: this.#activeLeases,
      ...(this.#instanceId ? { id: this.#instanceId } : {}),
      ...(this.#recipe ? { recipeId: this.#recipe.id } : {}),
      ...(this.#startedAt !== undefined
        ? { startedAt: new Date(this.#startedAt).toISOString() }
        : {}),
      ...(this.#lastActivityAt !== undefined
        ? { lastActivityAt: new Date(this.#lastActivityAt).toISOString() }
        : {}),
      ...(this.#failureReason ? { failureReason: this.#failureReason } : {}),
    };
  }

  async *run(
    recipe: Recipe,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    await this.#ensureReady(recipe, signal);
    if (!this.#adapter || !this.#handle) throw new Error("Engine instance is not ready");
    if (isMediaEngineAdapter(this.#adapter)) {
      throw new Error(`Recipe ${recipe.id} uses a media engine adapter; runMedia is required`);
    }

    this.#cancelEviction();
    this.#activeLeases += 1;
    this.#transition("BUSY", "generation-started");
    try {
      for await (const delta of this.#adapter.streamChat(this.#handle, request, signal)) {
        this.#lastActivityAt = this.#clock.now();
        yield delta;
      }
    } catch (error) {
      if (!isAbortError(error)) {
        this.#failureReason = errorMessage(error);
        this.#transition("FAILED", "generation-failed");
      }
      throw error;
    } finally {
      this.#activeLeases = Math.max(0, this.#activeLeases - 1);
      this.#lastActivityAt = this.#clock.now();
      if (this.#state === "BUSY") {
        this.#transition("READY", signal.aborted ? "generation-cancelled" : "generation-completed");
        this.#scheduleEviction();
      }
    }
  }

  /** Job-oriented generation (submit/poll/cancel). A generation holds its lease
   *  until its terminal state; local media engines are evicted immediately after
   *  the lease ends so the next chat model can reclaim VRAM. */
  async *runMedia(
    recipe: Recipe,
    request: MediaGenerationRequest,
    signal: AbortSignal,
  ): AsyncIterable<MediaJobEvent> {
    await this.#ensureReady(recipe, signal);
    const adapter = this.#mediaAdapter(recipe);
    if (!this.#handle) throw new Error("Engine instance is not ready");
    const handle = this.#handle;
    const thermal = this.thermalGuard.start((adapter.executionLocation?.(recipe) ?? "local") === "local");

    this.#cancelEviction();
    this.#activeLeases += 1;
    this.#transition("BUSY", "media-generation-started");
    let job: MediaJobHandle | undefined;
    try {
      await thermal.regulate();
      job = await adapter.submit(handle, request, signal);
      // The provider job id is the durable link for restart recovery: the host
      // coordinator persists it so a follow-up can cancel orphaned cloud jobs
      // after a crash (design doc §5.3 restart recovery, PR 4).
      yield { type: "started", providerJobId: job.id };
      for (;;) {
        await thermal.regulate();
        const poll = await adapter.poll(handle, job, signal);
        if (poll.status === "completed" && poll.result) {
          yield { type: "completed", result: poll.result };
          return;
        }
        if (poll.status === "failed") throw new Error(poll.error ?? "Media generation failed");
        if (poll.status === "cancelled") throw abortError();
        if (poll.progress !== undefined) yield { type: "progress", progress: poll.progress };
        await abortableDelay(adapter.defaultPollIntervalMs ?? 1_000, signal);
      }
    } catch (error) {
      const thermalFailure = error instanceof ThermalSafetyError;
      if ((isAbortError(error) || thermalFailure) && job) {
        try {
          await adapter.cancel(handle, job); // best-effort provider cancel
        } catch {
          // Preserve the original abort error; provider cancel is best-effort.
        }
      }
      if (!isAbortError(error)) {
        this.#failureReason = errorMessage(error);
        this.#transition("FAILED", "media-generation-failed");
        if (thermalFailure) await this.#unloadAfterThermalFailure(adapter, handle);
      }
      throw error;
    } finally {
      await thermal.close();
      this.#activeLeases = Math.max(0, this.#activeLeases - 1);
      this.#lastActivityAt = this.#clock.now();
      if (this.#state === "BUSY") {
        this.#transition("READY", signal.aborted ? "generation-cancelled" : "generation-completed");
        this.#scheduleEviction();
      }
    }
  }

  async warm(recipe: Recipe, signal: AbortSignal = new AbortController().signal): Promise<InstanceSnapshot> {
    await this.#ensureReady(recipe, signal);
    this.#scheduleEviction();
    return this.snapshot();
  }

  async prepare(recipe: Recipe): Promise<void> {
    const key = preparationKey(recipe);
    const existing = this.#preparationTasks.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const task = this.#prepareRecipe(recipe, controller.signal);
    this.#preparationTasks.set(key, { promise: task, controller });
    try { await task; }
    catch (error) { this.#preparationTasks.delete(key); throw error; }
  }

  async cancelPreparations(): Promise<void> {
    const tasks = [...this.#preparationTasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.promise));
    this.#preparationTasks.clear();
  }

  async stop(reason = "manual-stop", mode: "graceful" | "force" = "graceful"): Promise<void> {
    this.#cancelEviction();
    if (this.#state === "UNLOADED") return;
    if (this.#state === "BUSY" && mode !== "force") {
      throw new Error("Cannot stop a busy instance without force mode");
    }

    if (this.#state === "BUSY" || this.#state === "PREPARING" || this.#state === "LOADING") {
      this.#failureReason = `Forced stop: ${reason}`;
      this.#transition("FAILED", reason);
    }
    if (this.#state === "READY") this.#transition("DRAINING", reason);
    if (this.#state !== "EVICTING") {
      this.#transition("EVICTING", reason);
    }

    if (this.#adapter && this.#handle) await this.#adapter.stop(this.#handle, mode);
    this.#clearInstance();
    this.#transition("UNLOADED", reason);
  }

  /** Media recipes must resolve to a MediaEngineAdapter; used only by runMedia. */
  #mediaAdapter(recipe: Recipe): MediaEngineAdapter {
    const adapter = this.#adapters.get(recipe.adapter);
    if (!isMediaEngineAdapter(adapter)) {
      throw new Error(`Recipe ${recipe.id} does not use a media engine adapter (${recipe.adapter})`);
    }
    return adapter;
  }

  async #ensureReady(recipe: Recipe, signal: AbortSignal): Promise<void> {
    this.#cancelEviction();
    if (this.#state === "READY" && this.#recipe?.id === recipe.id) return;
    if (this.#state === "BUSY") throw new Error("Lifecycle manager received concurrent generations");
    if (this.#readinessTask?.recipeId === recipe.id) return this.#readinessTask.promise;
    if (this.#readinessTask) await this.#readinessTask.promise;

    const promise = this.#loadRecipe(recipe, signal);
    this.#readinessTask = { recipeId: recipe.id, promise };
    try { await promise; }
    finally { if (this.#readinessTask?.promise === promise) this.#readinessTask = undefined; }
  }

  async #loadRecipe(recipe: Recipe, signal: AbortSignal): Promise<void> {
    try { await this.prepare(recipe); }
    catch {
      // Preparation is a latency optimization. A failed cache/runtime warm-up must
      // never prevent the adapter's normal cold activation path from running.
    }
    if (this.#state !== "UNLOADED" && this.#state !== "FAILED") {
      await this.stop("recipe-switch");
    } else if (this.#state === "FAILED") {
      if (this.#adapter && this.#handle) {
        await this.#adapter.stop(this.#handle, "force");
      }
      this.#clearInstance();
    }

    this.#recipe = recipe;
    this.#adapter = this.#adapters.get(recipe.adapter);
    this.#instanceId = randomUUID();
    this.#failureReason = undefined;
    this.#transition("PREPARING", "load-requested");

    try {
      const validation = await this.#adapter.validateRecipe(recipe);
      if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
      const estimate = await this.#adapter.estimateResources(recipe);
      await this.resources.assertCanLoad(recipe, estimate);
      const allocation = { host: "127.0.0.1", port: this.#allocatePort() };
      const spec = await this.#adapter.buildLaunchSpec(recipe, allocation);
      this.#transition("LOADING", "launching-engine");
      this.#handle = await this.#adapter.start(recipe, spec, signal);
      await this.#adapter.waitUntilReady(this.#handle, signal);
      this.#startedAt = this.#clock.now();
      this.#lastActivityAt = this.#startedAt;
      this.#transition("READY", "engine-ready");
    } catch (error) {
      this.#failureReason = errorMessage(error);
      if (this.#handle) {
        try {
          await this.#adapter.stop(this.#handle, "force");
        } catch {
          // Preserve the original startup error; cleanup diagnostics come later.
        }
        this.#handle = undefined;
      }
      if (this.#state !== "FAILED") this.#transition("FAILED", "load-failed");
      throw error;
    }
  }

  async #prepareRecipe(recipe: Recipe, signal: AbortSignal): Promise<void> {
    const adapter = this.#adapters.get(recipe.adapter);
    const validation = await adapter.validateRecipe(recipe);
    if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
    await adapter.prepare?.(recipe, signal);
  }

  /** A thermal stop is different from an ordinary provider failure: leaving a
   *  local model resident after its safety guard fired keeps the failed engine
   *  and its VRAM allocation alive without an eviction timer. Only report the
   *  instance as unloaded after the adapter confirms that its process stopped;
   *  otherwise retain FAILED + the handle so a later force-stop can retry. */
  async #unloadAfterThermalFailure(
    adapter: MediaEngineAdapter,
    handle: EngineInstanceHandle,
  ): Promise<void> {
    try {
      const report = await adapter.stop(handle, "force");
      if (!report.stopped) return;
    } catch {
      return;
    }
    this.#clearInstance();
    this.#transition("UNLOADED", "thermal-safety-eviction");
  }

  #scheduleEviction(): void {
    const recipe = this.#recipe;
    if (!recipe || !this.#adapter || this.#state !== "READY") return;
    const policy = recipe.lifecycle.evictionPolicy;
    const media = isMediaEngineAdapter(this.#adapter);
    if (!media && (policy === "never" || policy === "manual")) return;
    const idleDelay = media || policy === "immediate"
      ? 0
      : Math.min(recipe.lifecycle.idleTtlSeconds * 1_000, MAX_MODEL_IDLE_TTL_MS);
    const residencyRemaining = Math.max(
      0,
      Math.min(recipe.lifecycle.minimumResidencySeconds * 1_000, MAX_MODEL_IDLE_TTL_MS) -
        (this.#clock.now() - (this.#startedAt ?? this.#clock.now())),
    );
    this.#evictionTask = this.#clock.schedule(Math.max(idleDelay, residencyRemaining), async () => {
      if (this.#activeLeases === 0 && this.#state === "READY") {
        await this.stop("idle-ttl-expired");
      }
    });
  }

  #cancelEviction(): void {
    this.#evictionTask?.cancel();
    this.#evictionTask = undefined;
  }

  #transition(next: InstanceState, reason?: string): void {
    const previous = this.#state;
    assertTransition(previous, next);
    this.#state = next;
    this.events.instanceStateChanged({
      previousState: previous,
      state: next,
      ...(this.#instanceId ? { instanceId: this.#instanceId } : {}),
      ...(this.#recipe ? { recipeId: this.#recipe.id } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  #clearInstance(): void {
    this.#handle = undefined;
    this.#adapter = undefined;
    this.#recipe = undefined;
    this.#instanceId = undefined;
    this.#startedAt = undefined;
    this.#lastActivityAt = undefined;
    this.#activeLeases = 0;
    this.#failureReason = undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(handle);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preparationKey(recipe: Recipe): string {
  return JSON.stringify({ id: recipe.id, adapter: recipe.adapter, modelId: recipe.modelId, configuration: recipe.configuration });
}
