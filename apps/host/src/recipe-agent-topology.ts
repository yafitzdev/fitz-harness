import {
  resolveRecipeAgentTopology,
  validateRecipeAgentTopology,
  type Recipe,
  type RecipeAgentTopology,
} from "@fitz/protocol";

/** Validates the recipe-owned worker pool and compiles its implicit main-agent
 * context into adapter launch configuration. The topology remains the source
 * of truth; users never edit a separate main-agent context value. */
export function compileRecipeAgentTopology(recipe: Recipe): Recipe {
  const error = validateRecipeAgentTopology(recipe).find((issue) => issue.level === "error");
  if (error) throw new TypeError(error.message);
  if (!recipe.agentTopology) return recipe;
  const resolved = resolveRecipeAgentTopology(recipe);
  if (recipe.adapter === "ninfer") {
    return {
      ...recipe,
      configuration: {
        ...recipe.configuration,
        maxContext: resolved.orchestratorContextTokens,
      },
    };
  }
  if (recipe.adapter === "openai-managed" && Array.isArray(recipe.configuration.args)) {
    const args = recipe.configuration.args.filter((argument): argument is string => typeof argument === "string");
    if (recipe.playbookId === "llama.cpp") {
      return {
        ...recipe,
        configuration: {
          ...recipe.configuration,
          args: withOption(withOption(args, "--parallel", recipe.capabilities.maxConcurrentGenerations), "--ctx-size", resolved.sharedContextTokens),
        },
      };
    }
    if (recipe.playbookId === "vllm") {
      const largestAgentContext = Math.max(resolved.orchestratorContextTokens, resolved.workerCount > 0 ? resolved.workerContextTokens : 0);
      return {
        ...recipe,
        configuration: {
          ...recipe.configuration,
          args: withOption(withOption(args, "--max-num-seqs", recipe.capabilities.maxConcurrentGenerations), "--max-model-len", largestAgentContext),
        },
      };
    }
  }
  return recipe;
}

function withOption(args: string[], option: string, value: number): string[] {
  const next = [...args];
  const index = next.findIndex((argument) => argument === option || argument.startsWith(`${option}=`));
  if (index < 0) return [...next, option, String(value)];
  if (next[index]!.includes("=")) next[index] = `${option}=${value}`;
  else if (index + 1 < next.length) next[index + 1] = String(value);
  else next.push(String(value));
  return next;
}

export function parseRecipeAgentTopology(value: unknown): RecipeAgentTopology | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("agentTopology must be an object");
  const topology = value as Record<string, unknown>;
  const workers = topology.workers;
  if (!workers || typeof workers !== "object" || Array.isArray(workers)) throw new TypeError("agentTopology.workers must be an object");
  const workerPool = workers as Record<string, unknown>;
  const capacityMode = topology.capacityMode === undefined ? "shared" : topology.capacityMode;
  if (capacityMode !== "shared" && capacityMode !== "independent") {
    throw new TypeError("agentTopology.capacityMode must be shared or independent");
  }
  return {
    capacityMode,
    sharedContextTokens: integer(topology.sharedContextTokens, "agentTopology.sharedContextTokens"),
    workers: {
      count: integer(workerPool.count, "agentTopology.workers.count", true),
      contextTokens: integer(workerPool.contextTokens, "agentTopology.workers.contextTokens"),
    },
  };
}

function integer(value: unknown, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw new TypeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return Number(value);
}
