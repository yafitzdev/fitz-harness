import type {
  InferenceDelta,
  InferenceRequest,
  LaunchSpec,
  Recipe,
  ResourceEstimate,
  ValidationReport,
} from "@fitz/protocol";

export interface PortAllocation {
  host: string;
  port: number;
}

export interface EngineInstanceHandle {
  id: string;
  recipeId: string;
  baseUrl: string;
  startedAt: Date;
}

export interface ReadyInfo {
  modelId: string;
  baseUrl: string;
}

export interface InstanceInspection {
  healthy: boolean;
  modelId?: string;
  detail?: string;
}

export type StopMode = "graceful" | "force";

export interface StopReport {
  stopped: boolean;
  detail?: string;
}

export interface EngineAdapter<THandle extends EngineInstanceHandle = EngineInstanceHandle> {
  readonly id: string;
  validateRecipe(recipe: Recipe): Promise<ValidationReport>;
  estimateResources(recipe: Recipe): Promise<ResourceEstimate>;
  buildLaunchSpec(recipe: Recipe, allocation: PortAllocation): Promise<LaunchSpec>;
  start(recipe: Recipe, spec: LaunchSpec, signal: AbortSignal): Promise<THandle>;
  waitUntilReady(instance: THandle, signal: AbortSignal): Promise<ReadyInfo>;
  streamChat(
    instance: THandle,
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceDelta>;
  stop(instance: THandle, mode: StopMode): Promise<StopReport>;
  inspect(instance: THandle): Promise<InstanceInspection>;
}

export class EngineAdapterRegistry {
  readonly #adapters = new Map<string, EngineAdapter>();

  constructor(adapters: EngineAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: EngineAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Engine adapter already registered: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(id: string): EngineAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`Unknown engine adapter: ${id}`);
    return adapter;
  }

  list(): EngineAdapter[] {
    return [...this.#adapters.values()];
  }
}
