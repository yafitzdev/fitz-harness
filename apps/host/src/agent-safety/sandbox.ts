/**
 * OS-level containment for the agent's bash tool.
 *
 * On Linux (including WSL2) every shell command runs inside a bubblewrap (bwrap)
 * sandbox: the whole filesystem is mounted read-only and only the project workspace,
 * the Fitz runtime dirs, and the temp dirs are re-bound read-write. Deletes and writes
 * outside those zones then fail at the kernel level (EROFS) no matter how the command
 * is constructed — the machine guarantee that backs the policy engine's rewrites/blocks.
 * SSH key dirs are shadowed with empty tmpfs mounts so credential reads fail too.
 *
 * Windows uses bubblewrap inside the existing Fitz-Inference WSL distribution.
 * A missing sandbox is an execution error; it must never enable an unrestricted
 * host shell. Windows interoperability is hidden inside the sandbox so a native
 * executable cannot bypass the Linux filesystem mounts.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { MANAGED_LINUX_DISTRIBUTION } from "../managed-linux-runtime.js";

export interface SandboxOptions {
  /** The agent's working directory / project workspace; the primary writable root in the sandbox. */
  workspace: string;
  /** Fitz-owned runtime dirs (pi agent dir, llm root, logs, cache, engines) — writable. */
  runtimeDirs: readonly string[];
  /** OS temp dir(s) — writable. */
  tempDirs: readonly string[];
  /** The user's home dir; its `.ssh` is shadowed inside the sandbox. */
  homeDir: string;
  /** Shell to run the command with. Defaults to a platform-appropriate bash. */
  shell?: string;
}

export interface SandboxPlan {
  /** Full argv to spawn (bwrap, through WSL on Windows). */
  argv: string[];
  /** Whether the command will actually run inside the OS-level container. */
  contained: boolean;
  /** The shell binary used. */
  shell: string;
}

export interface SandboxRunOptions extends SandboxOptions {
  command: string;
  /** Timeout in seconds (optional, no default timeout). */
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Whether bwrap is available; defaults to probing the host. Injectable for tests. */
  available?: boolean;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  contained: boolean;
}

/** Injectable spawn seam (tests substitute a fake; the SDK has an analogous spawnHook). */
export type SandboxSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

let bwrapAvailableCache: boolean | undefined;

/** Whether bubblewrap is installed and runnable on this host. Cached after the first probe. */
export function bwrapAvailable(): boolean {
  if (bwrapAvailableCache === true) return true;
  bwrapAvailableCache = process.platform === "win32"
    ? probeCommand("wsl.exe", ["--distribution", MANAGED_LINUX_DISTRIBUTION, "--exec", "bwrap", "--version"])
    : probeCommand("bwrap", ["--version"]);
  return bwrapAvailableCache;
}

function probeCommand(name: string, args: string[]): boolean {
  try {
    const result = spawnSync(name, args, { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/** Windows commands run in the managed Linux runtime, not Git Bash. */
export function resolveShell(): string {
  if (process.platform === "win32" || existsSync("/bin/bash")) return "/bin/bash";
  return process.env.SHELL || "bash";
}

/** Map host paths without rewriting shell source, where substitutions could
 * change quoting or the meaning of an embedded script. */
export function toSandboxPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const normalized = path.replaceAll("\\", "/");
  const drive = /^([a-z]):\/(.*)$/i.exec(normalized);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]}`;
  const wsl = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(normalized);
  if (wsl) {
    if (wsl[1]!.toLowerCase() !== MANAGED_LINUX_DISTRIBUTION.toLowerCase()) throw new Error(`Agent shell paths must belong to ${MANAGED_LINUX_DISTRIBUTION}`);
    return wsl[2] ?? "/";
  }
  if (normalized.startsWith("/") && !normalized.startsWith("//")) return normalized;
  throw new Error(`The agent sandbox requires an absolute local path: ${path}`);
}

function guestPathExists(path: string, windows: boolean): boolean {
  if (!windows) return existsSync(path);
  const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(path);
  return existsSync(drive ? `${drive[1]}:/${drive[2]}` : `\\\\wsl.localhost\\${MANAGED_LINUX_DISTRIBUTION}${path.replaceAll("/", "\\")}`);
}

function isRootLike(path: string): boolean {
  return path === "/" || /^[A-Za-z]:[\\/]?$/.test(path) || /^\/mnt\/[a-z]\/?$/i.test(path);
}

/** `--bind src src` pairs for the writable zones; root-like paths stay read-only. */
function writableBinds(dirs: readonly string[]): string[] {
  const binds: string[] = [];
  for (const dir of dirs) {
    if (!dir || isRootLike(dir)) continue;
    binds.push("--bind-try", dir, dir);
  }
  return binds;
}

/**
 * Assemble the containment argv for one shell command.
 * `available` is injectable; it defaults to probing the real host for bwrap.
 */
export function buildSandboxPlan(command: string, options: SandboxOptions, available: boolean = bwrapAvailable(), platform: NodeJS.Platform = process.platform): SandboxPlan {
  if (!available) {
    throw new Error(platform === "win32"
      ? `The agent shell requires bubblewrap in the ${MANAGED_LINUX_DISTRIBUTION} WSL runtime. Repair the runtime before retrying; no command was executed.`
      : "The agent shell requires a working bubblewrap installation. No command was executed.");
  }
  const windows = platform === "win32";
  const mapPath = (path: string) => toSandboxPath(path, platform);
  const workspace = mapPath(options.workspace);
  const homeDir = mapPath(options.homeDir);
  const shell = options.shell ?? (windows ? "/bin/bash" : resolveShell());
  const argv = [
    ...(windows ? ["wsl.exe", "--distribution", MANAGED_LINUX_DISTRIBUTION, "--exec"] : []), "bwrap",
    // Fresh namespaces: pid (the sandbox cannot signal host processes), ipc, uts;
    // the mount namespace is implicit in the bind setup. Networking is deliberately NOT
    // unshared — the agent needs to install packages and fetch remotes.
    "--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-uts",
    "--cap-drop", "ALL",
    // Tear the sandbox down if the host process dies, so no agent shell outlives it.
    "--die-with-parent",
    "--new-session",
    // Everything read-only first; writable zones are re-bound below (later binds win).
    "--ro-bind", "/", "/",
    // These mounts must follow the root bind, otherwise it hides them again.
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...writableBinds([workspace, ...options.runtimeDirs.map(mapPath), ...options.tempDirs.map(mapPath)]),
    // Hide host IPC and WSL's Windows executable bridge. Merely removing
    // WSL_INTEROP is insufficient because /init can discover another socket.
    "--tmpfs", "/run",
    ...((windows || existsSync("/init")) ? ["--ro-bind", "/dev/null", "/init"] : []),
    "--unsetenv", "WSL_INTEROP",
    "--setenv", "FITZ_CONTAINED", "1",
    ...(windows ? ["--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "--setenv", "HOME", homeDir] : []),
    // Shadow ssh keys: reads inside the sandbox see an empty dir instead of host keys.
    // The path must stay POSIX (forward slashes) even when building on a Windows host.
    ...(guestPathExists(`${homeDir.replace(/[\\/]+$/, "")}/.ssh`, windows) ? ["--tmpfs", `${homeDir.replace(/[\\/]+$/, "")}/.ssh`] : []),
    ...(guestPathExists("/etc/ssh", windows) ? ["--tmpfs", "/etc/ssh"] : []),
    "--chdir", workspace,
    shell, "-c", command,
  ];
  return { argv, contained: true, shell };
}

/** Hard cap on captured output per stream (memory bound for runaway output). */
const CAPTURE_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Run one shell command through the containment wrapper and capture its output.
 * Rejects with `Error("aborted")` on abort and `Error("timeout:<seconds>")` on timeout,
 * matching the SDK's bash tool error contract (the sandboxed-bash tool formats both).
 */
export async function runSandboxed(options: SandboxRunOptions, spawnFn: SandboxSpawn = spawn): Promise<SandboxRunResult> {
  if (options.signal?.aborted) throw new Error("aborted");
  const plan = buildSandboxPlan(options.command, options, options.available);
  const env = { ...process.env, ...(options.env ?? {}), ...(plan.contained ? { FITZ_CONTAINED: "1" } : {}) };
  const child = spawnFn(plan.argv[0]!, plan.argv.slice(1), {
    cwd: options.workspace,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await new Promise<SandboxRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const kill = () => {
      if (child.pid) killProcessTree(child.pid);
    };
    const onAbort = () => {
      kill();
      settle(() => reject(new Error("aborted")));
    };
    if (options.timeout !== undefined) {
      timeoutHandle = setTimeout(() => {
        kill();
        settle(() => reject(new Error(`timeout:${options.timeout}`)));
      }, options.timeout * 1000);
    }
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stream === "stdout") stdout = (stdout + text).slice(-CAPTURE_CAP_BYTES);
      else stderr = (stderr + text).slice(-CAPTURE_CAP_BYTES);
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    child.on("error", (error) => settle(() => reject(error)));
    // 'close' fires after stdio streams have flushed, so stdout/stderr are complete.
    child.on("close", (code) => settle(() => resolve({ exitCode: code ?? 1, stdout, stderr, contained: plan.contained })));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Kill a process and its whole tree (taskkill on Windows, process group on Unix). */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => undefined);
    } catch {
      // Best effort: if taskkill is unavailable the process tree stays, but nothing else we can do.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
