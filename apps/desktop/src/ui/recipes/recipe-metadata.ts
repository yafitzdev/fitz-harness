export type RecipeModality = "text" | "image" | "video" | "audio";

interface MediaLimits {
  maxDurationSeconds?: number;
  maxResolution?: string;
  maxRefs?: number;
  maxFrames?: number;
}

export interface RecipeMetadataOptions {
  modelId: string;
  contextTokens?: number;
  capabilities?: {
    chatCompletions?: boolean;
    modalities?: {
      output?: unknown[];
      limits?: MediaLimits;
    };
  };
  experimental?: boolean;
}

/**
 * Builds the shared metadata row used by Playbooks and Connections. Text
 * recipes expose their context window; media recipes expose modalities and
 * generation limits instead, so meaningless values such as `1 ctx` never
 * leak into the UI.
 */
export function recipeMetadata(options: RecipeMetadataOptions): HTMLElement[] {
  const labels = [label(options.modelId)];
  const modalities = outputModalities(options.capabilities);
  for (const modality of modalities) {
    labels.push(label(capitalize(modality), `media-modality-badge media-${modality}`, `Generates ${modality}`));
  }
  if (modalities.includes("text") && Number.isFinite(options.contextTokens) && Number(options.contextTokens) > 0) {
    labels.push(label(`${formatTokenCount(Number(options.contextTokens))} ctx`, "recipe-context-label"));
  }
  if (!modalities.includes("text")) {
    for (const badge of mediaLimitBadges(options.capabilities?.modalities?.limits)) labels.push(label(badge, "media-limit-badge"));
  }
  if (options.experimental) labels.push(label("Experimental", "media-experimental-badge"));
  return labels;
}

export function outputModalities(capabilities: RecipeMetadataOptions["capabilities"]): RecipeModality[] {
  if (capabilities?.chatCompletions !== false) return ["text"];
  const values = capabilities.modalities?.output ?? [];
  return [...new Set(values.filter((value): value is Exclude<RecipeModality, "text"> => value === "image" || value === "video" || value === "audio"))];
}

export function formatTokenCount(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
}

function mediaLimitBadges(limits: MediaLimits | undefined): string[] {
  if (!limits) return [];
  const badges: string[] = [];
  if (typeof limits.maxDurationSeconds === "number") badges.push(`≤${limits.maxDurationSeconds}s`);
  if (typeof limits.maxResolution === "string") badges.push(`≤${limits.maxResolution}`);
  if (typeof limits.maxRefs === "number") badges.push(`≤${limits.maxRefs} refs`);
  if (typeof limits.maxFrames === "number") badges.push(`≤${limits.maxFrames} frames`);
  return badges;
}

function label(text: string, extraClass = "", title?: string): HTMLElement {
  const value = document.createElement("span");
  value.className = `recipe-card-label${extraClass ? ` ${extraClass}` : ""}`;
  value.textContent = text;
  if (title) value.title = title;
  return value;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
