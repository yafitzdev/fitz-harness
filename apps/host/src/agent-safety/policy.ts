/**
 * Deterministic tool-call policy engine.
 *
 * Every non-read-only tool call funnels through here (and read tools too, so secret
 * files are never read). The engine never asks a human: deletes become trash moves,
 * sensitive/system/protected/outside paths are blocked with an explanation, and
 * destructive operations it cannot rewrite (shred, git reset --hard, python os.remove)
 * are blocked outright. Machine guarantees, not approval prompts.
 */

import type { ToolActionEffect } from "@fitz/protocol";
import { MEDIA_TOOLS, type PiToolCall, type ToolEvaluation } from "@fitz/agent-pi";
import { analyzeBashCommand, type BashIntent, type BashTarget } from "./bash-analyzer.js";
import { canonicalizePath, classifyPath, rawBasename, resolveAbsolutePath, shellQuote, type PathInfo, type PathZone } from "./paths.js";

export interface ActionLogEntry {
  toolName: string;
  effect: ToolActionEffect;
  path?: string;
  detail?: Readonly<Record<string, unknown>>;
}

export interface ActionLog {
  record(entry: ActionLogEntry): void;
}

export interface PolicyContext {
  runId: string;
  /** The workspace root, in the form the shell sees it (forward slashes preferred). */
  cwd: string;
  homeDir: string;
  runtimeDirs: readonly string[];
  tempDirs: readonly string[];
  /** Absolute trash destination for the current run (already created). */
  trashDir: string;
  trash: {
    move(input: { runId: string; workspaceRoot: string; path: string; sequence: number }): Promise<string>;
    /**
     * Record a trash entry at rewrite time. The rewritten `mv` executes later in the
     * shell, so the entry is speculative — but it is what makes the management API's
     * restore work for policy-rewritten deletes. Stale entries (the move failed) fail
     * restore with a clear error and are harmless.
     */
    record(input: { workspaceRoot: string; originalPath: string; trashPath: string }): void;
  };
  /** Per-run counter for trash filenames. */
  nextSequence(): number;
  log: ActionLog;
  createdPaths: Set<string>;
  /**
   * Per-tool policy override for paid media tools (§5.9). The safety service resolves the
   * run's owner (user-level policy first, then role-level) exactly like the HTTP approval
   * endpoint's `resolveToolPolicy` consult; the policy engine maps the decision onto the
   * ToolEvaluation union. Absent, media tools default to "ask".
   */
  resolveToolPolicy?: (toolName: string) => "allow" | "deny" | "ask";
}

const ALLOWED_WRITE_ZONES: ReadonlySet<PathZone> = new Set(["workspace", "runtime", "temp"]);
const ALLOWED_READ_ZONES: ReadonlySet<PathZone> = new Set(["workspace", "runtime", "temp", "outside"]);
/** Zones a script file may be executed from (its contents are opaque to static analysis). */
const ALLOWED_EXECUTE_ZONES: ReadonlySet<PathZone> = new Set(["workspace", "runtime", "temp"]);

export async function evaluateToolCall(request: PiToolCall & { cwd: string; runId?: string }, ctx: PolicyContext, signal?: AbortSignal): Promise<ToolEvaluation> {
  if (signal?.aborted) return { action: "block", reason: "The run was cancelled" };
  const toolName = request.toolName;
  const input = (request.input ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      if (!command.trim()) return recordAllow(ctx, toolName);
      return evaluateBash(command, ctx, signal);
    }
    case "write":
    case "edit": {
      const path = typeof input.path === "string" ? input.path : undefined;
      if (!path) return recordAllow(ctx, toolName, undefined, { note: "no path" });
      const info = classifyPath(path, classifyOptions(ctx));
      if (ALLOWED_WRITE_ZONES.has(info.zone)) {
        ctx.createdPaths.add(info.canonical);
        ctx.log.record({ toolName, effect: "write", path: info.canonical });
        return { action: "allow" };
      }
      return block(ctx, toolName, info, `modify`);
    }
    case "read": {
      const path = typeof input.path === "string" ? input.path : undefined;
      if (!path) return recordAllow(ctx, toolName);
      const info = classifyPath(path, classifyOptions(ctx));
      if (ALLOWED_READ_ZONES.has(info.zone)) return recordAllow(ctx, toolName, info);
      return block(ctx, toolName, info, `read`);
    }
    case "grep":
    case "find":
    case "ls": {
      const path = typeof input.path === "string" && input.path ? input.path : undefined;
      if (!path) return recordAllow(ctx, toolName);
      const info = classifyPath(path, classifyOptions(ctx));
      if (info.zone === "sensitive" || info.zone === "system" || info.zone === "protected") return block(ctx, toolName, info, `search`);
      return recordAllow(ctx, toolName, info);
    }
    case "fitz_trash": {
      // The tool handler does its own zone validation; the policy just lets it through.
      return recordAllow(ctx, toolName);
    }
    default:
      if (MEDIA_TOOLS.has(toolName)) return evaluateMediaTool(toolName, ctx);
      return recordAllow(ctx, toolName);
  }
}

/**
 * Media generation (§5.9) is Ask-first: generation is paid work (KD-7), so the
 * deterministic engine consults the store's per-tool policy (`resolveToolPolicy`) and
 * maps allow/deny/ask onto the ToolEvaluation union (which has no "deny" action —
 * "deny" becomes a block). The default — no policy row, or no run owner — is "ask",
 * which escalates to the human approval gate. The audit row uses effect "allow" for
 * "ask" because nothing was mechanically blocked; `detail.decision` carries the real
 * outcome so every media decision stays replayable.
 */
function evaluateMediaTool(toolName: string, ctx: PolicyContext): ToolEvaluation {
  const decision = ctx.resolveToolPolicy?.(toolName) ?? "ask";
  if (decision === "allow") {
    ctx.log.record({ toolName, effect: "allow", detail: { decision } });
    return { action: "allow" };
  }
  if (decision === "deny") {
    ctx.log.record({ toolName, effect: "block", detail: { decision } });
    return { action: "block", reason: `${toolName} denied by policy` };
  }
  ctx.log.record({ toolName, effect: "allow", detail: { decision: "ask" } });
  return { action: "ask" };
}

// ---------------------------------------------------------------------------
// Bash evaluation
// ---------------------------------------------------------------------------

async function evaluateBash(command: string, ctx: PolicyContext, signal?: AbortSignal): Promise<ToolEvaluation> {
  const analysis = analyzeBashCommand(command);
  if (analysis.intents.length === 0) {
    ctx.log.record({ toolName: "bash", effect: "allow" });
    return { action: "allow" };
  }

  const reasons: string[] = [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let sawAllow = false;
  let sawTrash = false;

  for (const intent of analysis.intents) {
    if (signal?.aborted) return { action: "block", reason: "The run was cancelled" };
    // Script files: contents are opaque, so the path itself is zone-checked.
    if (intent.kind === "script-file") {
      for (const target of intent.targets) {
        const base = await intentBase(intent, ctx);
        if (!base.ok) { reasons.push(base.reason); continue; }
        const resolved = resolveTarget(target, { ...ctx, cwd: base.path });
        if (!resolved) { reasons.push(pathUnresolvable(target)); continue; }
        const info = classifyTarget(resolved, base, ctx);
        if (!ALLOWED_EXECUTE_ZONES.has(info.zone)) {
          reasons.push(`${target.raw} ${zoneExplanation(info, "execute")}`);
        }
      }
      continue;
    }
    // Deletes discovered inside an embedded script cannot be rewritten (the rewrite
    // would corrupt the script text), so they are blocked. Block-kind intents keep
    // their specific reasons (find -exec rm, nested-shell, ...).
    if (intent.nested && intent.type === "delete") {
      reasons.push(nestedScriptDeleteReason(intent));
      continue;
    }
    if (intent.type === "block") {
      reasons.push(blockIntentReason(intent));
      continue;
    }
    if (intent.type === "write") {
      for (const target of intent.targets) {
        const base = await intentBase(intent, ctx);
        if (!base.ok) { reasons.push(base.reason); continue; }
        const resolved = resolveTarget(target, { ...ctx, cwd: base.path });
        if (!resolved) { reasons.push(pathUnresolvable(target)); continue; }
        const info = classifyTarget(resolved, base, ctx);
        if (!ALLOWED_WRITE_ZONES.has(info.zone)) {
          reasons.push(`${target.raw} ${zoneExplanation(info, "write")}`);
        } else {
          ctx.createdPaths.add(info.canonical);
        }
      }
      continue;
    }
    if (intent.type === "read") {
      for (const target of intent.targets) {
        const base = await intentBase(intent, ctx);
        if (!base.ok) { reasons.push(base.reason); continue; }
        const resolved = resolveTarget(target, { ...ctx, cwd: base.path });
        if (!resolved) { reasons.push(pathUnresolvable(target)); continue; }
        const info = classifyTarget(resolved, base, ctx);
        if (!ALLOWED_READ_ZONES.has(info.zone)) {
          reasons.push(`${target.raw} ${zoneExplanation(info, "read")}`);
        }
      }
      continue;
    }
    // Delete intents: the interesting case.
    const base = await intentBase(intent, ctx);
    if (!base.ok) { reasons.push(base.reason); continue; }
    const outcome = await evaluateDelete(intent, command, ctx, signal, base);
    if (outcome.action === "block" && outcome.reason) reasons.push(outcome.reason);
    else if (outcome.action === "rewrite" && outcome.edit) { edits.push(outcome.edit); sawTrash = true; }
    else if (outcome.action === "allow") sawAllow = true;
  }

  if (reasons.length > 0) {
    ctx.log.record({ toolName: "bash", effect: "block", detail: { command, reasons } });
    return { action: "block", reason: `Fitz blocked this command:\n- ${reasons.join("\n- ")}` };
  }
  if (edits.length > 0) {
    const rewritten = applyEdits(command, edits);
    ctx.log.record({ toolName: "bash", effect: "rewrite", detail: { original: command, rewritten } });
    return { action: "rewrite", input: { command: rewritten } };
  }
  ctx.log.record({ toolName: "bash", effect: "allow", detail: { command } });
  return { action: "allow" };
}

interface DeleteOutcome {
  action: "allow" | "block" | "rewrite";
  reason?: string;
  edit?: { start: number; end: number; replacement: string };
}

/** Effective working directory for an intent, honoring a preceding `cd`. Always absolute. */
async function intentBase(intent: BashIntent, ctx: PolicyContext): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (intent.cdUnsafe) {
    return { ok: false, reason: `a preceding cd goes to an unknown location (cd -, bare cd, or an unresolvable variable), so the relative paths in this command cannot be classified safely. Use absolute paths or drop the cd.` };
  }
  if (!intent.cdBase) return { ok: true, path: ctx.cwd };
  const resolved = resolveTarget(intent.cdBase, ctx);
  if (!resolved) return { ok: false, reason: pathUnresolvable(intent.cdBase) };
  // The shell resolves the cd target against the workspace root, where the run starts.
  const absolute = resolveAbsolutePath(resolved, ctx.cwd) ?? resolved;
  const info = classifyPath(absolute, classifyOptions(ctx));
  if (info.zone === "workspace" || info.zone === "temp" || info.zone === "runtime") {
    return { ok: true, path: absolute };
  }
  return { ok: false, reason: `cd to ${intent.cdBase.raw} would run relative paths in the ${info.zone} zone (${info.canonical}); Fitz blocks relative paths after a cd outside the workspace. Use absolute paths or drop the cd.` };
}

async function evaluateDelete(intent: BashIntent, command: string, ctx: PolicyContext, signal?: AbortSignal, base: { path: string } = { path: ctx.cwd }): Promise<DeleteOutcome> {
  switch (intent.kind) {
    case "shred":
      return { action: "block", reason: `shred is intentionally unrecoverable, so Fitz refuses to run it. Use rm (Fitz rewrites it to a trash move) or the fitz_trash tool.` };
    case "truncate":
      return { action: "block", reason: `truncate discards a file's contents permanently. Move the file to trash instead (rm or fitz_trash); truncate is only safe for files created this run.` };
    case "find-exec-rm":
      return { action: "block", reason: `find -exec rm bypasses Fitz's trash rewrite. Use find -delete (Fitz rewrites it to a trash move) or remove the paths individually.` };
    case "find-delete": {
      const first = intent.targets[0];
      let info: PathInfo;
      if (!first) {
        // find with no explicit path searches the current directory.
        info = classifyPath(base.path, classifyOptions(ctx));
      } else {
        const resolved = resolveTarget(first, { ...ctx, cwd: base.path });
        if (!resolved) return { action: "block", reason: pathUnresolvable(first) };
        info = classifyTarget(resolved, base, ctx);
      }
      if (info.zone === "temp") return { action: "allow" };
      if (info.zone !== "workspace" && info.zone !== "runtime") {
        return { action: "block", reason: `find under ${first?.raw ?? "."} ${zoneExplanation(info, "delete")}` };
      }
      const trash = shellQuote(ctx.trashDir);
      return { action: "rewrite", edit: { start: intent.segmentStart, end: intent.segmentEnd, replacement: `-exec mv -t ${trash} {} +` } };
    }
    case "delete":
      return evaluatePlainDelete(intent, command, ctx, base);
    default:
      return { action: "allow" };
  }
}

async function evaluatePlainDelete(intent: BashIntent, command: string, ctx: PolicyContext, base: { path: string }): Promise<DeleteOutcome> {
  const targets = intent.targets;
  if (targets.length === 0) return { action: "allow" };

  // A command substitution (or backticks) anywhere in a delete command runs whatever the
  // substitution produces; the trash rewrite cannot neutralize code that executes inside
  // an argument, so block it outright.
  if (/\$\(|`/.test(command)) {
    return { action: "block", reason: `this delete contains a command substitution or backticks, which Fitz cannot safely rewrite to a trash move. Inline the paths or use explicit rm / fitz_trash commands.` };
  }

  // Whole-directory deletes that cannot be trashed by rename: `rm -rf .`, `rm -rf ..`.
  const dotTargets = targets.filter((target) => target.unquoted === "." || target.unquoted === "./" || target.unquoted === ".." || target.unquoted === "../");
  if (dotTargets.length > 0 && intent.flags.some((flag) => /-r/.test(flag) || flag === "--recursive")) {
    return { action: "block", reason: `rm -rf of the current or containing directory (${dotTargets.map((t) => t.unquoted).join(", ")}) cannot be moved to trash — it would move the very folder being deleted. Remove the contents explicitly instead.` };
  }

  const classified: Array<{ target: BashTarget; info: PathInfo }> = [];
  const trashable: Array<{ target: BashTarget; info: PathInfo }> = [];
  let tempTarget = false;
  let blocked = false;
  let firstReason: string | undefined;

  for (const target of targets) {
    const resolved = resolveTarget(target, { ...ctx, cwd: base.path });
    if (!resolved) { blocked = true; firstReason ??= pathUnresolvable(target); continue; }
    const info = classifyTarget(resolved, base, ctx);
    classified.push({ target, info });
    switch (info.zone) {
      case "workspace":
      case "runtime":
        // Deleting the workspace root itself would move the trash into itself.
        if (info.zone === "workspace" && info.canonical === canonicalizePath(ctx.cwd, ctx.cwd)) {
          blocked = true;
          firstReason ??= `${target.raw} is the entire project workspace; Fitz blocks deleting the workspace root. Remove the contents explicitly instead.`;
        } else {
          trashable.push({ target, info });
        }
        break;
      case "temp":
        tempTarget = true;
        break;
      case "sensitive":
        blocked = true;
        firstReason ??= `${target.raw} ${zoneExplanation(info, "delete")}`;
        break;
      case "system":
        blocked = true;
        firstReason ??= `${target.raw} ${zoneExplanation(info, "delete")}`;
        break;
      case "protected":
        blocked = true;
        firstReason ??= `${target.raw} is inside the Fitz trash (${info.zone}); the agent never touches trashed files.`;
        break;
      case "outside":
        blocked = true;
        firstReason ??= `${target.raw} ${zoneExplanation(info, "delete")}`;
        break;
      default:
        blocked = true;
        firstReason ??= pathUnresolvable(target);
    }
  }

  if (blocked) return { action: "block", reason: firstReason ?? `Fitz blocked this delete: ${intent.command} is not a safe operation.` };
  if (trashable.length === 0 && tempTarget) {
    // Pure temp delete: ephemeral by definition, no rewrite needed.
    return { action: "allow" };
  }
  if (trashable.length > 0 && tempTarget) {
    return { action: "block", reason: `Fitz cannot rewrite a command that deletes both workspace files and temp files in one call. Split them: use rm for the temp file and a separate command for the workspace paths.` };
  }
  if (trashable.length === 0) return { action: "allow" };

  // One trash move per source, each with a unique sequence-prefixed destination so
  // same-basename paths never collide, and a recorded entry so the management API can
  // restore each file. `;` (not `&&`) keeps deleting the rest if one move fails.
  // Glob targets (rm -rf *) are rewritten but not recorded: the shell expands them to
  // an unknown number of files, so no per-file entry can be accurate. They land in
  // .fitz-trash on disk and stay recoverable there.
  const moves = trashable.map(({ target }) => {
    const sequence = ctx.nextSequence();
    const dest = `${ctx.trashDir.replace(/\\/g, "/")}/${sequence}-${rawBasename(target.unquoted)}`;
    if (!target.wildcard) {
      ctx.trash.record({
        workspaceRoot: ctx.cwd,
        originalPath: resolveAbsolutePath(target.unquoted, base.path) ?? target.raw,
        trashPath: dest,
      });
    }
    return `mv ${target.raw} ${shellQuote(dest)}`;
  });
  const replacement = moves.join("; ");
  // Replace the whole delete segment (`rm -rf a b`) with the trash moves.
  return { action: "rewrite", edit: { start: intent.segmentStart, end: intent.segmentEnd, replacement } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyOptions(ctx: PolicyContext) {
  return { workspaceRoot: ctx.cwd, runtimeDirs: ctx.runtimeDirs, tempDirs: ctx.tempDirs, homeDir: ctx.homeDir };
}

/**
 * Classify a target that has already been variable-expanded by `resolveTarget`.
 * The target may still be relative, so it is resolved against the intent's effective
 * working directory (the `cd` base) — never against the workspace root, which is what
 * `classifyPath` would do on its own.
 */
function classifyTarget(resolved: string, base: { path: string }, ctx: PolicyContext): PathInfo {
  const absolute = resolveAbsolutePath(resolved, base.path) ?? resolved;
  return classifyPath(absolute, classifyOptions(ctx));
}

/** Expand `~`, `$HOME`, `$USERPROFILE`, `$PWD`, `$TEMP`/`$TMP` in a target. Returns undefined when a variable cannot be resolved. */
export function resolveTarget(target: Pick<BashTarget, "unquoted" | "expansion">, ctx: Pick<PolicyContext, "homeDir" | "cwd" | "tempDirs">): string | undefined {
  let text = target.unquoted;
  if (target.expansion) {
    let unresolved = false;
    const expanded = text.replace(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)[^}]*}|[0-9]+)/g, (_match, a: string | undefined, b: string | undefined) => {
      const name = a ?? b;
      switch (name) {
        case "HOME":
        case "USERPROFILE":
          return ctx.homeDir;
        case "PWD":
          return ctx.cwd;
        case "TMP":
        case "TEMP":
        case "TMPDIR":
          return ctx.tempDirs[0] ?? "";
        default:
          unresolved = true;
          return "";
      }
    });
    if (unresolved) return undefined;
    text = expanded;
  }
  return text || undefined;
}

function zoneExplanation(info: PathInfo, action: "read" | "write" | "delete" | "modify" | "search" | "execute"): string {
  switch (info.zone) {
    case "sensitive":
      return `is a secrets location (${info.canonical}); Fitz never ${action === "read" ? "reads" : "touches"} credentials, keys, or env files outside the project.`;
    case "system":
      return `is an operating-system path; Fitz never ${action === "read" ? "reads" : "touches"} system files.`;
    case "protected":
      return `is inside the Fitz trash; the agent never touches trashed files.`;
    case "outside":
      if (action === "execute") {
        return `is outside the project workspace (${info.canonical}); Fitz only executes scripts inside the workspace, its runtime dirs, and the temp dir.`;
      }
      return `is outside the project workspace (${info.canonical}); Fitz only ${action === "read" ? "allows reads of" : "allows writes and trash-moves inside"} the workspace, its runtime dirs, and the temp dir.`;
    default:
      return `is in the ${info.zone} zone, which Fitz blocks for ${action}.`;
  }
}

function pathUnresolvable(target: BashTarget): string {
  return `${target.raw} uses an environment variable or form Fitz cannot resolve to a real path; use the absolute path instead.`;
}

function blockIntentReason(intent: BashIntent): string {
  switch (intent.kind) {
    case "git-destructive":
      return `this git command permanently discards uncommitted work (git clean -f / reset --hard / checkout -- / restore / branch -D / stash drop). Fitz blocks it; commit or stash first, then remove files via rm or fitz_trash.`;
    case "git-rm":
      return `git rm permanently removes files from the working tree and stages the deletion. Use rm <path> (Fitz moves it to trash) and then git add, or fitz_trash.`;
    case "python-rm":
      return `inline Python file deletion (os.remove / shutil.rmtree) bypasses Fitz's trash rewrite. Use rm (rewritten to a trash move) or the fitz_trash tool instead.`;
    case "node-rm":
      return `inline Node.js file deletion (fs.unlink/rm/rmdir) bypasses Fitz's trash rewrite. Use rm (rewritten to a trash move) or the fitz_trash tool instead.`;
    case "xargs-rm":
      return `rm through xargs bypasses Fitz's trash rewrite. Use find -delete (rewritten to a trash move) or remove the paths individually.`;
    case "rsync-delete":
      return `rsync --delete permanently removes files not present at the source. Fitz blocks it; sync without --delete and remove stale files via rm or fitz_trash.`;
    case "shred":
      return `shred is intentionally unrecoverable; Fitz refuses to run it. Use rm (rewritten to a trash move) or fitz_trash.`;
    case "find-exec-rm":
      return `find -exec rm bypasses Fitz's trash rewrite. Use find -delete (rewritten to a trash move) or remove the paths individually.`;
    case "truncate":
      return `truncate discards a file's contents permanently. Move the file to trash instead (rm or fitz_trash).`;
    case "script-stdin":
      return `Fitz cannot inspect a script read from stdin (a pipe or -). Inline the commands so they can be classified, or use explicit tools.`;
    case "script-file":
      return `Fitz blocks executing this script file because it cannot inspect its contents.`;
    case "nested-shell":
      return `this interpreter command contains a file-deleting operation Fitz cannot rewrite. Use explicit rm or fitz_trash commands instead.`;
    default:
      return `Fitz blocked this operation (${intent.kind}).`;
  }
}

/** Reason for a delete or block discovered inside an embedded script (`sh -c`, `eval`, `find -exec`). */
function nestedScriptDeleteReason(intent: BashIntent): string {
  return `this delete runs inside an embedded script (${intent.command}); Fitz cannot rewrite it to a trash move. Use a direct rm or fitz_trash command instead.`;
}

/** Apply span edits right-to-left so earlier offsets stay valid. */
export function applyEdits(command: string, edits: Array<{ start: number; end: number; replacement: string }>): string {
  let result = command;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function recordAllow(ctx: PolicyContext, toolName: string, info?: PathInfo, detail?: Record<string, unknown>): ToolEvaluation {
  ctx.log.record({ toolName, effect: "allow", ...(info ? { path: info.canonical } : {}), ...(detail ? { detail } : {}) });
  return { action: "allow" };
}

function block(ctx: PolicyContext, toolName: string, info: PathInfo, action: "modify" | "read" | "search"): ToolEvaluation {
  const reason = `${info.raw} ${zoneExplanation(info, action)}`;
  ctx.log.record({ toolName, effect: "block", path: info.canonical, detail: { reason } });
  return { action: "block", reason };
}
