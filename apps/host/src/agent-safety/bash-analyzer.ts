/**
 * Quote-aware POSIX shell analyzer.
 *
 * Turns a bash command string into structured intents (delete / write / read) with
 * span-accurate targets so the policy engine can surgically rewrite `rm` into a
 * trash `mv`, or block destructive operations it refuses to rewrite (git reset --hard,
 * python os.remove, shred, rsync --delete, ...).
 *
 * This is a conservative static analyzer, not a shell: it never evaluates, it only
 * recognizes the shapes agents actually produce. Anything it cannot parse confidently
 * falls through to "no intent" and is allowed — the deep defense is the trash rewrite,
 * and Phase 2 containment (the sandbox) covers everything else.
 *
 * Red-team hardening (embedded scripts, cd, loops, source reads):
 * - `sh -c` / `bash -c` / `eval` / `find -exec` bodies are re-analyzed recursively so
 *   a delete smuggled inside an embedded script is still seen (it is then blocked,
 *   because a rewrite cannot reach inside a quoted string).
 * - Interpreters reading a script from stdin (`| bash`, `python -`) and script *files*
 *   are flagged; script files are zone-checked like any other path.
 * - `cd` changes the working directory, so relative paths after it are classified
 *   against the cd target instead of the workspace root.
 * - `for`/`while`/`if`/brace-group keywords reset command boundaries so `do rm "$f"`,
 *   `{ rm x; }`, etc. are still analyzed.
 * - `mv`/`cp`/`tar`/`rsync`/`scp`/`dd` sources are classified as reads, closing the
 *   "cp /etc/passwd ." hole where a copy smuggled a system or secrets read.
 */

export interface BashToken {
  text: string;
  start: number;
  end: number;
  /** Quote style of the token (quotes are stripped from text). */
  quote: "none" | "single" | "double";
  kind: "word" | "sep" | "redir" | "glob";
  /** `$VAR` / `${VAR}` names found inside the token (used for home/temp expansion). */
  expansions: string[];
}

export interface BashTarget {
  /** Original text with quotes preserved (`command.slice(start, end)`) — used to reconstruct rewritten commands. */
  raw: string;
  /** Unquoted token text — used for path classification. */
  unquoted: string;
  start: number;
  end: number;
  /** True when the target contains glob metacharacters (* ? [ ). */
  wildcard: boolean;
  /** True when the target contains an environment variable that must be resolved. */
  expansion: boolean;
}

export type IntentKind =
  | "delete"
  | "write"
  | "read"
  | "git-destructive"
  | "git-rm"
  | "python-rm"
  | "node-rm"
  | "xargs-rm"
  | "rsync-delete"
  | "shred"
  | "truncate"
  | "find-delete"
  | "find-exec-rm"
  | "nested-shell"
  | "script-stdin"
  | "script-file";

export interface BashIntent {
  type: "delete" | "write" | "read" | "block";
  kind: IntentKind;
  /** Lowercased command name (e.g. "rm", "find", "cat", "mv", ">" for a redirection). */
  command: string;
  flags: string[];
  targets: BashTarget[];
  /** Span of the command token (and flags) to replace in a rewrite. */
  segmentStart: number;
  segmentEnd: number;
  /** True for deletes that would remove a whole directory tree (`rm -rf .`, `rm -rf *`). */
  broad: boolean;
  /** True when the intent was found inside an embedded script (`sh -c`, `eval`, `find -exec`); it cannot be rewritten, only zone-checked or blocked. */
  nested?: boolean;
  /** Working directory from a preceding `cd`; relative targets must be classified against it. */
  cdBase?: BashTarget;
  /** A preceding `cd -` / bare `cd` / unresolvable `cd $VAR`: relative paths after it cannot be trusted. */
  cdUnsafe?: boolean;
}

export interface BashAnalysis {
  command: string;
  intents: BashIntent[];
}

const WRAPPER_COMMANDS = new Set(["sudo", "doas", "command", "builtin", "env", "nice", "time", "nohup", "timeout", "setsid", "taskset", "exec"]);

/** Shell keywords that end a command segment: the next word starts a new command. */
const SHELL_KEYWORDS = new Set(["for", "do", "done", "while", "until", "if", "then", "else", "elif", "fi", "case", "esac", "in", "function", "{"]);

/** Interpreters whose `-c` code is re-analyzed recursively, and the flags that carry the code. */
const INTERPRETER_FLAGS: Record<string, string[]> = {
  sh: ["-c", "-C"],
  bash: ["-c", "-C"],
  zsh: ["-c", "-C"],
  dash: ["-c", "-C"],
  ksh: ["-c", "-C"],
  ash: ["-c", "-C"],
  fish: ["-c", "-C"],
  pwsh: ["-c", "-C", "-Command", "-command"],
  powershell: ["-c", "-C", "-Command", "-command"],
  cmd: ["/c"],
};
const INTERPRETER_COMMANDS = new Set(Object.keys(INTERPRETER_FLAGS));

/** PowerShell verbs that delete files (case-insensitive, aliases included). */
const POWERSHELL_DELETE = /\b(remove-item|rm|del|erase|rd|rmdir|clear-content)\b/i;
/** cmd.exe verbs that delete files. */
const CMD_DELETE = /\b(del|erase|rd|rmdir)\b/i;

export function analyzeBashCommand(command: string): BashAnalysis {
  const tokens = tokenize(command);
  const intents: BashIntent[] = [];
  // cd events in token order (used by both the command walk and the redirection walk).
  const cdEvents: Array<{ index: number; target?: BashTarget; unsafe: boolean }> = [];
  let currentCd: { target?: BashTarget; unsafe: boolean } | undefined;
  let wrapped = false;

  const cdSpread = () => (currentCd ? (currentCd.target ? { cdBase: currentCd.target } : { cdUnsafe: true }) : {});

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") {
      // A closing parenthesis ends a subshell: its `cd` does not leak to the outer shell.
      if (token.kind === "sep" && token.text === ")") {
        currentCd = undefined;
        cdEvents.push({ index: i, unsafe: false });
      }
      wrapped = false;
      continue;
    }
    const rawName = token.text.toLowerCase();
    const name = rawName.replace(/\.exe$/, "");
    if (WRAPPER_COMMANDS.has(name)) { wrapped = true; continue; }
    if (SHELL_KEYWORDS.has(name)) { wrapped = true; continue; }
    const previous = i > 0 ? tokens[i - 1]! : undefined;
    const startsSegment = wrapped || !previous || previous.kind === "sep" || previous.kind === "redir";
    wrapped = false;
    if (!startsSegment) continue;

    const args = collectArgs(command, tokens, i + 1);
    switch (name) {
      case "rm":
      case "unlink":
      case "rmdir": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        const flags = args.words.filter((arg) => isFlag(arg.text)).map((arg) => arg.text);
        const broad = isBroadDelete(targets, flags);
        intents.push({ type: "delete", kind: "delete", command: name, flags, targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad, ...cdSpread() });
        break;
      }
      case "del":
      case "rd": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        intents.push({ type: "delete", kind: "delete", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: isBroadDelete(targets, []), ...cdSpread() });
        break;
      }
      case "shred": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        intents.push({ type: "block", kind: "shred", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        break;
      }
      case "truncate": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        intents.push({ type: "delete", kind: "truncate", command: name, flags: args.words.filter((arg) => isFlag(arg.text)).map((arg) => arg.text), targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        break;
      }
      case "find": {
        // Paths are the leading args before the first expression item (`-name`, `-type`, `(`, `!`, ...).
        const pathArgs: ArgToken[] = [];
        for (const word of args.words) {
          if (word.text.startsWith("-") || word.text === "(" || word.text === "!") break;
          pathArgs.push(word);
        }
        const findFlags = args.words.filter((arg) => isFlag(arg.text));
        const deleteToken = args.words.find((arg) => arg.text === "-delete");
        const execIndex = args.words.findIndex((arg) => arg.text === "-exec" || arg.text === "-execdir");
        if (deleteToken) {
          intents.push({ type: "delete", kind: "find-delete", command: "find", flags: findFlags.map((arg) => arg.text), targets: pathArgs, segmentStart: deleteToken.start, segmentEnd: deleteToken.end, broad: false, ...cdSpread() });
        } else if (execIndex >= 0) {
          // `-exec rm {} +`, `-exec sh -c 'rm {}' +`, `-exec cp {} ~/x \;` — re-analyze the
          // exec body. Any delete or block inside makes the whole find destructive; write/read
          // intents are surfaced for zone checks.
          const execCode = args.words.slice(execIndex + 1).map((arg) => arg.text).join(" ");
          const nested = analyzeBashCommand(execCode);
          const unsafe = nested.intents.some((intent) => intent.type === "delete" || intent.type === "block");
          if (unsafe) {
            intents.push({ type: "block", kind: "find-exec-rm", command: "find", flags: [], targets: pathArgs, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, nested: true, ...cdSpread() });
          } else {
            for (const intent of nested.intents) {
              intents.push({ ...intent, nested: true, ...cdSpread() });
            }
          }
        }
        break;
      }
      case "git": {
        const subcommand = args.words[0]?.text.toLowerCase();
        const rest = args.words.slice(1);
        const hasForce = rest.some((arg) => /^-f/.test(arg.text) || arg.text === "--force");
        const hasHard = rest.some((arg) => arg.text === "--hard");
        const destructive =
          (subcommand === "clean" && hasForce) ||
          (subcommand === "reset" && hasHard) ||
          (subcommand === "checkout" && rest.some((arg) => arg.text === "--")) ||
          (subcommand === "restore" && rest.some((arg) => arg.text === "." || arg.text === "--")) ||
          (subcommand === "branch" && rest.some((arg) => arg.text === "-D" || arg.text === "--delete")) ||
          (subcommand === "stash" && rest.some((arg) => arg.text === "drop" || arg.text === "clear"));
        if (destructive) {
          intents.push({ type: "block", kind: "git-destructive", command: "git", flags: rest.map((arg) => arg.text), targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        } else if (subcommand === "rm") {
          // `git rm` deletes files from the working tree and stages the removal.
          const targets = rest.filter((arg) => !isFlag(arg.text));
          intents.push({ type: "block", kind: "git-rm", command: "git", flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        }
        break;
      }
      case "python":
      case "python3":
      case "py": {
        const codeArg = args.words.find((arg) => arg.text === "-c");
        if (codeArg) {
          if (hasPythonDelete(args.words)) {
            intents.push({ type: "block", kind: "python-rm", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
          }
          break; // -c code is the whole program; trailing args are argv
        }
        for (const intent of interpreterStdinOrFile(name, args, previous, token.start, lastEnd(args.words, token.end))) intents.push(intent);
        break;
      }
      case "node":
      case "bun":
      case "deno": {
        const codeArg = args.words.find((arg) => arg.text === "-e" || arg.text === "-c");
        if (codeArg) {
          if (hasNodeDelete(args.words)) {
            intents.push({ type: "block", kind: "node-rm", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
          }
          break;
        }
        for (const intent of interpreterStdinOrFile(name, args, previous, token.start, lastEnd(args.words, token.end))) intents.push(intent);
        break;
      }
      case "ruby": {
        const codeArg = args.words.find((arg) => arg.text === "-e");
        if (codeArg) {
          if (hasRubyDelete(args.words)) {
            intents.push({ type: "block", kind: "python-rm", command: "ruby", flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
          }
          break;
        }
        for (const intent of interpreterStdinOrFile(name, args, previous, token.start, lastEnd(args.words, token.end))) intents.push(intent);
        break;
      }
      case "perl": {
        const codeArg = args.words.find((arg) => arg.text === "-e");
        if (codeArg) {
          if (hasPerlDelete(args.words)) {
            intents.push({ type: "block", kind: "python-rm", command: "perl", flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
          }
          break;
        }
        for (const intent of interpreterStdinOrFile(name, args, previous, token.start, lastEnd(args.words, token.end))) intents.push(intent);
        break;
      }
      case "php": {
        const codeArg = args.words.find((arg) => arg.text === "-r");
        if (codeArg) {
          if (hasPhpDelete(args.words)) {
            intents.push({ type: "block", kind: "python-rm", command: "php", flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
          }
          break;
        }
        for (const intent of interpreterStdinOrFile(name, args, previous, token.start, lastEnd(args.words, token.end))) intents.push(intent);
        break;
      }
      case "xargs": {
        const later = args.words.map((arg) => arg.text.toLowerCase());
        if (later.some((arg) => ["rm", "rmdir", "unlink", "shred"].includes(arg))) {
          intents.push({ type: "block", kind: "xargs-rm", command: "xargs", flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        }
        break;
      }
      case "rsync": {
        if (args.words.some((arg) => arg.text === "--delete" || arg.text === "--del")) {
          intents.push({ type: "block", kind: "rsync-delete", command: "rsync", flags: [], targets: args.words.filter((arg) => !isFlag(arg.text)), segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        } else {
          const dest = destinationOf(args.words);
          const sources = dest ? args.words.filter((word) => word !== dest && !isFlag(word.text) && !word.unquoted.includes(":")) : args.words.filter((word) => !isFlag(word.text) && !word.unquoted.includes(":"));
          if (sources.length) {
            intents.push({ type: "read", kind: "read", command: "rsync", flags: [], targets: sources, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
          }
          if (dest && !dest.unquoted.includes(":")) {
            intents.push({ type: "write", kind: "write", command: "rsync", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false, ...cdSpread() });
          }
        }
        break;
      }
      case "mv":
      case "cp":
      case "install": {
        const dest = destinationOf(args.words);
        const sources = dest ? args.words.filter((word) => word !== dest) : args.words.filter((word) => !isFlag(word.text));
        if (sources.length) {
          intents.push({ type: "read", kind: "read", command: name, flags: [], targets: sources, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        }
        if (dest) {
          intents.push({ type: "write", kind: "write", command: name, flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false, ...cdSpread() });
        }
        break;
      }
      case "dd": {
        const ifTarget = args.words.find((word) => word.unquoted.startsWith("if="));
        const ofTarget = args.words.find((word) => word.unquoted.startsWith("of="));
        if (ifTarget) {
          const target = { ...ifTarget, raw: ifTarget.raw.slice(3), unquoted: ifTarget.unquoted.slice(3), text: ifTarget.text.slice(3) };
          intents.push({ type: "read", kind: "read", command: "dd", flags: [], targets: [target], segmentStart: token.start, segmentEnd: target.end, broad: false, ...cdSpread() });
        }
        if (ofTarget) {
          const target = { ...ofTarget, raw: ofTarget.raw.slice(3), unquoted: ofTarget.unquoted.slice(3), text: ofTarget.text.slice(3) };
          intents.push({ type: "write", kind: "write", command: "dd", flags: [], targets: [target], segmentStart: token.start, segmentEnd: target.end, broad: false, ...cdSpread() });
        }
        break;
      }
      case "tee": {
        const dest = args.words.find((arg) => !isFlag(arg.text));
        if (dest) intents.push({ type: "write", kind: "write", command: "tee", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false, ...cdSpread() });
        break;
      }
      case "curl": {
        const dest = flagValue(args.words, ["-o", "--output"]) ?? args.words.find((arg) => !isFlag(arg.text) && !arg.text.startsWith("http://") && !arg.text.startsWith("https://"));
        if (dest) intents.push({ type: "write", kind: "write", command: "curl", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false, ...cdSpread() });
        break;
      }
      case "wget": {
        const dest = flagValue(args.words, ["-O", "--output-document"]);
        if (dest) intents.push({ type: "write", kind: "write", command: "wget", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false, ...cdSpread() });
        break;
      }
      case "scp": {
        const dest = args.words[args.words.length - 1];
        const sources = dest ? args.words.slice(0, -1).filter((word) => !isFlag(word.text) && !word.unquoted.includes(":")) : [];
        if (sources.length) {
          intents.push({ type: "read", kind: "read", command: "scp", flags: [], targets: sources, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        }
        if (dest && !dest.text.includes(":")) {
          intents.push({ type: "write", kind: "write", command: "scp", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false, ...cdSpread() });
        }
        break;
      }
      case "tar": {
        const archive = tarArchiveOf(args.words);
        const cFlag = flagValue(args.words, ["-C", "--directory"]);
        const create = args.words.some((word) => /^-c/.test(word.text) || word.text === "--create");
        const extract = args.words.some((word) => /^-x/.test(word.text) || word.text === "--extract" || word.text === "--get");
        if (create) {
          if (cFlag) intents.push({ type: "write", kind: "write", command: "tar", flags: [], targets: [cFlag], segmentStart: token.start, segmentEnd: cFlag.end, broad: false, ...cdSpread() });
          if (archive) intents.push({ type: "write", kind: "write", command: "tar", flags: [], targets: [archive], segmentStart: token.start, segmentEnd: archive.end, broad: false, ...cdSpread() });
          const sources = args.words.filter((word) => !isFlag(word.text) && word !== archive && word !== cFlag);
          if (sources.length) {
            intents.push({ type: "read", kind: "read", command: "tar", flags: [], targets: sources, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
          }
        } else if (extract) {
          if (archive) intents.push({ type: "read", kind: "read", command: "tar", flags: [], targets: [archive], segmentStart: token.start, segmentEnd: archive.end, broad: false, ...cdSpread() });
          if (cFlag) intents.push({ type: "write", kind: "write", command: "tar", flags: [], targets: [cFlag], segmentStart: token.start, segmentEnd: cFlag.end, broad: false, ...cdSpread() });
        }
        break;
      }
      case "sed":
      case "awk": {
        const inPlace = args.words.some((arg) => /^-i/.test(arg.text));
        const targets = args.words.filter((arg) => !isFlag(arg.text) && !isScript(arg.text));
        if (inPlace && targets.length) {
          intents.push({ type: "write", kind: "write", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        } else if (targets.length) {
          intents.push({ type: "read", kind: "read", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        }
        break;
      }
      case "cat":
      case "type":
      case "less":
      case "more":
      case "head":
      case "tail":
      case "grep":
      case "egrep":
      case "fgrep":
      case "diff":
      case "wc":
      case "strings":
      case "od":
      case "xxd":
      case "hexdump":
      case "base64":
      case "sort":
      case "uniq":
      case "nl":
      case "tac":
      case "fold":
      case "cut":
      case "paste":
      case "comm":
      case "cmp":
      case "file":
      case "stat":
      case "du":
      case "df":
      case "ls":
      case "dir":
      case "sha256sum":
      case "sha1sum":
      case "md5sum":
      case "cksum": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        if (targets.length) {
          intents.push({ type: "read", kind: "read", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
        }
        break;
      }
      case "cd": {
        const first = args.words.find((arg) => !isFlag(arg.text) && arg.text !== "--");
        if (first && first.unquoted !== "-") {
          currentCd = { target: first, unsafe: false };
          cdEvents.push({ index: i, target: first, unsafe: false });
        } else {
          // Bare `cd` goes home, `cd -` to the previous directory — neither is a safe base
          // for classifying the relative paths that follow.
          currentCd = { unsafe: true };
          cdEvents.push({ index: i, unsafe: true });
        }
        break;
      }
      case "eval": {
        const code = args.words.map((arg) => arg.text).join(" ");
        if (code.trim()) {
          for (const intent of analyzeBashCommand(code).intents) {
            intents.push({ ...intent, nested: true });
          }
        }
        break;
      }
      case "source":
      case ".": {
        const script = args.words.find((arg) => !isFlag(arg.text));
        if (script) {
          intents.push({ type: "block", kind: "script-file", command: name, flags: [], targets: [script], segmentStart: token.start, segmentEnd: script.end, broad: false, ...cdSpread() });
        }
        break;
      }
      default: {
        if (name.startsWith("./") || name.startsWith("../")) {
          // Direct execution of a script in the working directory (`./deploy.sh`).
          intents.push({ type: "block", kind: "script-file", command: name, flags: [], targets: [targetOf(command, token)], segmentStart: token.start, segmentEnd: token.end, broad: false, ...cdSpread() });
          break;
        }
        if (INTERPRETER_COMMANDS.has(name)) {
          for (const intent of interpreterIntents(name, args, previous, token)) {
            intents.push(intent);
          }
        } else if (name === "busybox") {
          const sub = args.words[0]?.text.toLowerCase();
          if (sub === "sh" || sub === "ash") {
            const inner = { ...args, words: args.words.slice(1) };
            for (const intent of interpreterIntents(sub, inner, previous, token)) intents.push(intent);
          } else if (sub === "rm" || sub === "rmdir" || sub === "unlink") {
            const targets = args.words.slice(1).filter((arg) => !isFlag(arg.text));
            intents.push({ type: "delete", kind: "delete", command: `busybox ${sub}`, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false, ...cdSpread() });
          }
        }
        break;
      }
    }
  }
  // Redirection-based writes/reads (e.g. `: > file`, `echo x > file`, `cat < file`).
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "redir") continue;
    const next = tokens[i + 1];
    if (!next || next.kind !== "word") continue;
    const target = targetOf(command, next);
    if (token.text.endsWith(">")) {
      // Writes to the null device are no-ops, not file writes.
      if (target.unquoted.toLowerCase() === "/dev/null" || target.unquoted.toLowerCase() === "nul") continue;
      intents.push({ type: "write", kind: "write", command: ">", flags: [], targets: [target], segmentStart: token.start, segmentEnd: next.end, broad: false, ...cdForIndex(cdEvents, i) });
    } else if (token.text.endsWith("<")) {
      intents.push({ type: "read", kind: "read", command: "<", flags: [], targets: [target], segmentStart: token.start, segmentEnd: next.end, broad: false, ...cdForIndex(cdEvents, i) });
    }
  }
  return { command, intents };
}

// ---------------------------------------------------------------------------
// Interpreters (sh -c, eval, stdin, script files)
// ---------------------------------------------------------------------------

function interpreterIntents(name: string, args: { words: ArgToken[] }, previous: BashToken | undefined, token: BashToken): BashIntent[] {
  const codeFlags = INTERPRETER_FLAGS[name] ?? ["-c"];
  const flagIndexes: number[] = [];
  for (let i = 0; i < args.words.length; i++) {
    if (codeFlags.includes(args.words[i]!.unquoted)) flagIndexes.push(i);
  }
  if (flagIndexes.length > 0) {
    // The last code flag wins (bash: later -c overrides earlier).
    const code = args.words.slice(flagIndexes[flagIndexes.length - 1]! + 1).map((word) => word.unquoted).join(" ");
    if (!code.trim()) return [];
    if (name === "pwsh" || name === "powershell") {
      if (POWERSHELL_DELETE.test(code)) {
        return [{ type: "block", kind: "nested-shell", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: token.end, broad: false, nested: true }];
      }
      return [];
    }
    if (name === "cmd") {
      if (CMD_DELETE.test(code)) {
        return [{ type: "block", kind: "nested-shell", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: token.end, broad: false, nested: true }];
      }
      return [];
    }
    return analyzeBashCommand(code).intents.map((intent) => ({ ...intent, nested: true }));
  }
  const rest = args.words.filter((word) => !isFlag(word.text));
  const readsStdin = rest.some((word) => word.unquoted === "-") || (previous !== undefined && (previous.text === "|" || previous.text === "|&"));
  if (readsStdin) {
    return [{ type: "block", kind: "script-stdin", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false }];
  }
  const script = rest.find((word) => word.unquoted !== "-");
  if (script) {
    return [{ type: "block", kind: "script-file", command: name, flags: [], targets: [script], segmentStart: token.start, segmentEnd: script.end, broad: false }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export function tokenize(command: string): BashToken[] {
  const tokens: BashToken[] = [];
  let i = 0;
  let current: BashToken | undefined;
  const length = command.length;

  const pushWord = () => {
    if (current && current.text.length > 0) {
      current.kind = /[*?[]/.test(current.text) ? "glob" : "word";
      tokens.push(current);
    }
    current = undefined;
  };

  while (i < length) {
    const char = command[i]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      pushWord();
      if (char === "\n" && !isInWord(tokens, current)) {
        tokens.push({ text: "\n", start: i, end: i + 1, quote: "none", kind: "sep", expansions: [] });
      }
      i++;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      pushWord();
      let text = char;
      let end = i + 1;
      if ((char === "&" || char === "|") && command[i + 1] === char) {
        text = char + char;
        end = i + 2;
      } else if (char === "|" && command[i + 1] === "&") {
        text = "|&";
        end = i + 2;
      }
      tokens.push({ text, start: i, end, quote: "none", kind: "sep", expansions: [] });
      i = end;
      continue;
    }
    if (char === ">" || char === "<") {
      pushWord();
      let text = char;
      let end = i + 1;
      // 2>file, >>file, &>file, <file
      if (command[i + 1] === ">" || command[i + 1] === "<") {
        text += command[i + 1];
        end = i + 2;
      }
      tokens.push({ text, start: i, end, quote: "none", kind: "redir", expansions: [] });
      i = end;
      continue;
    }
    if (char === "'") {
      if (!current) current = startToken(command, i);
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? length : close + 1;
      current.text += command.slice(i + 1, close === -1 ? length : close);
      current.quote = "single";
      current.end = end;
      i = end;
      continue;
    }
    if (char === '"') {
      if (!current) current = startToken(command, i);
      let j = i + 1;
      let text = "";
      while (j < length && command[j] !== '"') {
        if (command[j] === "$") {
          // Record $VAR / ${VAR} expansions even inside double quotes, so `rm "$f"`
          // in a loop is recognized as a variable (unresolvable -> blocked), not a
          // literal filename.
          const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)[^}]*}|([0-9]+))/.exec(command.slice(j));
          if (match) {
            const name = match[1] ?? match[2] ?? match[3]!;
            current.expansions.push(name);
            text += match[0];
            j += match[0].length;
            continue;
          }
          text += "$";
          j++;
          continue;
        }
        if (command[j] === "\\" && j + 1 < length && (command[j + 1] === '"' || command[j + 1] === "\\" || command[j + 1] === "$")) {
          text += command[j + 1];
          j += 2;
          continue;
        }
        if (command[j] === "\\" && j + 1 < length) {
          text += command[j];
          j++;
          continue;
        }
        text += command[j];
        j++;
      }
      const end = j < length ? j + 1 : j;
      current.text += text;
      current.quote = "double";
      current.end = end;
      i = end;
      continue;
    }
    if (char === "\\") {
      if (!current) current = startToken(command, i);
      if (i + 1 < length) {
        current.text += command[i + 1];
        current.end = i + 2;
        i += 2;
      } else {
        current.text += "\\";
        current.end = i + 1;
        i += 1;
      }
      continue;
    }
    if (char === "$") {
      if (!current) current = startToken(command, i);
      const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)[^}]*}|([0-9]+))/.exec(command.slice(i));
      if (match) {
        const name = match[1] ?? match[2] ?? match[3]!;
        current.expansions.push(name);
        const consumed = match[0];
        current.text += `$${name}`;
        current.end = i + consumed.length;
        i += consumed.length;
      } else {
        current.text += "$";
        current.end = i + 1;
        i += 1;
      }
      continue;
    }
    // Redirection with a file descriptor prefix (2> file) — the digit belongs to the redir token.
    if ((char === "2" || char === "1") && (command[i + 1] === ">" || command[i + 1] === "<")) {
      pushWord();
      let text = char;
      let end = i + 2;
      if (command[i + 2] === ">" || command[i + 2] === "<") {
        text += command[i + 2];
        end = i + 3;
      }
      tokens.push({ text, start: i, end, quote: "none", kind: "redir", expansions: [] });
      i = end;
      continue;
    }
    if (!current) current = startToken(command, i);
    current.text += char;
    current.end = i + 1;
    i++;
  }
  pushWord();
  return tokens;
}

function startToken(command: string, start: number): BashToken {
  return { text: "", start, end: start, quote: "none", kind: "word", expansions: [] };
}

function isInWord(tokens: BashToken[], current: BashToken | undefined): boolean {
  return current !== undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ArgToken extends BashTarget {
  quote: "none" | "single" | "double";
  /** Alias of `unquoted` for flag/pattern matching (flags are never quoted). */
  text: string;
}

/** Collect the word args following a command token, stopping at separators or redirections. */
function collectArgs(command: string, tokens: BashToken[], from: number): { words: ArgToken[]; end: number } {
  const words: ArgToken[] = [];
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "sep") break;
    if (token.kind === "redir") break;
    if (token.kind === "word" || token.kind === "glob") {
      words.push({ ...targetOf(command, token), quote: token.quote, text: token.text });
    }
  }
  return { words, end: from };
}

function targetOf(command: string, token: BashToken): BashTarget {
  return {
    raw: command.slice(token.start, token.end),
    unquoted: token.text,
    start: token.start,
    end: token.end,
    wildcard: /[*?[]/.test(token.text),
    expansion: token.expansions.length > 0,
  };
}

/** Effective cd base for a token at `index` (used by the redirection walk). */
function cdForIndex(events: Array<{ index: number; target?: BashTarget; unsafe: boolean }>, index: number): { cdBase?: BashTarget; cdUnsafe?: boolean } {
  for (let j = events.length - 1; j >= 0; j--) {
    const event = events[j]!;
    if (event.index >= index) continue;
    if (event.target) return { cdBase: event.target };
    return event.unsafe ? { cdUnsafe: true } : {};
  }
  return {};
}

function isFlag(target: string | { unquoted: string }): boolean {
  const text = typeof target === "string" ? target : target.unquoted;
  return text.startsWith("-") && text !== "-" && text !== "--";
}

function isScript(text: string): boolean {
  return text.startsWith("-") || text.startsWith("s/") || text.startsWith("{") || text.startsWith("'");
}

function lastEnd(words: ArgToken[], fallback: number): number {
  return words.length > 0 ? words[words.length - 1]!.end : fallback;
}

function isBroadDelete(targets: ArgToken[], flags: string[]): boolean {
  const recursive = flags.some((flag) => /-r/.test(flag) || flag === "--recursive");
  if (!recursive) return false;
  return targets.some((target) => target.raw === "." || target.raw === "./" || target.raw === ".." || target.raw === "../" || target.wildcard);
}

/** Destination of a copy/move-style command: `-t <dir>` flag value, or the last arg. */
function destinationOf(words: ArgToken[], ofFlag?: string): ArgToken | undefined {
  if (ofFlag) {
    const of = words.find((word) => word.unquoted.startsWith(`${ofFlag}=`));
    if (of) return { ...of, raw: of.raw.slice(ofFlag.length + 1), unquoted: of.unquoted.slice(ofFlag.length + 1), text: of.unquoted.slice(ofFlag.length + 1) };
  }
  const tIndex = words.findIndex((word) => word.unquoted === "-t" || word.unquoted === "--target-directory");
  if (tIndex >= 0 && tIndex + 1 < words.length) return words[tIndex + 1]!;
  const last = words[words.length - 1];
  return last && !isFlag(last) ? last : undefined;
}

function flagValue(words: ArgToken[], flags: string[]): ArgToken | undefined {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    for (const flag of flags) {
      if (word.unquoted === flag && i + 1 < words.length) return words[i + 1]!;
      if (word.unquoted.startsWith(`${flag}=`)) {
        const sliced = word.unquoted.slice(flag.length + 1);
        return { ...word, raw: sliced, unquoted: sliced, text: sliced };
      }
    }
  }
  return undefined;
}

/** Archive file for tar: value of `-f`/`--file`, including combined flags like `-czf`. */
function tarArchiveOf(words: ArgToken[]): ArgToken | undefined {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const equals = /^--file=(.*)$/.exec(word.unquoted);
    if (equals) return { ...word, raw: equals[1]!, unquoted: equals[1]!, text: equals[1]! };
    if (word.unquoted === "--file" && i + 1 < words.length) return words[i + 1]!;
    if (/^-[a-zA-Z]*f/.test(word.unquoted) && i + 1 < words.length) return words[i + 1]!;
  }
  return undefined;
}

function hasPythonDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-c").map((word) => word.unquoted).join(" ");
  return /(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|pathlib\.Path\([^)]*\)\.(?:unlink|rmdir)|send2trash)/.test(code);
}

function hasNodeDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-e" && word.unquoted !== "-c").map((word) => word.unquoted).join(" ");
  // `fs.unlinkSync` and `require('fs').unlinkSync` are both common shapes; the require
  // form is handled explicitly because the module name sits inside quotes in the text.
  // `node:fs` and `fs/promises` spellings are included too.
  return /(?:require\(['"](?:node:)?fs(?:\/promises)?['"]\)|(?:^|[.;\s])fs)\.(?:unlinkSync?|rmSync?|rmdirSync?|promises\.(?:unlink|rm|rmdir))|rm\.removeSync?|\.remove\(\)/i.test(code);
}

function hasRubyDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-e").map((word) => word.unquoted).join(" ");
  return /File\.(?:delete|unlink)|\brm_rf\b|remove_entry|Dir\.(?:delete|rmdir)|FileUtils\.rm_rf/.test(code);
}

function hasPerlDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-e").map((word) => word.unquoted).join(" ");
  return /\bunlink\b|\brmdir\b|remove_tree|File::Path/.test(code);
}

function hasPhpDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-r").map((word) => word.unquoted).join(" ");
  return /\bunlink\b|\brmdir\b|unlink\(/.test(code);
}

/** Interpreters that read a script from stdin (`-` or a pipe) or from a script file get flagged. */
function interpreterStdinOrFile(name: string, args: { words: ArgToken[] }, previous: BashToken | undefined, segmentStart: number, segmentEnd: number): BashIntent[] {
  const nonFlags = args.words.filter((word) => !isFlag(word.text));
  const readsStdin = nonFlags.some((word) => word.unquoted === "-") || (previous !== undefined && (previous.text === "|" || previous.text === "|&"));
  if (readsStdin) {
    return [{ type: "block", kind: "script-stdin", command: name, flags: [], targets: [], segmentStart, segmentEnd, broad: false }];
  }
  const script = nonFlags.find((word) => word.unquoted !== "-");
  if (script) {
    return [{ type: "block", kind: "script-file", command: name, flags: [], targets: [script], segmentStart, segmentEnd, broad: false }];
  }
  return [];
}
