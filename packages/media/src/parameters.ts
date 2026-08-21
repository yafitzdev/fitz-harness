import type { MediaGenerationParams } from "@fitz/protocol";

/**
 * Validates provider-independent media parameters at the domain boundary.
 * Recipe-specific upper bounds are applied later by the media coordinator;
 * these checks reject values that are nonsensical for every provider.
 */
export function validateMediaGenerationParams(params: MediaGenerationParams): MediaGenerationParams {
  const prompt = params.prompt.trim();
  if (!prompt) throw new TypeError("prompt must not be empty");
  const lyrics = params.lyrics?.trim();
  if ((params.operation === "edit" || params.operation === "animate") && !params.refs?.length) {
    throw new TypeError(`${params.operation} operation requires a source image reference`);
  }
  if (params.operation === "animate" && params.refs?.length !== 1) {
    throw new TypeError("animate operation requires exactly one source image reference");
  }
  if (params.operation === "reference" && !params.refs?.length) {
    throw new TypeError("reference operation requires at least one media reference");
  }

  positiveFinite(params.durationSeconds, "durationSeconds");
  positiveFinite(params.fps, "fps");
  positiveInteger(params.steps, "steps");
  nonNegativeFinite(params.guidance, "guidance");
  finiteInteger(params.seed, "seed");

  return { ...params, prompt, ...(params.lyrics !== undefined ? { lyrics: lyrics ?? "" } : {}) };
}

function positiveFinite(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}

function nonNegativeFinite(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function positiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function finiteInteger(value: number | undefined, name: string): void {
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
}
