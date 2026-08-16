import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  InferenceDelta,
  InferenceRequest,
  InstanceSnapshot,
  InstanceState,
  MediaGenerationRequest,
  MediaJobEvent,
  Recipe,
  ResolvedAgentTopology,
} from "@fitz/protocol";
import { resolveLocalAgentTopology } from "@fitz/protocol";
import type { EngineAdapter, EngineInstanceHandle, MediaEngineAdapter, MediaJobHandle } from "./adapter.js";
import { EngineAdapterRegistry, InferenceRequestRejectedError, isMediaEngineAdapter } from "./adapter.js";
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

export interface LifecycleRunHooks {
  /** Fires after the model is ready and immediately before the adapter request. */
  onInferenceStarted?: () => void;
}

export class LifecycleManager {
  readonly events: LifecycleEventBus;
  readonly resources: ResourceGovernor;
  readonly thermalGuard: GpuThermalGuard;
  readonly adapters: EngineAdapterRegistry;
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
  #loadedSharedContextTokens: number | undefined;
  #pinnedRecipe: Recipe | undefined;
  #evictionTask: ScheduledTask | undefined;
  #admissionTail: Promise<void> = Promise.resolve();
  readonly #leaseWaiters = new Set<() => void>();
  readonly #preparationTasks = new Map<string, { promise: Promise<void>; controller: AbortController }>();

  constructor(options: LifecycleManagerOptions) {
    this.adapters = options.adapters;
    this.events = options.events ?? new LifecycleEventBus();
    this.#clock = options.clock ?? new SystemClock();
    this.#allocatePort = options.allocatePort ?? sequentialPortAllocator();
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
      ...(this.#recipe && this.#adapter && !isMediaEngineAdapter(this.#adapter)
        ? { localAgentTopology: this.localAgentTopology(this.#recipe) }
        : {}),
    };
  }

  /** Engine-neutral, bounded diagnostics for the currently loaded instance.
   * Adapters that expose their standard in-memory log ring and child-process
   * handle are captured without the scheduler knowing an engine name. Secrets
   * such as the per-instance API key are removed before persistence. */
  diagnostics(): Record<string, unknown> {
    return collectInstanceDiagnostics(this.#handle);
  }

  /** Resolved local topology for UI, context preparation, and worker admission.
   * Loaded engine capacity wins; before load the recipe declaration provides a
   * stable preview of the topology that will be requested. */
  localAgentTopology(recipe: Recipe): ResolvedAgentTopology {
    const loadedCapacity = this.#recipe && sameRuntimeRecipe(this.#recipe, recipe)
      ? this.#loadedSharedContextTokens
      : undefined;
    return resolveLocalAgentTopology(recipe, loadedCapacity);
  }

  residencySnapshot(): Record<string, unknown> {
    const pinned = this.#pinnedRecipe;
    const active = this.#recipe;
    return {
      algorithm: "single-local-default-v1",
      ...(pinned ? {
        pinned: {
          recipeId: pinned.id,
          modelId: pinned.modelId,
          adapter: pinned.adapter,
          state: active && sameRuntimeRecipe(active, pinned) ? this.#state.toLowerCase() : "displaced",
        },
      } : {}),
      ...(active ? { active: { recipeId: active.id, modelId: active.modelId, adapter: active.adapter, state: this.#state.toLowerCase() } } : {}),
    };
  }

  /** Declare the host-owned local Default. Pinning changes desired state only;
   * callers enqueue a normal GPU warm job so route changes remain instant. */
  pin(recipe: Recipe): void {
    const adapter = this.adapters.get(recipe.adapter);
    if (isMediaEngineAdapter(adapter) || (adapter.executionLocation?.(recipe) ?? "local") !== "local") {
      throw new TypeError("The Default route must use a local text engine");
    }
    this.#pinnedRecipe = structuredClone(recipe);
  }

  pinnedRecipe(): Recipe | undefined {
    return this.#pinnedRecipe ? structuredClone(this.#pinnedRecipe) : undefined;
  }

  async restorePinned(signal: AbortSignal = new AbortController().signal): Promise<InstanceSnapshot> {
    if (!this.#pinnedRecipe) return this.snapshot();
    await this.#ensureReady(this.#pinnedRecipe, signal);
    return this.snapshot();
  }

  async *run(
    recipe: Recipe,
    request: InferenceRequest,
    signal: AbortSignal,
    hooks: LifecycleRunHooks = {},
  ): AsyncIterable<InferenceDelta> {
    const { adapter, handle } = await this.#acquireLease(recipe, signal);
    if (isMediaEngineAdapter(adapter)) {
      await this.#releaseLease(false, signal.aborted ? "generation-cancelled" : "generation-rejected");
      throw new Error(`Recipe ${recipe.id} uses a media engine adapter; runMedia is required`);
    }
    hooks.onInferenceStarted?.();
    let requestRejected = false;
    let generationFailed = false;
    try {
      for await (const delta of adapter.streamChat(handle, request, signal)) {
        this.#lastActivityAt = this.#clock.now();
        yield delta;
      }
    } catch (error) {
      requestRejected = error instanceof InferenceRequestRejectedError;
      generationFailed = !isAbortError(error) && !requestRejected;
      if (generationFailed) this.#failureReason = errorMessage(error);
      throw error;
    } finally {
      await this.#releaseLease(generationFailed, signal.aborted
        ? "generation-cancelled"
        : requestRejected ? "generation-rejected" : generationFailed ? "generation-failed" : "generation-completed");
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
    const lease = await this.#acquireLease(recipe, signal);
    const adapter = this.#mediaAdapter(recipe, lease.adapter);
    const handle = lease.handle;
    const thermal = this.thermalGuard.start((adapter.executionLocation?.(recipe) ?? "local") === "local");
    let job: MediaJobHandle | undefined;
    let generationFailed = false;
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
        generationFailed = true;
        this.#failureReason = errorMessage(error);
        if (thermalFailure) await this.#unloadAfterThermalFailure(adapter, handle);
      }
      throw error;
    } finally {
      await thermal.close();
      await this.#releaseLease(generationFailed, signal.aborted
        ? "generation-cancelled"
        : generationFailed ? "media-generation-failed" : "generation-completed");
    }
  }

  async warm(recipe: Recipe, signal: AbortSignal = new AbortController().signal): Promise<InstanceSnapshot> {
    await this.#ensureReady(recipe, signal);
    this.#scheduleEviction();
    return this.snapshot();
  }

  async #acquireLease(recipe: Recipe, signal: AbortSignal): Promise<{ adapter: EngineAdapter | MediaEngineAdapter; handle: EngineInstanceHandle }> {
    for (;;) {
      let wait: Promise<void> | undefined;
      const lease = await this.#withAdmissionLock(async () => {
        if (signal.aborted) throw abortError();
        this.#cancelEviction();
        const sameRecipe = sameRuntimeRecipe(this.#recipe, recipe);
        if (this.#state === "BUSY") {
          if (!sameRecipe || this.#activeLeases >= recipe.capabilities.maxConcurrentGenerations) {
            wait = this.#waitForLeaseChange(signal);
            return undefined;
          }
        } else if (this.#state !== "READY" || !sameRecipe) {
          await this.#loadRecipe(recipe, signal);
        }
        if (!this.#adapter || !this.#handle || (this.#state !== "READY" && this.#state !== "BUSY")) {
          throw new Error("Engine instance is not ready");
        }
        const firstLease = this.#activeLeases === 0;
        this.#activeLeases += 1;
        if (firstLease) this.#transition("BUSY", isMediaEngineAdapter(this.#adapter) ? "media-generation-started" : "generation-started");
        return { adapter: this.#adapter, handle: this.#handle };
      });
      if (lease) return lease;
      await wait;
    }
  }

  async #releaseLease(failed: boolean, reason: string): Promise<void> {
    await this.#withAdmissionLock(async () => {
      this.#activeLeases = Math.max(0, this.#activeLeases - 1);
      this.#lastActivityAt = this.#clock.now();
      if (this.#activeLeases === 0) {
        if (this.#state === "BUSY") {
          if (failed) this.#transition("FAILED", reason);
          else {
            this.#failureReason = undefined;
            this.#transition("READY", reason);
            this.#scheduleEviction();
          }
        }
        this.#notifyLeaseWaiters();
      }
    });
  }

  async #withAdmissionLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const predecessor = this.#admissionTail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    this.#admissionTail = predecessor.catch(() => undefined).then(() => slot);
    await predecessor.catch(() => undefined);
    try { return await operation(); }
    finally { release(); }
  }

  #waitForLeaseChange(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const changed = () => { signal.removeEventListener("abort", aborted); this.#leaseWaiters.delete(changed); resolve(); };
      const aborted = () => { this.#leaseWaiters.delete(changed); reject(abortError()); };
      this.#leaseWaiters.add(changed);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  #notifyLeaseWaiters(): void {
    for (const notify of [...this.#leaseWaiters]) notify();
  }

  async prepare(recipe: Recipe, signal?: AbortSignal): Promise<void> {
    const key = preparationKey(recipe);
    const existing = this.#preparationTasks.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const task = this.#prepareRecipe(recipe, controller.signal);
    this.#preparationTasks.set(key, { promise: task, controller });
    try { await task; }
    catch (error) { this.#preparationTasks.delete(key); throw error; }
    finally { signal?.removeEventListener("abort", abort); }
  }

  async cancelPreparations(): Promise<void> {
    const tasks = [...this.#preparationTasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.promise));
    this.#preparationTasks.clear();
  }

  async stop(reason = "manual-stop", mode: "graceful" | "force" = "graceful"): Promise<void> {
    await this.#withAdmissionLock(() => this.#stopUnlocked(reason, mode));
  }

  async #stopUnlocked(reason: string, mode: "graceful" | "force"): Promise<void> {
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
    this.#notifyLeaseWaiters();
  }

  /** Media recipes must resolve to a MediaEngineAdapter; used only by runMedia. */
  #mediaAdapter(recipe: Recipe, adapter = this.adapters.get(recipe.adapter)): MediaEngineAdapter {
    if (!isMediaEngineAdapter(adapter)) {
      throw new Error(`Recipe ${recipe.id} does not use a media engine adapter (${recipe.adapter})`);
    }
    return adapter;
  }

  async #ensureReady(recipe: Recipe, signal: AbortSignal): Promise<void> {
    for (;;) {
      let wait: Promise<void> | undefined;
      const ready = await this.#withAdmissionLock(async () => {
        this.#cancelEviction();
        if ((this.#state === "READY" || this.#state === "BUSY") && sameRuntimeRecipe(this.#recipe, recipe)) return true;
        if (this.#state === "BUSY") {
          wait = this.#waitForLeaseChange(signal);
          return false;
        }
        await this.#loadRecipe(recipe, signal);
        return true;
      });
      if (ready) return;
      await wait;
    }
  }

  async #loadRecipe(recipe: Recipe, signal: AbortSignal): Promise<void> {
    await this.#cancelPreparationsExcept(recipe);
    try { await this.prepare(recipe); }
    catch {
      // Preparation is a latency optimization. A failed cache/runtime warm-up must
      // never prevent the adapter's normal cold activation path from running.
    }
    if (this.#state !== "UNLOADED" && this.#state !== "FAILED") {
      await this.#stopUnlocked("recipe-switch", "graceful");
    } else if (this.#state === "FAILED") {
      if (this.#adapter && this.#handle) {
        await this.#adapter.stop(this.#handle, "force");
      }
      this.#clearInstance();
    }

    this.#recipe = recipe;
    this.#adapter = this.adapters.get(recipe.adapter);
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
      const reportedCapacity = isMediaEngineAdapter(this.#adapter)
        ? undefined
        : await this.#adapter.contextCapacity?.(this.#handle, recipe);
      this.#loadedSharedContextTokens = Number.isSafeInteger(reportedCapacity) && Number(reportedCapacity) > 0
        ? reportedCapacity
        : recipe.contextTokens;
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
    const adapter = this.adapters.get(recipe.adapter);
    const validation = await adapter.validateRecipe(recipe);
    if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
    await adapter.prepare?.(recipe, signal);
  }

  async #cancelPreparationsExcept(recipe: Recipe): Promise<void> {
    const keep = preparationKey(recipe);
    const cancelled = [...this.#preparationTasks.entries()].filter(([key]) => key !== keep);
    for (const [, task] of cancelled) task.controller.abort();
    await Promise.allSettled(cancelled.map(([, task]) => task.promise));
    for (const [key] of cancelled) this.#preparationTasks.delete(key);
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
    await this.#withAdmissionLock(async () => {
      if (this.#state === "BUSY") this.#transition("FAILED", "media-generation-failed");
      try {
        const report = await adapter.stop(handle, "force");
        if (!report.stopped) return;
      } catch {
        return;
      }
      this.#clearInstance();
      this.#transition("UNLOADED", "thermal-safety-eviction");
      this.#notifyLeaseWaiters();
    });
  }

  #scheduleEviction(): void {
    const recipe = this.#recipe;
    if (!recipe || !this.#adapter || this.#state !== "READY") return;
    const policy = recipe.lifecycle.evictionPolicy;
    const media = isMediaEngineAdapter(this.#adapter);
    if (!media && this.#pinnedRecipe && sameRuntimeRecipe(recipe, this.#pinnedRecipe)) return;
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
        await this.#withAdmissionLock(() => this.#stopUnlocked("idle-ttl-expired", "graceful"));
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
    this.#loadedSharedContextTokens = undefined;
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

function collectInstanceDiagnostics(handle: EngineInstanceHandle | undefined): Record<string, unknown> {
  if (!handle || typeof handle !== "object") return {};
  const value = handle as unknown as Record<string, unknown>;
  const secret = typeof value.apiKey === "string" && value.apiKey.length > 0 ? value.apiKey : undefined;
  const logs = Array.isArray(value.logs)
    ? value.logs.filter((line): line is string => typeof line === "string").slice(-500).map((line) => secret ? line.replaceAll(secret, "[REDACTED]") : line)
    : undefined;
  const process = value.process;
  const processRecord = process && typeof process === "object" ? process as Record<string, unknown> : undefined;
  const processState = processRecord ? {
    ...(typeof processRecord.pid === "number" ? { pid: processRecord.pid } : {}),
    ...(processRecord.exitCode === null || typeof processRecord.exitCode === "number" ? { exitCode: processRecord.exitCode } : {}),
    ...(processRecord.signalCode === null || typeof processRecord.signalCode === "string" ? { signalCode: processRecord.signalCode } : {}),
  } : undefined;
  const guestProcess = value.guestProcess;
  const guestRecord = guestProcess && typeof guestProcess === "object" ? guestProcess as Record<string, unknown> : undefined;
  const guestState = guestRecord ? {
    ...(typeof guestRecord.pid === "number" ? { pid: guestRecord.pid } : {}),
    ...(typeof guestRecord.distribution === "string" ? { distribution: guestRecord.distribution } : {}),
  } : undefined;
  return {
    ...(logs?.length ? { logs } : {}),
    ...(processState && Object.keys(processState).length ? { process: processState } : {}),
    ...(guestState && Object.keys(guestState).length ? { guestProcess: guestState } : {}),
  };
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
  return runtimeRecipeKey(recipe);
}

function sameRuntimeRecipe(current: Recipe | undefined, requested: Recipe): boolean {
  return current !== undefined
    && current.id === requested.id
    && current.adapter === requested.adapter
    && current.modelId === requested.modelId
    && current.contextTokens === requested.contextTokens
    && isDeepStrictEqual(current.configuration, requested.configuration);
}

function runtimeRecipeKey(recipe: Recipe): string {
  return JSON.stringify({
    id: recipe.id,
    adapter: recipe.adapter,
    modelId: recipe.modelId,
    contextTokens: recipe.contextTokens,
    configuration: recipe.configuration,
  });
}

function sequentialPortAllocator(first = 19_000, last = 19_999): () => number {
  let next = first;
  return () => {
    const allocated = next;
    next = next >= last ? first : next + 1;
    return allocated;
  };
}
