import { randomUUID } from "node:crypto";
import type {
  InferenceDelta,
  InferenceRequest,
  InstanceSnapshot,
  InstanceState,
  Recipe,
} from "@fitz/protocol";
import type { EngineAdapter, EngineInstanceHandle } from "./adapter.js";
import { EngineAdapterRegistry } from "./adapter.js";
import type { Clock, ScheduledTask } from "./clock.js";
import { SystemClock } from "./clock.js";
import { LifecycleEventBus } from "./event-bus.js";
import { assertTransition } from "./state-machine.js";

export interface LifecycleManagerOptions {
  adapters: EngineAdapterRegistry;
  events?: LifecycleEventBus;
  clock?: Clock;
  allocatePort?: () => number;
}

export class LifecycleManager {
  readonly events: LifecycleEventBus;
  readonly #adapters: EngineAdapterRegistry;
  readonly #clock: Clock;
  readonly #allocatePort: () => number;
  #state: InstanceState = "UNLOADED";
  #instanceId: string | undefined;
  #recipe: Recipe | undefined;
  #adapter: EngineAdapter | undefined;
  #handle: EngineInstanceHandle | undefined;
  #startedAt: number | undefined;
  #lastActivityAt: number | undefined;
  #activeLeases = 0;
  #failureReason: string | undefined;
  #evictionTask: ScheduledTask | undefined;

  constructor(options: LifecycleManagerOptions) {
    this.#adapters = options.adapters;
    this.events = options.events ?? new LifecycleEventBus();
    this.#clock = options.clock ?? new SystemClock();
    this.#allocatePort = options.allocatePort ?? (() => 19_000);
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

  async #ensureReady(recipe: Recipe, signal: AbortSignal): Promise<void> {
    this.#cancelEviction();
    if (this.#state === "READY" && this.#recipe?.id === recipe.id) return;
    if (this.#state === "BUSY") throw new Error("Lifecycle manager received concurrent generations");

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
      if (!validation.valid) {
        throw new Error(validation.issues.map((issue) => issue.message).join("; "));
      }
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

  #scheduleEviction(): void {
    const recipe = this.#recipe;
    if (!recipe || this.#state !== "READY") return;
    const policy = recipe.lifecycle.evictionPolicy;
    if (policy === "never" || policy === "manual") return;

    const idleDelay = policy === "immediate" ? 0 : recipe.lifecycle.idleTtlSeconds * 1_000;
    const residencyRemaining = Math.max(
      0,
      recipe.lifecycle.minimumResidencySeconds * 1_000 -
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
