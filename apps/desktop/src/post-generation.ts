/**
 * Post-generation layer: a list of user-definable rules applied to raw LLM
 * output between generation and what the user sees.
 *
 * Rules run in order over the accumulated message text (see
 * `applyPostGeneration`) right before Markdown rendering, so they edit the
 * text that reaches the user — the stored transcript and the context sent
 * back to the model stay untouched.
 *
 * To define a new rule, add an object to `postGenerationRules`. Rules that
 * touch Markdown syntax should use `transformOutsideFences` so the inside of
 * fenced ``` code blocks is treated as literal code and never rewritten.
 */
export interface PostGenerationRule {
  id: string;
  label: string;
  enabled: boolean;
  /** Transform raw LLM output. Receives the text after earlier rules ran. */
  apply(text: string): string;
}

export interface PostGenerationOptions {
  /** Keep inline-code delimiters so a structural Markdown renderer can still
   * distinguish explicit file references from ordinary prose. The renderer
   * consumes the delimiters; they are never shown to the user. */
  preserveInlineCode?: boolean;
  /** Preserve visible Markdown hierarchy for renderers that consume the
   * syntax structurally instead of displaying its delimiters. */
  preserveMarkdownStructure?: boolean;
}

/** Applies `transform` only to lines that are outside fenced ``` code blocks. */
export function transformOutsideFences(text: string, transform: (line: string) => string): string {
  const lines = text.split("\n");
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opens = /^\s*```([^`]*)$/.test(line);
    const closes = /^\s*```\s*$/.test(line);
    if (!inFence && opens) { inFence = true; continue; }
    if (inFence && closes) { inFence = false; continue; }
    if (!inFence) lines[index] = transform(line);
  }
  return lines.join("\n");
}

/** Answers shouldn't show backtick-wrapped inline code; strip the backticks. */
export const stripInlineBackticks: PostGenerationRule = {
  id: "strip-inline-backticks",
  label: "Strip inline backticks",
  enabled: true,
  apply: (text) => transformOutsideFences(text, (line) => line.replace(/`/g, "")),
};

/** Bold is shown as plain text; convert **bold** / __bold__ markers to their content. */
export const stripBoldMarkers: PostGenerationRule = {
  id: "strip-bold-markers",
  label: "Convert bold to plain text",
  enabled: true,
  apply: (text) => transformOutsideFences(text, (line) => line.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1")),
};

/** Headings are flattened to readable prose; drop the leading # prefix. */
export const flattenHeadings: PostGenerationRule = {
  id: "flatten-headings",
  label: "Flatten headings to plain text",
  enabled: true,
  apply: (text) => transformOutsideFences(text, (line) => line.replace(/^(#{1,6})\s+/, "")),
};

/** Every rule that applies to new assistant output, in order. */
export const postGenerationRules: PostGenerationRule[] = [stripInlineBackticks, stripBoldMarkers, flattenHeadings];

/** Runs all enabled rules over raw LLM output. */
export function applyPostGeneration(text: string, options: PostGenerationOptions = {}): string {
  return postGenerationRules.reduce((value, rule) => {
    if (!rule.enabled) return value;
    if (options.preserveInlineCode && rule.id === "strip-inline-backticks") return value;
    if (options.preserveMarkdownStructure && (rule.id === "strip-bold-markers" || rule.id === "flatten-headings")) return value;
    return rule.apply(value);
  }, text);
}
