/**
 * Path canonicalization and zone classification.
 *
 * The whole safety engine compares paths in one canonical form so that the same
 * filesystem location written in different styles — `C:\Users\x`, `c:/users/x`,
 * `/mnt/c/Users/x`, `/c/Users/x` — all collapse to the same key. Deletion rewrites
 * always reconstruct the command from the agent's original path text, so
 * canonicalization never changes what the shell actually runs.
 */

import { homedir } from "node:os";
import { basename } from "node:path";

export type PathZone =
  /** Inside the project workspace (the agent's working directory). */
  | "workspace"
  /** Inside `<workspace>/.fitz-trash` — the agent trash; never touched by the agent. */
  | "protected"
  /** Inside a Fitz runtime directory the agent legitimately owns (pi agent dir, llm root, logs, cache, snapshots). */
  | "runtime"
  /** Inside the OS temp directory. */
  | "temp"
  /** A secrets-bearing location outside the workspace (home .ssh/.aws/.env, AppData, key files). */
  | "sensitive"
  /** An operating-system directory (Windows, /etc, /usr, /Library, ...). */
  | "system"
  /** Anywhere else outside the workspace. Reads are allowed; writes and deletes are blocked. */
  | "outside"
  /** The path could not be resolved (unexpanded environment variable, malformed input). */
  | "unknown";

export interface PathInfo {
  /** The path exactly as the agent wrote it (used to reconstruct rewritten commands). */
  raw: string;
  /** Canonical comparison key: forward slashes, drive letters uppercased, `/mnt/<d>` and `/d` mapped to `<D>:/`, dot segments collapsed, lowercased. */
  canonical: string;
  /** Same as canonical but with original case preserved (for display and trash filenames). */
  display: string;
  zone: PathZone;
}

export interface PathClassificationOptions {
  workspaceRoot: string;
  runtimeDirs?: readonly string[];
  tempDirs?: readonly string[];
  homeDir?: string;
}

const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".password-store",
  "appdata",
  "application support",
]);
const SENSITIVE_FILENAMES = /^(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.env|\.env\.local|credentials|\.netrc|\.htpasswd|\.pgpass|\.npmrc|\.pypirc|secrets?\.(json|ya?ml|toml|txt))$/i;
// Canonical keys are lowercased, so system roots are stored lowercased for comparison.
const SYSTEM_ROOTS = new Set([
  "/etc",
  "/usr",
  "/usr/local",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/srv",
  "/opt",
  "/system",
  "/windows",
  "/program files",
  "/program files (x86)",
  "/programdata",
  "/library",
  "/applications",
  "/volumes",
]);

/** Git Bash on Windows exposes virtual POSIX dirs (Git's own installation layout); single-letter dirs are drives. */
const GIT_BASH_VIRTUAL_ROOTS = new Set(["bin", "cmd", "dev", "etc", "home", "mingw64", "mnt", "opt", "proc", "root", "sbin", "srv", "tmp", "usr", "var"]);

/**
 * Canonicalize an absolute-or-relative path string into a comparison key.
 * Relative paths are resolved against `cwd` (which must itself be canonicalizable).
 * Returns `undefined` when the path cannot be resolved (e.g. an unexpanded variable).
 */
export function canonicalizePath(raw: string, cwd: string): string | undefined {
  return normalizePath(raw, cwd, true);
}

/**
 * Case-preserving absolute form of a path, for actual filesystem operations.
 * Accepts the same input styles as `canonicalizePath` (drive letters, /mnt, ~, quotes
 * stripped) but keeps the original case and does not fold segments.
 */
export function resolveAbsolutePath(raw: string, cwd: string): string | undefined {
  return normalizePath(raw, cwd, false);
}

function normalizePath(raw: string, cwd: string, fold: boolean): string | undefined {
  let p = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!p) return undefined;
  // Windows separators first; the rest of the pipeline works on forward slashes.
  p = p.replace(/\\/g, "/");
  // WSL mount: /mnt/<drive>/... -> <DRIVE>:/...
  const mnt = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  if (mnt) p = `${mnt[1]!.toUpperCase()}:/${mnt[2] ?? ""}`;
  // Git Bash drive form on Windows: /c/Users/... -> C:/Users/... (single-letter dirs are
  // drives; known virtual roots like /usr or /tmp stay POSIX).
  if (process.platform === "win32") {
    const gb = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
    if (gb && !GIT_BASH_VIRTUAL_ROOTS.has(gb[1]!.toLowerCase())) p = `${gb[1]!.toUpperCase()}:/${gb[2] ?? ""}`;
  }
  // Uppercase a leading drive letter: c:/... -> C:/...
  p = p.replace(/^([a-zA-Z]):(?=\/|$)/, (_match, drive: string) => `${drive.toUpperCase()}:`);

  if (p.startsWith("/")) {
    p = normalizeSegments(p, true);
  } else if (/^[A-Za-z]:\//.test(p)) {
    p = normalizeSegments(p, false);
  } else if (/^[A-Za-z]:$/.test(p)) {
    p = `${p.toUpperCase()}:/`;
  } else if (/^~(?:\/|$)/.test(p)) {
    const home = normalizePath(homedir(), cwd, fold);
    if (!home) return undefined;
    const rest = p.slice(1);
    p = rest ? `${home}/${rest.replace(/^\/+/, "")}` : home;
    return normalizePath(p, cwd, fold);
  } else {
    // Relative path: resolve against the canonical cwd.
    const base = normalizePath(cwd, cwd, fold);
    if (!base) return undefined;
    p = `${base}/${p.replace(/^\.\//, "")}`;
    p = normalizeSegments(p, false);
  }
  return fold ? p.toLowerCase() : p;
}

/** Collapse `.` and `..` segments. `rooted` keeps a leading `/` (POSIX absolute). */
function normalizeSegments(path: string, rooted: boolean): string {
  const drive = /^([A-Za-z]:)\/(.*)$/.exec(path);
  // A path that starts with `/` and has no drive letter is POSIX-absolute even when
  // built from a relative join against a POSIX base (e.g. `/tmp` + `x`), so keep the
  // leading slash — otherwise it would silently become relative and resolve elsewhere.
  const isRooted = rooted || (!drive && path.startsWith("/"));
  const prefix = isRooted ? "/" : drive ? `${drive[1]}/` : "";
  const rest = isRooted ? path : (drive?.[2] ?? path);
  const out: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  if (!joined) return prefix || (isRooted ? "/" : "");
  return `${prefix}${joined}`;
}

/** Case-preserving display form of a canonicalized path (for logs and trash filenames). */
export function displayPath(canonical: string): string {
  return canonical;
}

/** True when `child` is `parent` itself or lives under `parent/` (both canonical keys). */
export function isPathInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(`${parent.replace(/\/$/, "")}/`);
}

export function classifyPath(raw: string, options: PathClassificationOptions): PathInfo {
  const workspace = canonicalizePath(options.workspaceRoot, options.workspaceRoot) ?? "";
  const cwd = options.workspaceRoot;
  const canonical = canonicalizePath(raw, cwd);
  if (!canonical) {
    return { raw, canonical: raw.toLowerCase(), display: raw, zone: "unknown" };
  }
  const display = canonical; // lowercase key is fine for display of zones; raw holds the original text
  const home = canonicalizePath(options.homeDir ?? homedir(), cwd) ?? "";

  const zone = classifyZone(canonical, { workspace, home, ...options });
  return { raw, canonical, display, zone };
}

function classifyZone(
  canonical: string,
  options: PathClassificationOptions & { workspace: string; home: string },
): PathZone {
  // 1. Protected trash inside the workspace — the agent never touches this.
  if (options.workspace && isPathInside(options.workspace, canonical)) {
    const trashRoot = `${options.workspace.replace(/\/$/, "")}/.fitz-trash`;
    if (isPathInside(trashRoot, canonical)) return "protected";
    return "workspace";
  }
  // 2. Fitz runtime dirs the agent owns.
  for (const dir of options.runtimeDirs ?? []) {
    const key = canonicalizePath(dir, options.workspaceRoot);
    if (key && isPathInside(key, canonical)) return "runtime";
  }
  // 3. OS temp dirs.
  for (const dir of options.tempDirs ?? []) {
    const key = canonicalizePath(dir, options.workspaceRoot);
    if (key && isPathInside(key, canonical)) return "temp";
  }
  // 4. Secrets-bearing locations (only outside the workspace — inside the workspace the
  //    agent is allowed to work on the user's project files, and .git/snapshots cover it).
  if (isSensitivePath(canonical)) return "sensitive";
  // 5. Operating-system roots and drive roots.
  if (isSystemPath(canonical)) return "system";
  // 6. Drive root or anything else outside the workspace.
  if (isDriveRoot(canonical)) return "system";
  if (!options.workspace) return "outside";
  return "outside";
}

function isSensitivePath(canonical: string): boolean {
  const segments = canonical.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (!segment) continue;
    if (SENSITIVE_SEGMENTS.has(segment)) return true;
    if (i === segments.length - 1 && SENSITIVE_FILENAMES.test(segment)) return true;
  }
  return false;
}

function isSystemPath(canonical: string): boolean {
  const segments = canonical.split("/");
  // Drop a leading drive (C:) so "c:/windows" is checked as ["windows", ...].
  const first = segments[0]!;
  const rest = /^[a-z]:$/.test(first) ? segments.slice(1) : segments;
  const head = rest.find((segment) => segment.length > 0);
  return head !== undefined && SYSTEM_ROOTS.has(`/${head}`);
}

function isDriveRoot(canonical: string): boolean {
  return /^[a-z]:\/$/.test(canonical) || canonical === "/";
}

/** Original-case basename for trash filenames (the raw text, not the canonical key). */
export function rawBasename(raw: string): string {
  const cleaned = raw.replace(/[\\/]+$/, "");
  return basename(cleaned) || "item";
}

/** Quote a path for POSIX shell reconstruction (Git Bash on Windows accepts C:/... too). */
export function shellQuote(value: string): string {
  const v = value.replace(/\\/g, "/");
  if (/^[a-zA-Z0-9_\-./:=,]+$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
