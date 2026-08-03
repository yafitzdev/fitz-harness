import { randomUUID } from "node:crypto";
import type {
  EngineAdapter,
  EngineInstanceHandle,
  InstanceInspection,
  PortAllocation,
  ReadyInfo,
  StopMode,
  StopReport,
} from "@fitz/inference-core";
import type {
  InferenceDelta,
  InferenceRequest,
  LaunchSpec,
  Recipe,
  ResourceEstimate,
  ValidationReport,
} from "@fitz/protocol";

export interface FakeEngineOptions {
  prepareDelayMs?: number;
  loadDelayMs?: number;
  tokenDelayMs?: number;
  responseFactory?: (request: InferenceRequest, recipe: Recipe) => string;
  failStart?: boolean;
  failPrepare?: boolean;
  failWhenPromptIncludes?: string;
}

export interface FakeInstanceHandle extends EngineInstanceHandle {
  modelId: string;
  stopped: boolean;
}

export class FakeEngineAdapter implements EngineAdapter<FakeInstanceHandle> {
  readonly id = "fake";
  readonly starts: FakeInstanceHandle[] = [];
  readonly preparations: string[] = [];
  readonly stops: Array<{ instanceId: string; mode: StopMode }> = [];
  readonly requests: InferenceRequest[] = [];
  readonly #options: Required<Pick<FakeEngineOptions, "prepareDelayMs" | "loadDelayMs" | "tokenDelayMs">> &
    Omit<FakeEngineOptions, "prepareDelayMs" | "loadDelayMs" | "tokenDelayMs">;

  constructor(options: FakeEngineOptions = {}) {
    this.#options = {
      prepareDelayMs: options.prepareDelayMs ?? 0,
      loadDelayMs: options.loadDelayMs ?? 0,
      tokenDelayMs: options.tokenDelayMs ?? 0,
      ...(options.responseFactory ? { responseFactory: options.responseFactory } : {}),
      ...(options.failStart !== undefined ? { failStart: options.failStart } : {}),
      ...(options.failPrepare !== undefined ? { failPrepare: options.failPrepare } : {}),
      ...(options.failWhenPromptIncludes
        ? { failWhenPromptIncludes: options.failWhenPromptIncludes }
        : {}),
    };
  }

  async prepare(recipe: Recipe, signal: AbortSignal): Promise<void> {
    await abortableDelay(this.#options.prepareDelayMs, signal);
    if (this.#options.failPrepare) throw new Error("Fake engine configured preparation failure");
    this.preparations.push(recipe.id);
  }

  async validateRecipe(recipe: Recipe): Promise<ValidationReport> {
    const issues = [];
    if (recipe.adapter !== this.id) {
      issues.push({
        level: "error" as const,
        code: "adapter_mismatch",
        message: `Recipe adapter must be ${this.id}`,
      });
    }
    if (recipe.contextTokens < 1) {
      issues.push({
        level: "error" as const,
        code: "invalid_context",
        message: "Recipe contextTokens must be positive",
      });
    }
    return { valid: issues.length === 0, issues };
  }

  async estimateResources(_recipe: Recipe): Promise<ResourceEstimate> {
    return { vramMiB: 0, ramMiB: 16 };
  }

  async buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec> {
    return {
      executable: "fitz-fake-engine",
      args: ["--model", recipe.modelId, "--port", String(allocation.port)],
      env: {},
      internalHost: allocation.host,
      internalPort: allocation.port,
    };
  }

  async start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<FakeInstanceHandle> {
    await abortableDelay(this.#options.loadDelayMs, signal);
    if (this.#options.failStart) throw new Error("Fake engine configured to fail startup");
    const handle: FakeInstanceHandle = {
      id: randomUUID(),
      recipeId: recipe.id,
      modelId: recipe.modelId,
      baseUrl: `http://${spec.internalHost}:${spec.internalPort}`,
      startedAt: new Date(),
      stopped: false,
    };
    this.starts.push(handle);
    return handle;
  }

  async waitUntilReady(instance: FakeInstanceHandle, signal: AbortSignal): Promise<ReadyInfo> {
    if (signal.aborted) throw abortError();
    return { modelId: instance.modelId, baseUrl: instance.baseUrl };
  }

  async *streamChat(
    instance: FakeInstanceHandle,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta> {
    if (instance.stopped) throw new Error("Fake engine instance is stopped");
    this.requests.push(structuredClone(request));
    const prompt = request.messages.map((message) => message.content).join("\n");
    if (
      this.#options.failWhenPromptIncludes &&
      prompt.includes(this.#options.failWhenPromptIncludes)
    ) {
      throw new Error("Fake engine configured request failure");
    }

    const response =
      this.#options.responseFactory?.(request, recipeFromHandle(instance)) ??
      `Fake response from ${instance.modelId}: ${lastUserText(request)}`;
    const tokens = response.match(/\S+\s*/g) ?? [];
    let completionTokens = 0;
    for (const token of tokens) {
      await abortableDelay(this.#options.tokenDelayMs, signal);
      completionTokens += 1;
      yield { text: token };
    }
    yield {
      text: "",
      finishReason: "stop",
      promptTokens: approximateTokens(prompt),
      completionTokens,
    };
  }

  async stop(instance: FakeInstanceHandle, mode: StopMode): Promise<StopReport> {
    instance.stopped = true;
    this.stops.push({ instanceId: instance.id, mode });
    return { stopped: true };
  }

  async inspect(instance: FakeInstanceHandle): Promise<InstanceInspection> {
    return {
      healthy: !instance.stopped,
      modelId: instance.modelId,
      ...(instance.stopped ? { detail: "stopped" } : {}),
    };
  }
}

function lastUserText(request: InferenceRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function recipeFromHandle(instance: FakeInstanceHandle): Recipe {
  return {
    id: instance.recipeId,
    playbookId: "fake",
    displayName: instance.modelId,
    adapter: "fake",
    modelId: instance.modelId,
    contextTokens: 100_000,
    capabilities: {
      chatCompletions: true,
      streaming: true,
      toolCalls: false,
      responseFormat: false,
      minP: false,
      maxConcurrentGenerations: 1,
    },
    lifecycle: {
      loadPolicy: "onDemand",
      evictionPolicy: "idle-ttl",
      idleTtlSeconds: 60,
      minimumResidencySeconds: 0,
    },
    configuration: {},
  };
}

function approximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
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

function abortError(): Error {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
