import { randomUUID } from "node:crypto";
import type { InferenceDelta, InferenceRequest } from "@fitz/protocol";
import { AsyncChannel } from "./async-channel.js";
import { LifecycleEventBus } from "./event-bus.js";
import { LifecycleManager } from "./lifecycle-manager.js";
import { RouteResolver } from "./route-resolver.js";

interface QueueJob {
  id: string;
  routeId: string;
  recipeId?: string;
  unloadAfterCompletion?: boolean;
  request: InferenceRequest;
  output: AsyncChannel<InferenceDelta>;
  controller: AbortController;
  detachExternalAbort?: () => void;
}

export interface ScheduledStream extends AsyncIterable<InferenceDelta> {
  requestId: string;
  cancel(): void;
}

export interface RecipeEnqueueOptions {
  unloadAfterCompletion?: boolean;
}

export class InferenceScheduler {
  readonly #queue: QueueJob[] = [];
  #processing = false;
  #accepting = true;
  #active: QueueJob | undefined;
  readonly #idleWaiters: Array<() => void> = [];

  constructor(
    readonly routes: RouteResolver,
    readonly lifecycle: LifecycleManager,
    readonly events: LifecycleEventBus = lifecycle.events,
  ) {}

  get queueDepth(): number {
    return this.#queue.length + (this.#active ? 1 : 0);
  }

  enqueue(
    routeId: string,
    input: Omit<InferenceRequest, "id" | "routeId">,
    externalSignal?: AbortSignal,
  ): ScheduledStream {
    return this.#enqueue(routeId, input, externalSignal);
  }

  enqueueRecipe(
    recipeId: string,
    input: Omit<InferenceRequest, "id" | "routeId">,
    externalSignal?: AbortSignal,
    options: RecipeEnqueueOptions = {},
  ): ScheduledStream {
    this.routes.resolveRecipe(recipeId);
    return this.#enqueue(`recipe:${recipeId}`, input, externalSignal, recipeId, options.unloadAfterCompletion);
  }

  #enqueue(
    routeId: string,
    input: Omit<InferenceRequest, "id" | "routeId">,
    externalSignal?: AbortSignal,
    recipeId?: string,
    unloadAfterCompletion?: boolean,
  ): ScheduledStream {
    const id = randomUUID();
    const output = new AsyncChannel<InferenceDelta>();
    const controller = new AbortController();
    const request: InferenceRequest = { ...input, id, routeId };
    const job: QueueJob = {
      id,
      routeId,
      request,
      output,
      controller,
      ...(recipeId ? { recipeId } : {}),
      ...(unloadAfterCompletion ? { unloadAfterCompletion: true } : {}),
    };

    if (!this.#accepting) {
      output.fail(new Error("Inference scheduler is shutting down"));
      return Object.assign(output, { requestId: id, cancel: () => undefined });
    }

    if (externalSignal) {
      const abort = () => this.#cancel(job);
      if (externalSignal.aborted) abort();
      else {
        externalSignal.addEventListener("abort", abort, { once: true });
        job.detachExternalAbort = () => externalSignal.removeEventListener("abort", abort);
      }
    }

    if (!controller.signal.aborted) {
      this.#queue.push(job);
      this.#publishQueue(job, "queued", this.#queue.length);
      this.#publishQueuedPositions();
      void this.#pump();
    }

    return Object.assign(output, {
      requestId: id,
      cancel: () => this.#cancel(job),
    });
  }

  async shutdown(): Promise<void> {
    this.#accepting = false;
    for (const job of [...this.#queue]) this.#cancel(job);
    this.#active?.controller.abort();
    await this.#waitUntilIdle();
    await this.lifecycle.stop("host-shutdown", "force");
  }

  #cancel(job: QueueJob): void {
    if (job.controller.signal.aborted) return;
    job.controller.abort();
    const index = this.#queue.indexOf(job);
    if (index >= 0) {
      this.#queue.splice(index, 1);
      const error = abortError();
      job.output.fail(error);
      job.detachExternalAbort?.();
      this.#publishQueue(job, "cancelled", 0);
      this.#publishQueuedPositions();
    } else if (this.#active !== job) {
      job.output.fail(abortError());
      job.detachExternalAbort?.();
      this.#publishQueue(job, "cancelled", 0);
    }
  }

  async #pump(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift();
        if (!job) continue;
        if (job.controller.signal.aborted) continue;
        this.#active = job;
        this.#publishQueue(job, "started", 0);
        this.#publishQueuedPositions();

        try {
          const recipe = job.recipeId ? this.routes.resolveRecipe(job.recipeId) : this.routes.resolve(job.routeId).recipe;
          for await (const delta of this.lifecycle.run(recipe, job.request, job.controller.signal)) {
            job.output.push(delta);
          }
          if (job.unloadAfterCompletion) await this.lifecycle.stop(`recipe-test:${recipe.id}`, "graceful");
          job.output.close();
          this.#publishQueue(job, "completed", 0);
        } catch (error) {
          job.output.fail(error);
          this.#publishQueue(job, job.controller.signal.aborted ? "cancelled" : "failed", 0);
        } finally {
          job.detachExternalAbort?.();
          this.#active = undefined;
        }
      }
    } finally {
      this.#processing = false;
      if (this.#queue.length > 0) void this.#pump();
      else for (const resolve of this.#idleWaiters.splice(0)) resolve();
    }
  }

  async #waitUntilIdle(): Promise<void> {
    if (!this.#processing && !this.#active) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #publishQueuedPositions(): void {
    this.#queue.forEach((job, index) => this.#publishQueue(job, "queued", index + 1));
  }

  #publishQueue(
    job: QueueJob,
    status: "queued" | "started" | "cancelled" | "completed" | "failed",
    position: number,
  ): void {
    this.events.queueUpdated({
      requestId: job.id,
      routeId: job.routeId,
      position,
      depth: this.queueDepth,
      status,
    });
  }
}

function abortError(): Error {
  const error = new Error("Inference request was cancelled");
  error.name = "AbortError";
  return error;
}
