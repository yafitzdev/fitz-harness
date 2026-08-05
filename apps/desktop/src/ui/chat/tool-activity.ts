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

interface ToolMeta {
  kind: ToolKind;
  /** Present-tense verb, e.g. "Running". */
  verb: string;
  /** Past-tense verb, e.g. "Ran". */
  pastVerb: string;
  icon: IconName;
}

type IconName = "edit" | "terminal" | "sparkle";

/** Built-in tool presentation. Anything not listed here falls back to DEFAULT_TOOL. */
const BUILT_IN_TOOLS: Record<string, ToolMeta> = {
  bash: { kind: "command", verb: "Running", pastVerb: "Ran", icon: "terminal" },
  edit: { kind: "edit", verb: "Editing", pastVerb: "Edited", icon: "edit" },
  write: { kind: "edit", verb: "Writing", pastVerb: "Wrote", icon: "edit" },
  read: { kind: "command", verb: "Reading", pastVerb: "Read", icon: "terminal" },
  grep: { kind: "command", verb: "Searching", pastVerb: "Searched", icon: "terminal" },
  find: { kind: "command", verb: "Finding", pastVerb: "Found", icon: "terminal" },
  ls: { kind: "command", verb: "Listing", pastVerb: "Listed", icon: "terminal" },
};

const DEFAULT_TOOL: ToolMeta = { kind: "command", verb: "Running", pastVerb: "Ran", icon: "sparkle" };

/** Raw SVG inner markup per icon; wrap with svgIcon() at the DOM layer. */
const ICON_PATHS: Record<IconName, string> = {
  edit: '<path d="m4.2 14.8.7-3.2 7.8-7.8a1.45 1.45 0 0 1 2.05 2.05L7 13.65z"></path><path d="m11.7 4.8 2.05 2.05"></path>',
  terminal: '<rect x="2.8" y="3.2" width="14.4" height="13.6" rx="2.3"></rect><path d="m6 7 2.2 2L6 11M10.4 12h3.1"></path>',
  sparkle: '<path d="M10 2.8c.45 3.5 2.2 5.45 5.8 7.2-3.6 1.75-5.35 3.7-5.8 7.2-.45-3.5-2.2-5.45-5.8-7.2C7.8 8.25 9.55 6.3 10 2.8Z"></path>',
};

/** Whether a tool call counts as a file edit or as a plain command in burst grouping. */
export function activityKind(toolName: string): ToolKind {
  return toolMeta(toolName).kind;
}

/** Summary label for a burst of consecutive tool calls. */
export function burstLabel(edits: number, commands: number, running: boolean): string {
  if (edits > 0 && commands > 0) return running ? "Editing files, running commands" : "Edited files, ran commands";
  if (edits > 0) return running ? (edits === 1 ? "Editing file" : "Editing files") : (edits === 1 ? "Edited file" : "Edited files");
  return running ? (commands === 1 ? "Running command" : "Running commands") : (commands === 1 ? "Ran command" : "Ran commands");
}

/** Present- or past-tense label for a single tool call row. */
export function describeTool(toolName: string, input: unknown, running: boolean): string {
  const meta = toolMeta(toolName);
  const verb = running ? meta.verb : meta.pastVerb;
  const target = toolTarget(input);
  return target ? `${verb} ${target}` : `${verb} ${displayName(toolName)}`;
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

function toolTarget(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  return String(value.path ?? value.file_path ?? value.filePath ?? value.command ?? value.cmd ?? value.pattern ?? value.query ?? "").trim();
}

function toolMeta(toolName: string): ToolMeta {
  return BUILT_IN_TOOLS[toolName] ?? DEFAULT_TOOL;
}
