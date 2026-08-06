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
  | "python-rm"
  | "node-rm"
  | "xargs-rm"
  | "rsync-delete"
  | "shred"
  | "truncate"
  | "find-delete"
  | "find-exec-rm";

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
}

export interface BashAnalysis {
  command: string;
  intents: BashIntent[];
}

const WRAPPER_COMMANDS = new Set(["sudo", "doas", "command", "env", "nice", "time", "nohup", "timeout", "setsid", "taskset"]);

export function analyzeBashCommand(command: string): BashAnalysis {
  const tokens = tokenize(command);
  const intents: BashIntent[] = [];
  let wrapped = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") { wrapped = false; continue; }
    const name = token.text.toLowerCase();
    if (WRAPPER_COMMANDS.has(name)) { wrapped = true; continue; }
    // Only treat as a command when it starts a segment (or is the very first token,
    // or follows a wrapper such as sudo).
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
        intents.push({ type: "delete", kind: "delete", command: name, flags, targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad });
        break;
      }
      case "del":
      case "rd": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        intents.push({ type: "delete", kind: "delete", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: isBroadDelete(targets, []) });
        break;
      }
      case "shred": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        intents.push({ type: "block", kind: "shred", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        break;
      }
      case "truncate": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        intents.push({ type: "delete", kind: "truncate", command: name, flags: args.words.filter((arg) => isFlag(arg.text)).map((arg) => arg.text), targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
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
          intents.push({ type: "delete", kind: "find-delete", command: "find", flags: findFlags.map((arg) => arg.text), targets: pathArgs, segmentStart: deleteToken.start, segmentEnd: deleteToken.end, broad: false });
        } else if (execIndex >= 0) {
          const execArgs = args.words.slice(execIndex + 1);
          if (execArgs.some((arg) => ["rm", "rmdir", "unlink", "shred"].includes(arg.text.toLowerCase()))) {
            intents.push({ type: "block", kind: "find-exec-rm", command: "find", flags: [], targets: pathArgs, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
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
        }
        break;
      }
      case "python":
      case "python3":
      case "py": {
        const codeArg = args.words.find((arg) => arg.text === "-c");
        if (codeArg && hasPythonDelete(args.words)) {
          intents.push({ type: "block", kind: "python-rm", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        }
        break;
      }
      case "node":
      case "bun":
      case "deno": {
        const codeArg = args.words.find((arg) => arg.text === "-e" || arg.text === "-c");
        if (codeArg && hasNodeDelete(args.words)) {
          intents.push({ type: "block", kind: "node-rm", command: name, flags: [], targets: [], segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        }
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
          if (dest) intents.push({ type: "write", kind: "write", command: "rsync", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false });
        }
        break;
      }
      case "mv":
      case "cp":
      case "install":
      case "dd": {
        const dest = destinationOf(args.words, name === "dd" ? "of" : undefined);
        if (dest) intents.push({ type: "write", kind: "write", command: name, flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false });
        break;
      }
      case "tee": {
        const dest = args.words.find((arg) => !isFlag(arg.text));
        if (dest) intents.push({ type: "write", kind: "write", command: "tee", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false });
        break;
      }
      case "curl": {
        const dest = flagValue(args.words, ["-o", "--output"]) ?? args.words.find((arg) => !isFlag(arg.text) && !arg.text.startsWith("http://") && !arg.text.startsWith("https://"));
        if (dest) intents.push({ type: "write", kind: "write", command: "curl", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false });
        break;
      }
      case "wget": {
        const dest = flagValue(args.words, ["-O", "--output-document"]);
        if (dest) intents.push({ type: "write", kind: "write", command: "wget", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false });
        break;
      }
      case "scp": {
        const dest = args.words[args.words.length - 1];
        if (dest && !dest.text.includes(":")) intents.push({ type: "write", kind: "write", command: "scp", flags: [], targets: [dest], segmentStart: token.start, segmentEnd: dest.end, broad: false });
        break;
      }
      case "tar": {
        const cFlag = flagValue(args.words, ["-C", "--directory"]);
        if (cFlag) intents.push({ type: "write", kind: "write", command: "tar", flags: [], targets: [cFlag], segmentStart: token.start, segmentEnd: cFlag.end, broad: false });
        break;
      }
      case "sed":
      case "awk": {
        const inPlace = args.words.some((arg) => /^-i/.test(arg.text));
        const targets = args.words.filter((arg) => !isFlag(arg.text) && !isScript(arg.text));
        if (inPlace && targets.length) {
          intents.push({ type: "write", kind: "write", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        } else if (targets.length) {
          intents.push({ type: "read", kind: "read", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
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
      case "sha256sum":
      case "sha1sum":
      case "md5sum":
      case "cksum": {
        const targets = args.words.filter((arg) => !isFlag(arg.text));
        if (targets.length) {
          intents.push({ type: "read", kind: "read", command: name, flags: [], targets, segmentStart: token.start, segmentEnd: lastEnd(args.words, token.end), broad: false });
        }
        break;
      }
      default:
        break;
    }
  }
  // Redirection-based writes/reads (e.g. `: > file`, `echo x > file`, `cat < file`).
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "redir") continue;
    const next = tokens[i + 1];
    if (!next || next.kind !== "word") continue;
    if (token.text.endsWith(">")) {
      intents.push({ type: "write", kind: "write", command: ">", flags: [], targets: [targetOf(command, next)], segmentStart: token.start, segmentEnd: next.end, broad: false });
    } else if (token.text.endsWith("<")) {
      intents.push({ type: "read", kind: "read", command: "<", flags: [], targets: [targetOf(command, next)], segmentStart: token.start, segmentEnd: next.end, broad: false });
    }
  }
  return { command, intents };
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
      const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)}|([0-9]+))/.exec(command.slice(i));
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

function hasPythonDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-c").map((word) => word.unquoted).join(" ");
  return /(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|pathlib\.Path\([^)]*\)\.(?:unlink|rmdir)|send2trash)/.test(code);
}

function hasNodeDelete(words: ArgToken[]): boolean {
  const code = words.filter((word) => !isFlag(word) && word.unquoted !== "-e" && word.unquoted !== "-c").map((word) => word.unquoted).join(" ");
  // `fs.unlinkSync` and `require('fs').unlinkSync` are both common shapes; the require
  // form is handled explicitly because the module name sits inside quotes in the text.
  return /(?:require\(['"]fs['"]\)|fs)\.(?:unlinkSync?|rmSync?|rmdirSync?|promises\.(?:unlink|rm|rmdir))|rm\.removeSync?|\.remove\(\)/i.test(code);
}
