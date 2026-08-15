import { LOCAL_MAIN_CONTEXT_TOKENS, LOCAL_MAX_CONCURRENT_AGENTS, type Recipe } from "@fitz/protocol";

/** Host-wide local inference capacity. The scheduler has three GPU lanes, so
 * every tool-capable local chat engine exposes one main agent plus two workers. */
export function withLocalAgentCapacity(recipe: Recipe): Recipe {
  if (!recipe.capabilities.chatCompletions || !recipe.capabilities.toolCalls) return recipe;
  const normalized = {
    ...recipe,
    capabilities: { ...recipe.capabilities, maxConcurrentGenerations: LOCAL_MAX_CONCURRENT_AGENTS },
  };
  if (normalized.adapter === "ninfer") {
    return { ...normalized, configuration: { ...normalized.configuration, maxContext: Math.min(LOCAL_MAIN_CONTEXT_TOKENS, normalized.contextTokens) } };
  }
  if (normalized.adapter !== "openai-managed" || !Array.isArray(normalized.configuration.args)) return normalized;
  const args = normalized.configuration.args.filter((argument): argument is string => typeof argument === "string");
  if (normalized.playbookId === "llama.cpp") {
    return { ...normalized, configuration: { ...normalized.configuration, args: withOption(withOption(args, "--parallel", LOCAL_MAX_CONCURRENT_AGENTS), "--ctx-size", normalized.contextTokens) } };
  }
  if (normalized.playbookId === "vllm") {
    return { ...normalized, configuration: { ...normalized.configuration, args: withOption(withOption(args, "--max-num-seqs", LOCAL_MAX_CONCURRENT_AGENTS), "--max-model-len", Math.min(LOCAL_MAIN_CONTEXT_TOKENS, normalized.contextTokens)) } };
  }
  return normalized;
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
