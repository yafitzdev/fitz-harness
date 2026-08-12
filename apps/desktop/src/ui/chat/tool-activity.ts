/**
 * Pure, DOM-free derivation of how tool activity is described in the work
 * feed: burst summary labels, per-tool labels, icons, and the edit/command
 * bucketing that drives grouping.
 *
 * Kept out of the DOM layer so the label logic is unit-testable in isolation
 * and so adding a tool (built-in or plugin-provided) is a data change here,
 * not a control-flow change in the renderer.
 */

export type ToolKind = "edit" | "command";

export type IconName = "edit" | "terminal" | "sparkle";

/** Semantic buckets for burst summaries, so a burst is described by what it did rather than a bare command count. */
export type BurstCategory = "edit" | "shell" | "read" | "code-search" | "web" | "fetch" | "other";

export interface ToolMeta {
  kind: ToolKind;
  /** Present-tense verb, e.g. "Running". */
  presentVerb: string;
  /** Past-tense verb, e.g. "Ran". */
  pastVerb: string;
  icon: IconName;
  /** Optional override for how the tool name is displayed, e.g. "Web search". */
  displayName?: string;
  /** Burst-summary bucket. Defaults to "edit" for edit-kind tools, "other" otherwise. */
  bucket?: BurstCategory;
}

/** Built-in tool presentation. Anything not listed here falls back to DEFAULT_TOOL. */
const BUILT_IN_TOOLS: Record<string, ToolMeta> = {
  bash: { kind: "command", presentVerb: "Running", pastVerb: "Ran", icon: "terminal", bucket: "shell" },
  edit: { kind: "edit", presentVerb: "Editing", pastVerb: "Edited", icon: "edit", bucket: "edit" },
  write: { kind: "edit", presentVerb: "Writing", pastVerb: "Wrote", icon: "edit", bucket: "edit" },
  read: { kind: "command", presentVerb: "Reading", pastVerb: "Read", icon: "terminal", bucket: "read" },
  grep: { kind: "command", presentVerb: "Searching", pastVerb: "Searched", icon: "terminal", bucket: "code-search" },
  find: { kind: "command", presentVerb: "Finding", pastVerb: "Found", icon: "terminal", bucket: "code-search" },
  ls: { kind: "command", presentVerb: "Listing", pastVerb: "Listed", icon: "terminal", bucket: "code-search" },
  web_search: { kind: "command", presentVerb: "Running", pastVerb: "Ran", icon: "sparkle", displayName: "Web search", bucket: "web" },
  fetch_content: { kind: "command", presentVerb: "Running", pastVerb: "Ran", icon: "sparkle", displayName: "Fetch content", bucket: "fetch" },
  get_search_content: { kind: "command", presentVerb: "Running", pastVerb: "Ran", icon: "sparkle", displayName: "Search result", bucket: "fetch" },
  generate_image: { kind: "command", presentVerb: "Generating", pastVerb: "Generated", icon: "sparkle", displayName: "image" },
  generate_video: { kind: "command", presentVerb: "Generating", pastVerb: "Generated", icon: "sparkle", displayName: "video" },
  generate_audio: { kind: "command", presentVerb: "Generating", pastVerb: "Generated", icon: "sparkle", displayName: "audio" },
  subagent: { kind: "command", presentVerb: "Delegating", pastVerb: "Delegated", icon: "sparkle", displayName: "subagent" },
};

const DEFAULT_TOOL: ToolMeta = { kind: "command", presentVerb: "Running", pastVerb: "Ran", icon: "sparkle" };

/** Raw SVG inner markup per icon; wrap with svgIcon() at the DOM layer. */
const ICON_PATHS: Record<IconName, string> = {
  edit: '<path d="m4.2 14.8.7-3.2 7.8-7.8a1.45 1.45 0 0 1 2.05 2.05L7 13.65z"></path><path d="m11.7 4.8 2.05 2.05"></path>',
  terminal: '<rect x="2.8" y="3.2" width="14.4" height="13.6" rx="2.3"></rect><path d="m6 7 2.2 2L6 11M10.4 12h3.1"></path>',
  sparkle: '<path d="M10 2.8c.45 3.5 2.2 5.45 5.8 7.2-3.6 1.75-5.35 3.7-5.8 7.2-.45-3.5-2.2-5.45-5.8-7.2C7.8 8.25 9.55 6.3 10 2.8Z"></path>',
};

/**
 * Extend or override presentation for a tool, e.g. from plugin-declared
 * metadata. Merges over the built-in/default entry so callers only set the
 * fields they care about.
 */
export function registerToolMeta(toolName: string, meta: Partial<ToolMeta>): void {
  BUILT_IN_TOOLS[toolName] = { ...DEFAULT_TOOL, ...BUILT_IN_TOOLS[toolName], ...meta };
}

/** Whether a tool call counts as a file edit or as a plain command in burst grouping. */
export function activityKind(toolName: string): ToolKind {
  return toolMeta(toolName).kind;
}

/** Stable ordering for buckets with equal tool counts, so summaries never flip-flop as tools stream in. */
const BUCKET_ORDER: Record<BurstCategory, number> = { edit: 0, shell: 1, web: 2, read: 3, "code-search": 4, fetch: 5, other: 6 };

/** Which bucket a tool call belongs to; plugin-registered edit tools fall back to the edit bucket. */
function bucketOf(toolName: string): BurstCategory {
  const meta = toolMeta(toolName);
  return meta.bucket ?? (meta.kind === "edit" ? "edit" : "other");
}

/**
 * Summary label for a burst of consecutive tool calls, e.g. "Searched the web, fetched 2 pages".
 * Buckets are ranked by volume with a fixed tie-break so the label grows monotonically while the
 * burst is running and never reorders between "command" and "commands" on equal counts.
 */
export function summarizeBurst(tools: Record<string, number>, running: boolean): string {
  const totals = new Map<BurstCategory, number>();
  for (const [tool, count] of Object.entries(tools)) {
    const bucket = bucketOf(tool);
    totals.set(bucket, (totals.get(bucket) ?? 0) + count);
  }
  if (totals.size === 0) return running ? "Running commands" : "Ran commands";
  const ranked = [...totals.entries()].sort(([nameA, countA], [nameB, countB]) => countB - countA || BUCKET_ORDER[nameA] - BUCKET_ORDER[nameB]);
  const label = ranked.slice(0, 2).map(([bucket, count]) => burstPhrase(bucket, count, running)).join(", ");
  return label[0]!.toUpperCase() + label.slice(1);
}

/** Phrase for one bucket; lowercase so joined summaries read as one sentence. */
function burstPhrase(bucket: BurstCategory, count: number, running: boolean): string {
  switch (bucket) {
    case "edit": return countPhrase(running ? "editing" : "edited", count, "file");
    case "shell": return countPhrase(running ? "running" : "ran", count, "command");
    case "read": return countPhrase(running ? "reading" : "read", count, "file");
    case "code-search": return running ? "searching code" : "searched code";
    case "web": return running ? "searching the web" : "searched the web";
    case "fetch": return countPhrase(running ? "fetching" : "fetched", count, "page");
    case "other": return countPhrase(running ? "running" : "ran", count, "command");
  }
}

/** "ran command" / "ran 3 commands": the numeral appears only above one, so single-tool bursts stay terse. */
function countPhrase(verb: string, count: number, noun: string): string {
  return count === 1 ? `${verb} ${noun}` : `${verb} ${count} ${noun}s`;
}

/** Present- or past-tense label for a single tool call row. */
export function describeTool(toolName: string, input: unknown, running: boolean): string {
  const meta = toolMeta(toolName);
  const verb = running ? meta.presentVerb : meta.pastVerb;
  if (toolName === "subagent" && input && typeof input === "object") {
    const role = String((input as Record<string, unknown>).role ?? "").trim();
    if (role) return `${verb} to ${role}`;
  }
  const target = toolTarget(input);
  return target ? `${verb} ${target}` : `${verb} ${meta.displayName ?? displayName(toolName)}`;
}

/** Human-readable tool name: "web_search" → "Web search". Single words are left untouched. */
export function displayName(toolName: string): string {
  const pretty = toolName.replaceAll("_", " ").trim();
  if (!pretty || pretty === toolName) return toolName;
  return pretty[0]!.toUpperCase() + pretty.slice(1);
}

/** Raw SVG inner markup for the tool's activity icon. */
export function iconPathFor(toolName: string): string {
  return ICON_PATHS[toolMeta(toolName).icon];
}

/** Icon for a burst summary, reflecting what the burst contains: edit icon when it edits files. */
export function burstIconPath(edits: number, commands: number): string {
  return edits > 0 ? ICON_PATHS.edit : ICON_PATHS.terminal;
}

/** Trimmed file path from a tool input, if any: `path`, `file_path`, or `filePath`. */
export function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const path = value.path ?? value.file_path ?? value.filePath;
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim();
  return trimmed || undefined;
}

function toolTarget(input: unknown): string {
  const path = toolPath(input);
  if (path) return path;
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  return String(value.command ?? value.cmd ?? value.pattern ?? value.query ?? "").trim();
}

/**
 * Project-relative form of a tool path for display: strips the project root
 * prefix (either separator style) so summaries show `src/app.ts` instead of the
 * whole absolute path. Paths that are already relative, live outside the root,
 * or have no root to compare against are returned unchanged.
 */
export function projectRelativePath(path: string, root: string): string {
  if (!path || !root) return path;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const candidate = normalize(path);
  const normalizedRoot = normalize(root);
  if (candidate.toLowerCase() === normalizedRoot.toLowerCase()) return path;
  if (candidate.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) return candidate.slice(normalizedRoot.length + 1);
  return path;
}

function toolMeta(toolName: string): ToolMeta {
  return BUILT_IN_TOOLS[toolName] ?? DEFAULT_TOOL;
}
