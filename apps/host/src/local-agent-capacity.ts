import { LOCAL_MAIN_CONTEXT_TOKENS, LOCAL_MAX_CONCURRENT_AGENTS, type Recipe } from "@fitz/protocol";

// BF16 KV is roughly twice the size of q8 KV. This tier keeps the native-MTP
// Qwen profile inside a 32 GB card while honoring Fitz's configured VRAM reserve.
const LLAMA_CPP_NATIVE_MTP_BF16_CONTEXT_TOKENS = 98_304;

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
    // llama.cpp normally divides --ctx-size equally between --parallel slots.
    // Fitz's local topology is a shared pool (one main agent plus workers), so
    // require the unified KV allocator; otherwise a 32k recipe with three
    // slots exposes only ~11k to each request and can reject valid prompts.
    const unified = withFlag(args, "--kv-unified", "--no-kv-unified");
    // Native-MTP Qwen recipes use the requested full-precision BF16 KV cache.
    // Other llama.cpp recipes retain the symmetric q8 profile that keeps the
    // 131k shared-context envelope practical on a single consumer GPU.
    const nativeMtp = normalized.speculativeDecoding?.strategy === "draft-mtp";
    const contextTokens = nativeMtp
      ? Math.min(normalized.contextTokens, LLAMA_CPP_NATIVE_MTP_BF16_CONTEXT_TOKENS)
      : normalized.contextTokens;
    const kvType = nativeMtp ? "bf16" : "q8_0";
    const kv = withOption(withOption(unified, "--cache-type-k", kvType), "--cache-type-v", kvType);
    return {
      ...normalized,
      contextTokens,
      configuration: {
        ...normalized.configuration,
        args: withOption(withOption(kv, "--parallel", LOCAL_MAX_CONCURRENT_AGENTS), "--ctx-size", contextTokens),
      },
    };
  }
  if (normalized.playbookId === "vllm") {
    return { ...normalized, configuration: { ...normalized.configuration, args: withOption(withOption(args, "--max-num-seqs", LOCAL_MAX_CONCURRENT_AGENTS), "--max-model-len", Math.min(LOCAL_MAIN_CONTEXT_TOKENS, normalized.contextTokens)) } };
  }
  return normalized;
}

function withOption(args: string[], option: string, value: string | number): string[] {
  const next = [...args];
  const index = next.findIndex((argument) => argument === option || argument.startsWith(`${option}=`));
  if (index < 0) return [...next, option, String(value)];
  if (next[index]!.includes("=")) next[index] = `${option}=${value}`;
  else if (index + 1 < next.length) next[index + 1] = String(value);
  else next.push(String(value));
  return next;
}

function withFlag(args: string[], flag: string, opposite: string): string[] {
  return [...args.filter((argument) => argument !== flag && argument !== opposite), flag];
}
